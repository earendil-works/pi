// gate.ts — recall-precision gate (ollama qwen2.5:3b).
//
// Public surface:
//   - GateDecision        : shape of gate output ({need_memory, search_query}).
//                           (task 2.1)
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
	search_query: string;
}

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
// memory) drives S3 / S4 and pairs with the keyword-only search_query
// instruction to keep retrieved queries free of 那个 / 上面的.
//
// Kept as a module-level constant so it survives a single lint pass
// without backtick interpolation churn and so test snapshots are stable.
const GATE_SYSTEM_PROMPT = `你是 memory recall 决策助手. 输出 JSON, 字段 need_memory (bool) 和 search_query (string). 判断当前用户消息是否值得查 long-term memory. 指代性消息 ('上面的脚本', '那个') → need_memory=false. 零信息量 ('对', '好的', '继续') → need_memory=false. 历史回溯 ('之前', '记得吗', '历史') 且需要 memory 才 need_memory=true; search_query 用关键词提取, 不含指代词.`;

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
// non-JSON text via regex /(\{[\s\S]*\})/ and retries. Returns null
// if both attempts fail or the result doesn't match the schema.
function parseGateResponse(raw: string): GateDecision | null {
	const stripped = raw.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped);
	} catch {
		const match = stripped.match(/(\{[\s\S]*\})/);
		if (!match) return null;
		try {
			parsed = JSON.parse(match[1]);
		} catch {
			console.warn("[gate] parse failed after retry, raw:", stripped.slice(0, 200));
			return null;
		}
	}

	const obj = parsed as Record<string, unknown>;
	if (typeof obj.need_memory !== "boolean" || typeof obj.search_query !== "string") {
		console.warn("[gate] schema invalid, raw:", stripped.slice(0, 200));
		return null;
	}

	return { need_memory: obj.need_memory, search_query: obj.search_query };
}

// Call the gate LLM (ollama /api/chat) with the given prompt and recent
// user messages. Returns a GateDecision on success, or null on any failure
// (fetch rejection, timeout, parse error, schema validation).
//
// The null return is a deliberate degradation path — the caller in
// memory.ts treats null as "skip recall" and surfaces a ⚠/🚫 status
// without propagating an exception.
export async function callGate(
	prompt: string,
	recentUserMsgs: string[],
	options: GateOptions = {},
): Promise<GateDecision | null> {
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
				options: { temperature: 0 },
			}),
			signal: controller.signal,
		});
		clearTimeout(timer);
		const body: unknown = await res.json();
		const msg = (body as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
		rawContent = typeof msg?.content === "string" ? msg.content : "";
	} catch {
		return null;
	}

	return parseGateResponse(rawContent);
}
