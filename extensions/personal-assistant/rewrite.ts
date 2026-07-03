// ---------------------------------------------------------------------------
// Rewrite — query decomposition via local LLM (task 3.1 skeleton).
//
// This module owns the HTTP client for Ollama's completion API and the
// JSON parsing that converts a single query into multiple sub-queries for
// parallel hybrid-search calls.
//
// The body of `rewriteQueries` is intentionally a placeholder returning
// `[]` at this stage. Tasks 3.2-3.5 fill it in:
//
//   3.2 — REWRITE_SYSTEM_PROMPT + buildRewritePrompt (system+user with recent context)
//   3.3 — fetch with timeout + parse + RewriteFallback on failures
//   3.4 — response JSON parsing and validation
//   3.5 — subquery count cap (maxSubqueries) + dedup
//
// Principle 9 (single home): this is the only module in the extension
// that talks to the LLM for query rewriting. Callers (memory.ts / search.ts)
// consume the union return and discriminate on `Array.isArray`.
// ---------------------------------------------------------------------------

/** Options for the rewrite call. Every field is optional. */
export interface RewriteOptions {
	/** Ollama server base URL. Default: `http://127.0.0.1:11434`. */
	ollamaUrl?: string;
	/** Model name for query decomposition. Default: `qwen2.5:3b-instruct-q4_0`. */
	model?: string;
	/** Per-call timeout in ms. Default: 1500. */
	timeoutMs?: number;
	/** Maximum number of subqueries. Default: 3. */
	maxSubqueries?: number;
}

/** Failure categories emitted by the rewrite client. */
export type RewriteError = "timeout" | "parse" | "unreachable";

/**
 * Returned by `rewriteQueries` when the LLM call fails. `subqueries`
 * contains `[rawQuery]` as a degraded single-element array so the caller
 * can still search the original query rather than producing nothing.
 */
export interface RewriteFallback {
	reason: RewriteError;
	subqueries: string[];
}

/**
 * Returns `string[]` on success or `RewriteFallback` on failure.
 * The caller discriminates with `Array.isArray(result)`.
 */
export type RewriteOutcome = string[] | RewriteFallback;

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_MODEL = "qwen2.5:3b-instruct-q4_0";
export const DEFAULT_TIMEOUT_MS = 1500;
export const DEFAULT_MAX_SUBQUERIES = 3;

// System prompt for the rewrite LLM (qwen2.5:3b-instruct-q4_0).
//
// 5 rules, each <= 30 chars, tailored for 3b attention constraints:
//   1. 输出格式 — JSON {subqueries: string[]} 1-3 条
//   2. 指代消解 — 把指代换成具体概念
//   3. 复合拆分 — 多意图拆成独立子查询
//   4. 单概念保留 — 单一概念原样保留
//   5. 去重不生造 — 不重复不生造无关内容
export const REWRITE_SYSTEM_PROMPT =
	"你是 query 改写助手. " +
	"输出格式: JSON subqueries 1-3 条. " +
	"指代消解: 替换指代词为具体概念. " +
	"复合拆分: 多意图拆成独立子查询. " +
	"单概念保留: 单一概念原样保留. " +
	"去重不生造: 不重复不生造无关内容.";

/**
 * Build the ollama `/api/chat` `messages` array (system + user) for the
 * rewrite LLM. Pure: no I/O, no clock.
 *
 * @param query  The user's original query.
 * @param recent Optional recent user messages for disambiguation context.
 *               null or empty → "Recent user messages: None" placeholder.
 */
export function buildRewritePrompt(
	query: string,
	recent: string[] | null,
): { role: string; content: string }[] {
	const recentBlock =
		recent != null && recent.length > 0
			? `Recent user messages:\n${recent.map((m) => `- ${m}`).join("\n")}\n`
			: "Recent user messages: None\n";
	const userContent = `${recentBlock}\nCurrent message:\n${query}\n\nRespond JSON only:`;
	return [
		{ role: "system", content: REWRITE_SYSTEM_PROMPT },
		{ role: "user", content: userContent },
	];
}

/**
 * Decompose a user query into multiple sub-queries for parallel search.
 *
 * Skeleton: returns `[]` (a valid `string[]`) for all inputs.
 * Real implementation in tasks 3.2-3.5.
 *
 * @param query   The user's original query.
 * @param recent  Optional recent user messages for context.
 * @param options Optional overrides for ollamaUrl / model / timeoutMs / maxSubqueries.
 */
export async function rewriteQueries(
	query: string,
	recent?: string[] | null,
	options?: RewriteOptions,
): Promise<RewriteOutcome> {
	void recent;
	void options;
	return [];
}
