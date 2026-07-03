// gate.ts — recall-precision gate (ollama qwen2.5:3b).
//
// Public surface (task 2.1, completed):
//   - GateDecision  : shape of gate output ({need_memory, search_query}).
//   - GateOptions   : caller-tunable knobs (url / model / timeoutMs).
//   - callGate      : placeholder; body filled in tasks 2.2 (buildGatePrompt)
//                     and 2.3 (fetch + parse + timeout).
//
// Body intentionally returns null at this step. The null path is what
// scenarios S5 / S6 / S7 in scenarios.md fall through to: any failure
// of the gate (parse, timeout, ECONNREFUSED) silently degrades to
// "skip recall" so the context hook in memory.ts can route to the
// ⚠ / 🚫 status without surfacing an exception.
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

// Placeholder. With no body, callGate has no information to act on,
// so the only contract-correct answer is null. Tasks 2.2 (prompt)
// and 2.3 (fetch + parse + retry on strip) replace this body.
export async function callGate(
	prompt: string,
	recentUserMsgs: string[],
	options: GateOptions = {},
): Promise<GateDecision | null> {
	// Body filled in tasks 2.2 (buildGatePrompt) and 2.3 (fetch + JSON.parse + AbortController).
	void prompt;
	void recentUserMsgs;
	void options;
	return null;
}
