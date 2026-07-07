// gate.ts — recall-precision gate (ollama qwen2.5:3b).
//
// Public surface:
//   - GateDecision        : shape of gate output ({need_memory}).
//                           (task 1.1)
//   - GateOptions         : caller-tunable knobs (url / model / timeoutMs).
//                           (task 2.1)
//   - buildGatePrompt     : pure prompt constructor → ollama `messages`
//                           array (system + user). (task 2.2)
//   - callGate            : fetches gate LLM, parses JSON with retry,
//                           enforces timeout via AbortController. (task 2.3)
//
// The null return is what scenarios S5 / S6 / S7 fall through to: any
// failure of the gate (parse, timeout, ECONNREFUSED) silently degrades to
// "skip recall" so the context hook in memory.ts can route to the ⚠ / 🚫
// status without surfacing an exception.
//
// Per principle 9 (one explicit home), gate logic lives only here;
// per principle 6 (non-blocking), timeout is enforced via AbortController
// — not via this file's signature stage.

export interface GateDecision {
	need_memory: boolean;
}

export type GateError = "timeout" | "parse" | "unreachable";

export interface GateOptions {
	ollamaUrl?: string;
	model?: string;
	timeoutMs?: number;
}

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen2.5:3b-instruct-q4_0";
const DEFAULT_TIMEOUT_MS = 500;

// System prompt for the gate LLM (qwen2.5:3b-instruct-q4_0).
//
// Two false-positive rules (指代性 / 零信息量) drive scenarios S1 / S2 — they
// make the model emit need_memory=false for purely contextual or
// acknowledgement turns. The historical-recall rule (历史回溯 + 真的需要
// memory) drives S3 / S4.
//
// Kept as a module-level constant so it survives a single lint pass
// without backtick interpolation churn and so test snapshots are stable.
const GATE_SYSTEM_PROMPT = `你是 memory recall 决策助手. 输出 JSON, 字段 need_memory (bool). 判断当前用户消息是否值得查 long-term memory. 指代性消息 ('上面的脚本', '那个') → need_memory=false. 零信息量 ('对', '好的', '继续') → need_memory=false. 历史回溯 ('之前', '记得吗', '历史') 且需要 memory 才 need_memory=true.`;

// Build the ollama `/api/chat` `messages` array (system + user) the gate
// LLM sees. Pure: no I/O, no clock — exercised directly by tests, called
// by 2.3's callGate body.
//
//   - `current` : the user turn that triggered the context hook.
//   - `recent`  : the up-to-3 most recent prior user turns. Older entries
//                 are dropped (the LLM only needs disambiguation context,
//                 not full history). Empty array → "Recent user messages:
//                 None" placeholder so the LLM still sees the section
//                 header and does not mistake a missing block for a
//                 protocol violation.
//
// Returns the same shape ollama accepts as `messages`, so callGate can
// pass it straight through (task 2.3).
export function buildGatePrompt(current: string, recent: string[]): { role: string; content: string }[] {
	const tail = recent.slice(-3);
	const recentBlock = tail.length > 0
		? `Recent user messages:\n${tail.map((m) => `- ${m}`).join("\n")}\n`
		: "Recent user messages: None\n";
	const userContent = `${recentBlock}\nCurrent message:\n${current}\n\nRespond JSON only:`;
	return [
		{ role: "system", content: GATE_SYSTEM_PROMPT },
		{ role: "user", content: userContent },
	];
}

