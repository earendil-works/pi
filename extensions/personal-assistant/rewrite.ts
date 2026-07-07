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
 * Closed-loop repair: parse → schema-check. If the schema check
 * fails for a *format* reason, try one of several targeted repairs
 * and re-check. The loop terminates when either the schema passes
 * or no repair produces a different parsed shape.
 *
 * The repair set mirrors gate.ts:
 *   1. tryRepairRewriteResponse — text-level (append `}`, quote
 *      unquoted keys). Fires when JSON.parse itself throws.
 *   2. tryRepairRewriteSucceededByAccident — handles the "succeeded
 *      by accident" case where the model emits
 *      `{"subqueries:[...]":...}` (key contains `:`), parseable but
 *      with a key that swallowed the value.
 *
 * Validation rules (after successful parse + schema check):
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

	// Step 1: parse. If JSON.parse fails, run text-level repair and retry.
	let parsed: unknown = tryParseRewriteJson(stripped);
	if (parsed === undefined) {
		parsed = tryRepairRewriteResponse(stripped);
		if (parsed === undefined) {
			console.warn("[rewrite] parse failed, raw:", stripped.slice(0, 200));
			return "parse";
		}
	}

	// Step 2: schema check + repair loop.
	const MAX_REPAIR_ATTEMPTS = 4;
	let lastSig = JSON.stringify(parsed);
	for (let i = 0; i < MAX_REPAIR_ATTEMPTS; i++) {
		const obj = parsed as Record<string, unknown>;
		if (Array.isArray(obj.subqueries) && obj.subqueries.length > 0) {
			// Validate element types. (Validation stays in the loop so a
			// repair can produce a cleaner value type — e.g. casting
			// a single-string array to a string array.)
			const arr = obj.subqueries as unknown[];
			if (arr.every((s: unknown) => typeof s === "string")) {
				// Dedup preserving insertion order.
				const subqueries: string[] = [...new Set(arr as string[])];
				// Truncate to at most maxSubqueries.
				if (subqueries.length > maxSubqueries) {
					console.debug(`[rewrite] truncated ${subqueries.length}→${maxSubqueries}`);
					return subqueries.slice(0, maxSubqueries);
				}
				return subqueries;
			}
		}

		// Schema fail. Try one repair.
		const next = tryOneRewriteRepair(parsed, stripped);
		if (next === undefined) break;
		const sig = JSON.stringify(next);
		if (sig === lastSig) break;
		lastSig = sig;
		parsed = next;
	}

	// Determine the most informative log message.
	const obj = parsed as Record<string, unknown>;
	if (!Array.isArray(obj.subqueries)) {
		console.warn("[rewrite] schema invalid (subqueries not array), raw:", stripped.slice(0, 200));
	} else if (obj.subqueries.length === 0) {
		console.warn("[rewrite] empty subqueries array");
	} else {
		console.warn("[rewrite] schema invalid (non-string element), raw:", stripped.slice(0, 200));
	}
	return "parse";
}

function tryParseRewriteJson(stripped: string): unknown {
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

function tryOneRewriteRepair(parsed: unknown, raw: string): unknown {
	const accident = tryRepairRewriteSucceededByAccident(parsed);
	if (accident !== undefined) return accident;
	const textRepair = tryRepairRewriteResponse(raw);
	if (textRepair !== undefined) return textRepair;
	return undefined;
}

// Repair common JSON malformations in rewrite responses. Mirrors the
// gate repair strategy (see gate.ts `tryRepairGateResponse`) — same
// patterns observed in qwen2.5:3b output, plus the chained progression
// from brace-append to keys-quote.
function tryRepairRewriteResponse(raw: string): Record<string, unknown> | undefined {
	let candidate: string | undefined = raw;
	const stages = [repairRewriteBrace, repairRewriteKeys, repairRewriteCast];
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

function repairRewriteBrace(raw: string): string | undefined {
	const opens = (raw.match(/\{/g) ?? []).length;
	const closes = (raw.match(/\}/g) ?? []).length;
	if (opens !== closes + 1) return undefined;
	return raw.replace(/,\s*$/, "") + "}";
}

function repairRewriteKeys(raw: string): string | undefined {
	const knownFields = ["subqueries"];
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

function repairRewriteCast(raw: string): string | undefined {
	const candidate = raw.replace(/:\s*"true"\s*([,}])/g, ":true$1").replace(/:\s*"false"\s*([,}])/g, ":false$1");
	return candidate === raw ? undefined : candidate;
}

// Repair the "succeeded by accident" case for rewrite. qwen2.5:3b
// occasionally emits `{"subqueries:[...]":...}` where the model
// intended `{"subqueries": [...]}` but dropped the key's closing
// `"` early. JSON.parse accepts the malformed input by reading the
// literal key as `"subqueries:[...]"` and pairing it with whatever
// value the model wrote after it. The object has no `subqueries`
// field, so the schema check fails.
//
// Detection: an object key contains a `:`. We split the key at the
// first colon and pair the prefix with the parsed value. We only
// fire this repair when the value is an array (the rewrite's
// `subqueries` value type) — the gate's "succeeded by accident"
// case (boolean values) is the same pattern but different value
// type, and is handled by tryRepairSucceededByAccident in gate.ts.
//
// Returns the repaired object, or undefined if the shape doesn't
// match (so the loop can try other repairs).
function tryRepairRewriteSucceededByAccident(
	parsed: unknown,
): Record<string, unknown> | undefined {
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const obj = parsed as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	let mutated = false;
	for (const [key, value] of Object.entries(obj)) {
		const colonIdx = key.indexOf(":");
		if (colonIdx > 0) {
			const realKey = key.slice(0, colonIdx);
			if (realKey.length > 0 && !realKey.includes(" ") && Array.isArray(value)) {
				result[realKey] = value;
				mutated = true;
				continue;
			}
		}
		result[key] = value;
	}
	return mutated ? result : undefined;
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
				format: "json",
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
