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
// First attempts direct JSON.parse. If that fails, strips leading
// non-JSON text via regex /(\{[\s\S]*\})/ and retries.
//
// If both attempts fail — typically because qwen2.5:3b dropped the
// closing `}` or forgot to quote a key like `need_memory:true` instead of
// `"need_memory":true` — tries a sequence of surgical repairs (append
// missing `}`, quote unquoted keys, cast string booleans). Each repair
// attempt is logged so we can see what shape the LLM actually produced.
//
// Returns "parse" if every attempt fails or the schema still doesn't
// match after repair; the caller discriminates on the return value to
// set TUI status with the specific failure category.
function parseGateResponse(raw: string): GateDecision | "parse" {
	const stripped = raw.trim();
	if (stripped.length === 0) {
		console.warn("[gate] empty response from LLM");
		return "parse";
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped);
	} catch {
		const match = stripped.match(/(\{[\s\S]*\})/);
		if (match) {
			try {
				parsed = JSON.parse(match[1]);
			} catch {
				parsed = undefined;
			}
		} else {
			parsed = undefined;
		}
	}

	if (parsed === undefined) {
		const repaired = tryRepairGateResponse(stripped);
		if (repaired !== undefined) {
			parsed = repaired;
		} else {
			console.warn("[gate] parse failed after retry, raw:", stripped.slice(0, 200));
			return "parse";
		}
	}

	let obj = parsed as Record<string, unknown>;
	if (typeof obj.need_memory !== "boolean") {
		// JSON parsed successfully but the schema doesn't fit — try one
		// more pass to cast string-typed booleans, then re-check. If still
		// invalid the call is genuinely a malformed response and we return
		// "parse" so the caller routes to the TUI parse-fail status.
		const cast = tryRepairCastBooleans(parsed);
		if (cast !== undefined) {
			obj = cast;
		}
	}
	if (typeof obj.need_memory !== "boolean") {
		console.warn("[gate] schema invalid, raw:", stripped.slice(0, 200));
		return "parse";
	}

	return { need_memory: obj.need_memory };
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