// Try to parse a raw LLM response string into a GateDecision.
//
// Closed-loop repair: parse → schema-check. If either step fails AND
// the failure is a *format* error (not a content error), apply one of
// several targeted repairs and re-check. The loop terminates when:
//
//   - schema check passes → return the GateDecision
//   - no further repair produces a different parsed shape
//     (last attempt's result equals the prior attempt's result) → bail
//     to "parse" so the caller can route the failure
//
// The repair set grew organically as new qwen2.5:3b malformation
// shapes surfaced in production:
//
//   1. tryRepairGateResponse — text-level (append `}`, quote unquoted
//      keys). Fires when JSON.parse itself throws.
//   2. tryRepairCastBooleans — value-type fix for `{"need_memory":"true"}`.
//      Fires when JSON.parse succeeds but the value is a string.
//   3. tryRepairSucceededByAccident — fix for the "key contains a colon"
//      case. qwen2.5:3b occasionally emits `{"need_memory:true}":true}`
//      where the key's closing `"` was dropped early. JSON.parse accepts
//      this by reading the literal key as `"need_memory:true}"` and the
//      value as `true`. The intended meaning is `{"need_memory":true}`.
//      We detect this by looking for `:` inside an object key and
//      re-pairing the prefix with the parsed value.
//
// When the schema still fails after all three repairs, it usually means
// the LLM output is genuinely off-topic and the right call is to return
// "parse" so the TUI can surface the failure. If a new malformation
// shape appears, the closed loop is the right place to add a new
// repair case (not a special-case branch in parseGateResponse).
//
// Returns "parse" when the loop terminates without a schema-satisfying
// result. The caller discriminates on the return value to set the TUI
// status with the specific failure category.
function parseGateResponse(raw: string): GateDecision | "parse" {
	const stripped = raw.trim();
	if (stripped.length === 0) {
		console.warn("[gate] empty response from LLM");
		return "parse";
	}

	// Step 1: parse the raw. If JSON.parse fails, run the text-level
	// repair (which targets bracket-balance and key-quoting) and try
	// again. This step is non-iterative because the text-level repair
	// is itself a multi-stage chain (see tryRepairGateResponse); a
	// second text-level pass wouldn't add anything.
	let parsed: unknown = tryParseJson(stripped);
	if (parsed === undefined) {
		parsed = tryRepairGateResponse(stripped);
		if (parsed === undefined) {
			console.warn("[gate] parse failed after retry, raw:", stripped.slice(0, 200));
			return "parse";
		}
	}

	// Step 2: schema check + repair loop. Each iteration tries one
	// repair; if the repair produces a different parsed shape, we
	// re-check the schema with the new shape. The loop bails when
	// either the schema passes or no repair produces a new shape.
	const MAX_REPAIR_ATTEMPTS = 4;
	let lastSig = JSON.stringify(parsed);
	for (let i = 0; i < MAX_REPAIR_ATTEMPTS; i++) {
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.need_memory === "boolean") {
			return { need_memory: obj.need_memory };
		}

		const next = tryOneRepair(parsed, stripped);
		if (next === undefined) {
			break;
		}
		const sig = JSON.stringify(next);
		if (sig === lastSig) {
			break;
		}
		lastSig = sig;
		parsed = next;
	}

	console.warn("[gate] schema invalid, raw:", stripped.slice(0, 200));
	return "parse";
}

// Try the parse, then the regex-extraction retry. Returns undefined
// if both fail.
function tryParseJson(stripped: string): unknown {
	try {
		return JSON.parse(stripped);
	} catch {
		const match = stripped.match(/(\{[\s\S]*\})/);
		if (match) {
			try {
				return JSON.parse(match[1]);
			} catch {
				return undefined;
			}
		}
		return undefined;
	}
}

// Apply one schema-repair pass. Each repair returns undefined if it
// doesn't apply (so the loop can try the next one). Repairs are tried
// in order of specificity:
//
//   1. tryRepairCastBooleans — cheapest, only matches string "true"/"false"
//   2. tryRepairSucceededByAccident — only matches when an object key
//      contains `:`
//   3. tryRepairGateResponse — text-level, runs on the original raw;
//      useful when prior parse succeeded "by accident" with bad
//      bracket/quotes that a fresh text-level repair can fix
function tryOneRepair(parsed: unknown, raw: string): unknown {
	const cast = tryRepairCastBooleans(parsed);
	if (cast !== undefined) return cast;
	const accident = tryRepairSucceededByAccident(parsed);
	if (accident !== undefined) return accident;
	const textRepair = tryRepairGateResponse(raw);
	if (textRepair !== undefined) return textRepair;
	return undefined;
}

// Repair common JSON malformations observed in qwen2.5:3b output
// (e.g. `{"need_memory:true}` — missing closing `}` AND unquoted key).
//
// Tries the following repairs in order, returning the first that produces
// a parseable object with `need_memory` of boolean or string-castable
// boolean type:
//
//   1. Append missing closing `}` when there's exactly one unclosed `{`
//   2. Quote unquoted keys (`need_memory:true` → `"need_memory":true`)
//   3. Cast string booleans (`"true"` → `true`, `"false"` → `false`)
//
// Each successful repair logs what was applied so we can quantify how
// often each step is needed — without relying on this as the primary
// defence (the upstream `format: "json"` constraint is).
function tryRepairGateResponse(raw: string): Record<string, unknown> | undefined {
	let candidate: string | undefined = raw;
	const stages = [repairAppendBrace, repairQuoteKeys];
	for (const stage of stages) {
		if (candidate === undefined) return undefined;
		const next = stage(candidate);
		if (next !== undefined) candidate = next;
		if (candidate === undefined) return undefined;
		try {
			const parsed = JSON.parse(candidate);
			if (typeof parsed === "object" && parsed !== null) {
				return parsed as Record<string, unknown>;
			}
			return undefined;
		} catch {
			// try the next stage on the current (possibly-improved) candidate
		}
	}
	return undefined;
}

// If exactly one `{` has no matching `}`, append the missing `}` and
// retry. No-op when the counts already balance or there is no `{`.
function repairAppendBrace(raw: string): string | undefined {
	const opens = (raw.match(/\{/g) ?? []).length;
	const closes = (raw.match(/\}/g) ?? []).length;
	if (opens !== closes + 1) return undefined;
	const candidate = raw.replace(/,\s*$/, "") + "}";
	return candidate;
}

