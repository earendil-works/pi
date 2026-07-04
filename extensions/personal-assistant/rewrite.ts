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
export const DEFAULT_TIMEOUT_MS = 5000;
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
	"输出 JSON 含 subqueries (string数组). " +
	"格式:{\"subqueries\":[\"概念1\",\"概念2\"]}. " +
	"指代: 指代词换成具体名词. " +
	"拆分: 多概念拆成2-3个独立子查询. " +
	"单概念: 原样保留为一个子查询. " +
	"去重: 不重复不生造.";

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
 * Try to parse a raw LLM response string into a non-empty array of
 * subqueries. Returns "parse" if parsing or validation fails.
 *
 * First attempts direct JSON.parse. If that fails, strips leading
 * non-JSON text via regex /(\{[\s\S]*\})/ and retries.
 *
 * Validation rules (after successful parse):
 *   - `parsed.subqueries` must be an Array of strings
 *   - length must be >= 1 (empty array → "parse")
 *   - duplicates are removed via Set (order preserved)
 *   - if length > maxSubqueries, truncated with console.debug log
 *
 * On any failure, the raw input's first 200 chars are logged via
 * console.warn and "parse" is returned so the caller degrades to
 * a fallback.
 */
function parseRewriteResponse(raw: string, maxSubqueries: number): string[] | "parse" {
	const stripped = raw.trim();
	if (stripped.length === 0) {
		console.warn("[rewrite] empty response from LLM");
		return "parse";
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped);
	} catch {
		const match = stripped.match(/(\{[\s\S]*\})/);
		if (!match) {
			console.warn("[rewrite] parse failed, raw:", stripped.slice(0, 200));
			return "parse";
		}
		try {
			parsed = JSON.parse(match[1]);
		} catch {
			console.warn("[rewrite] parse failed after retry, raw:", stripped.slice(0, 200));
			return "parse";
		}
	}

	const obj = parsed as Record<string, unknown>;
	if (!Array.isArray(obj.subqueries)) {
		console.warn("[rewrite] schema invalid (subqueries not array), raw:", stripped.slice(0, 200));
		return "parse";
	}

	if (obj.subqueries.length === 0) {
		console.warn("[rewrite] empty subqueries array");
		return "parse";
	}

	if (!obj.subqueries.every((s: unknown) => typeof s === "string")) {
		console.warn("[rewrite] schema invalid (non-string element), raw:", stripped.slice(0, 200));
		return "parse";
	}

	// Dedup preserving insertion order.
	const subqueries: string[] = [...new Set(obj.subqueries)];

	// Truncate to at most maxSubqueries.
	if (subqueries.length > maxSubqueries) {
		console.debug(`[rewrite] truncated ${subqueries.length}→${maxSubqueries}`);
		return subqueries.slice(0, maxSubqueries);
	}

	return subqueries;
}

/**
 * Decompose a user query into multiple sub-queries for parallel search.
 *
 * Calls the configured ollama LLM with the prompt from
 * `buildRewritePrompt`, parses the JSON response via
 * `parseRewriteResponse`, and returns the subquery array on success or a
 * `RewriteFallback` describing the failure reason on error — the caller
 * discriminates with `Array.isArray(result)`.
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
	const ollamaUrl = options?.ollamaUrl ?? DEFAULT_OLLAMA_URL;
	const model = options?.model ?? DEFAULT_MODEL;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxSubqueries = options?.maxSubqueries ?? DEFAULT_MAX_SUBQUERIES;
	const messages = buildRewritePrompt(query, recent ?? null);

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
		const msg = (body as Record<string, unknown>)?.message as
			| Record<string, unknown>
			| undefined;
		rawContent = typeof msg?.content === "string" ? msg.content : "";
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			return { reason: "timeout", subqueries: [query] };
		}
		return { reason: "unreachable", subqueries: [query] };
	}

	const result = parseRewriteResponse(rawContent, maxSubqueries);
	if (result === "parse") {
		return { reason: "parse", subqueries: [query] };
	}
	return result;
}
