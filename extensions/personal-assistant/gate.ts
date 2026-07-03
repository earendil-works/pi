// gate.ts — recall-precision gate (ollama qwen2.5:3b).
//
// Public surface:
//   - GateDecision        : shape of gate output ({need_memory, search_query}).
//                           (task 2.1)
//   - GateOptions         : caller-tunable knobs (url / model / timeoutMs).
//                           (task 2.1)
//   - buildGatePrompt     : pure prompt constructor → ollama `messages`
//                           array (system + user). (task 2.2)
//   - callGate            : placeholder body; 2.3 fills fetch + JSON.parse
//                           + AbortController.
//
// The null return on the placeholder callGate is what scenarios S5 / S6 /
// S7 fall through to: any failure of the gate (parse, timeout,
// ECONNREFUSED) silently degrades to "skip recall" so the context hook in
// memory.ts can route to the ⚠ / 🚫 status without surfacing an exception.
//
// Per principle 9 (one explicit home), gate logic lives only here;
// per principle 6 (non-blocking), timeout is enforced in 2.3 via
// AbortController — not via this file's signature stage.

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

// Placeholder. With no body, callGate has no information to act on,
// so the only contract-correct answer is null. Task 2.3 (fetch +
// JSON.parse + AbortController) replaces this body. Until then, buildGatePrompt
// is exported but unused inside callGate — this is intentional, not a
// dead export: task 2.3 will wire it in.
export async function callGate(
	prompt: string,
	recentUserMsgs: string[],
	options: GateOptions = {},
): Promise<GateDecision | null> {
	// Body filled in task 2.3 (fetch + JSON.parse + AbortController).
	void prompt;
	void recentUserMsgs;
	void options;
	return null;
}