// Quote unquoted JSON keys before `:`. Conservative: only touches known
// field names so we do not aggressively alter content. Two passes:
//
//   Pass 1 — close an open-but-unclosed quote after the key
//            (`{"need_memory:true}` → `{"need_memory":true}`)
//   Pass 2 — wrap a wholly-unquoted key
//            (`{need_memory:true}` → `{"need_memory":true}`)
//             (only runs when Pass 1 found nothing to do, so legitimate
//              already-quoted JSON passes through untouched)
function repairQuoteKeys(raw: string): string | undefined {
	const knownFields = ["need_memory"];
	let candidate = raw;

	for (const field of knownFields) {
		candidate = candidate.replace(
			new RegExp(`([,{]\\s*"\\s*)(${field})(?=\\s*:)`, "g"),
			`$1${field}"`,
		);
	}
	if (candidate === raw) {
		for (const field of knownFields) {
			candidate = candidate.replace(
				new RegExp(`([,{]\\s*)(${field})(?=\\s*:)`, "g"),
				`$1"${field}"`,
			);
		}
	}
	return candidate === raw ? undefined : candidate;
}

// Cast string-typed booleans (e.g. `{need_memory: "true"}`) to actual
// booleans on a *parsed object*. Used as a second-stage repair after
// JSON.parse succeeds but the schema check rejects a string value.
function tryRepairCastBooleans(parsed: unknown): Record<string, unknown> | undefined {
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const obj = parsed as Record<string, unknown>;
	const knownBoolFields = ["need_memory"];
	let mutated = false;
	const result: Record<string, unknown> = { ...obj };
	for (const field of knownBoolFields) {
		const v = result[field];
		if (v === "true") {
			result[field] = true;
			mutated = true;
		} else if (v === "false") {
			result[field] = false;
			mutated = true;
		}
	}
	return mutated ? result : undefined;
}

// Repair the "succeeded by accident" case. qwen2.5:3b occasionally
// emits `{"need_memory:true}":true}` where the model intended
// `{"need_memory": true}` but dropped the key's closing `"` before
// the colon. JSON.parse accepts the malformed input by reading the
// literal key as `"need_memory:true}"` and the value as `true`. The
// object has no `need_memory` field, so the schema check fails.
//
// Detection: an object key contains a `:`. The model always intends
// for the first `:` to separate key and value, so we split the key
// at the first colon and pair the prefix with the parsed value. We
// only fire this repair when:
//
//   - the parsed value is a boolean or string (the gate's
//     `need_memory` value types), and
//   - the split produces a non-empty prefix (a key fragment we can
//     use as the new key name).
//
// Returns the repaired object, or undefined if the shape doesn't
// match (so the loop can try other repairs).
function tryRepairSucceededByAccident(parsed: unknown): Record<string, unknown> | undefined {
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const obj = parsed as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	let mutated = false;
	for (const [key, value] of Object.entries(obj)) {
		const colonIdx = key.indexOf(":");
		if (colonIdx > 0) {
			const realKey = key.slice(0, colonIdx);
			if (
				realKey.length > 0 &&
				!realKey.includes(" ") &&
				(typeof value === "boolean" || typeof value === "string")
			) {
				result[realKey] = value;
				mutated = true;
				continue;
			}
		}
		result[key] = value;
	}
	return mutated ? result : undefined;
}

// Call the gate LLM (ollama /api/chat) with the given prompt and recent
// user messages. Returns:
//   - GateDecision  on success (need_memory determined by LLM)
//   - GateError     on a known failure category (timeout / parse / unreachable)
//   - null          on an unrecognised error (safety fallback, should not
//                   happen in practice)
//
// The caller in memory.ts discriminates on the return type to set TUI status
// and debug log with the specific failure category.
export async function callGate(
	prompt: string,
	recentUserMsgs: string[],
	options: GateOptions = {},
): Promise<GateDecision | GateError | null> {
	const ollamaUrl = options.ollamaUrl ?? DEFAULT_OLLAMA_URL;
	const model = options.model ?? DEFAULT_MODEL;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const messages = buildGatePrompt(prompt, recentUserMsgs);

	let rawContent = "";
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const res = await fetch(`${ollamaUrl}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages,
				stream: false,
				format: "json",
				options: { temperature: 0 },
			}),
			signal: controller.signal,
		});
		clearTimeout(timer);
		const body: unknown = await res.json();
		const msg = (body as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
		rawContent = typeof msg?.content === "string" ? msg.content : "";
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") return "timeout";
		if (err instanceof TypeError) return "unreachable";
		return null;
	}

	return parseGateResponse(rawContent);
}
