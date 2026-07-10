// ---------------------------------------------------------------------------
// recallPipeline — shared TUI / webui recall entry point.
//
// This module is the single recall entry point used by both:
//   - the TUI `context` hook (personal-assistant memory.ts:726)
//   - the webui `POST /api/memory/search` route (webui routes/memory.ts:845)
//
// The pipeline runs `probe → rewrite → recall → rerank → merge`. The gate
// decision lives in the caller (not in the pipeline) so that this helper
// stays a pure function over `(index, opts) → {results, status}`. The
// probe step is opt-in via `embeddingServiceUrlProbe: true` and is a
// webui-only concern.
//
// Architecture decisions honoured here (see docs/sdd/changes/agent-driven-memory-save/design.md
// § Architecture, § 8 "抽出 recallPipeline() 共享 helper", § 9 "recallPipeline 接受 recent
// 与 topK 默认 20"):
//   - Principle 9 (single home): this is the only module that exposes the
//     recall pipeline. Callers consume `{results, status}`. No inline
//     rewrite/recall/rerank/merge code in either caller.
//   - `topK` defaults to 20; when specified, the pipeline clamps to [1, 100].
//   - `recent?: string[] | null` is forwarded to `rewriteQueries` verbatim.
//     `null` and `undefined` are both treated as "no recent context" — the
//     rewrite prompt falls back to the "Recent user messages: None" placeholder.
//   - `embeddingServiceUrlProbe` is a webui-only opt-in. When `true`, a
//     100ms `/api/health` probe populates `status.embeddingServiceStatus`
//     ("up" on 2xx, "down" on non-2xx / abort / network error). TUI
//     callers pass `false` or omit; the field stays undefined and no
//     fetch is issued.
//
// Task 1.2 implements the core pipeline body: `rewrite → recall → rerank →
// merge`. Task 1.3 fills in the `embeddingServiceUrlProbe` probe branch
// (runs before the rewrite step so its latency never contaminates the
// per-stage `*Ms` timings — it only shows up in wall-clock total). Task
// 1.4 adds the [1, 100] clamp on `topK`.
// ---------------------------------------------------------------------------

import { mergeByRerankScore } from "./merge.ts";
import { rerankAndFilter } from "./rerank.ts";
import { rewriteQueries } from "./rewrite.ts";
import { recallAtoms } from "./search.ts";
import type { MemoryIndex } from "./storage.ts";
import type { MemoryAtomType, RecallResult } from "./types.ts";

/**
 * Default probe URL. Matches `hybrid-search.ts:40 DEFAULT_EMBEDDING_SERVICE_URL`
 * and `embed.ts DEFAULT_CONFIG.ollamaUrl`. The bge-m3 + bge-reranker
 * services expose `/api/health` on the same port; when the service is up
 * but `/api/health` lies (3xx redirects, 4xx/5xx errors) the probe
 * correctly reports "down". Network-level errors (ECONNREFUSED,
 * abort-on-timeout) are caught by the outer try and also report "down".
 */
const DEFAULT_EMBEDDING_SERVICE_URL = "http://127.0.0.1:11435";

/** Probe timeout. Same budget as `packages/webui/server/routes/memory.ts:888`. */
const PROBE_TIMEOUT_MS = 100;

/**
 * Options for the shared `recallPipeline` helper.
 *
 * Required:
 *   - `query`     — the current user prompt (TUI = last user message, webui = `req.body.query`).
 *   - `atomsDir`  — on-disk atom directory; recall reads `${atomsDir}/${type}/${id}.md`
 *                   to refresh `atom.content` so the LLM sees the freshest text
 *                   (DB row is a snapshot; .md is the source of truth — see
 *                   `recallAtoms` in search.ts).
 *
 * Optional (defaults applied inside the body — see tasks 1.2-1.4):
 *   - `recent`                  — up-to-3 prior user messages for anaphora resolution.
 *                                 TUI passes the array; webui passes `null` by default.
 *                                 `null` and `undefined` are both treated as "no recent".
 *   - `topK`                    — candidates per subquery. Default 20. Clamped to [1, 100].
 *   - `filter`                  — narrow recall to a single atom type.
 *   - `rerankEnabled`           — default `true`. When `false`, skip rerank and return
 *                                 the raw RRF pool.
 *   - `embeddingServiceUrl`     — override the bge-m3 / rerank service URL (also
 *                                 used as the probe base URL when probe=true).
 *   - `embeddingServiceUrlProbe` — webui-only. When `true`, probe `/api/health`
 *                                 (100ms budget) and populate
 *                                 `status.embeddingServiceStatus` ("up" | "down").
 *                                 TUI callers pass `false` or omit; field stays
 *                                 `undefined` and no fetch is issued.
 */

export interface RecallPipelineOptions {
	query: string;
	recent?: string[] | null;
	topK?: number;
	filter?: { type?: MemoryAtomType };
	rerankEnabled?: boolean;
	embeddingServiceUrl?: string;
	atomsDir: string;
	embeddingServiceUrlProbe?: boolean;
}

/**
 * Status metadata describing each pipeline stage's outcome. Surfaced to
 * callers (TUI `setStatus` / webui response body) and the source of truth
 * for all timing measurements in the pipeline.
 *
 * Stage outcomes (mirrors `rewrite.ts` / `rerank.ts` failure categories):
 *   - `rewrite` — "ok" (LLM succeeded) | "skip" (disabled or no recent) |
 *                 "parse" (LLM output unparseable) | "timeout" |
 *                 "unreachable" (ollama down) | "disabled" (config off).
 *   - `rerank`  — "ok" (cross-encoder returned) | "fallback" (service down,
 *                 used `RerankFallback.topK`) | "skip" (rerank disabled) |
 *                 "all-below" (threshold cut every hit).
 *
 * `embeddingServiceStatus` is only set when the caller passes
 * `embeddingServiceUrlProbe: true` (webui route). TUI callers pass `false`
 * and the field stays `undefined`.
 */
export type RecallPipelineStatus = {
	rewrite: "ok" | "skip" | "parse" | "timeout" | "unreachable" | "disabled";
	rerank: "ok" | "fallback" | "skip" | "all-below";
	recallMs: number;
	rewriteMs: number;
	rerankMs: number;
	embeddingServiceStatus?: "up" | "down";
};

export interface RecallPipelineResult {
	results: RecallResult[];
	status: RecallPipelineStatus;
}

/**
 * Shared TUI / webui recall pipeline.
 *
 * Runs `rewriteQueries → recallAtoms → rerankAndFilter → mergeByRerankScore`
 * per-subquery, in parallel across the subqueries produced by the rewrite
 * step. Returns `{results, status}` where:
 *
 *   - `results` is the deduped, rerankScore-sorted output of
 *     `mergeByRerankScore(poolResults)` — the same shape both call sites
 *     already consume.
 *   - `status` carries per-stage outcomes (string union members) and three
 *     timing measurements sourced from `performance.now()`.
 *
 * `topK` defaults to 20 (task 1.4 adds the [1, 100] clamp). `rerankEnabled`
 * defaults to `true`. `recent` is forwarded verbatim to `rewriteQueries`:
 * both `null` and `undefined` produce the "no recent context" branch. The
 * `embeddingServiceUrl` override is forwarded to both `recallAtoms` and
 * `rerankAndFilter` (they share the same bge-m3 + bge-reranker service
 * endpoint). `embeddingServiceUrlProbe` is consumed by task 1.3 — for 1.2
 * the field stays `undefined` on the returned status.
 *
 * The caller owns the `MemoryIndex` lifecycle (open + `init()` + `close()`).
 * `recallPipeline` is a pure pipeline — it does not open, init, or close
 * the index. The webui route and the TUI context hook keep their existing
 * index ownership semantics.
 */
export async function recallPipeline(
	index: MemoryIndex,
	opts: RecallPipelineOptions,
): Promise<RecallPipelineResult> {
	// Defaults applied at the entry boundary so downstream stages see
	// normalized values and the test suite can probe the call shape
	// without the body re-applying defaults per subquery.
	//
	// `topK` (task 1.4) is clamped to the closed interval [1, 100]. Anything
	// outside that range — including non-finite values such as `NaN`,
	// `Infinity`, `-Infinity` — falls back to the default 20. This
	// matches the TUI's own default and aligns webui callers with it
	// (architecture constraint: design.md § Decisions § 9 "topK 默认 20,
	// 与 TUI 当前行为对齐"). The clamp runs ONCE at the entry; the
	// normalized `topK` is what reaches `recallAtoms`, not the raw
	// `opts.topK` — `recallAtoms` itself is intentionally NaN/clamp-naive
	// so the pipeline owns the policy.
	const rawTopK = opts.topK;
	const topK =
		typeof rawTopK === "number" && Number.isFinite(rawTopK)
			? Math.max(1, Math.min(100, rawTopK))
			: 20;
	const rerankEnabled = opts.rerankEnabled ?? true;

	// -----------------------------------------------------------------
	// Step 1: Probe (opt-in) — webui-only `/api/health` check, 100ms
	// budget. When `opts.embeddingServiceUrlProbe === true`, hit the
	// embedding service once before any recall work, set
	// `embeddingServiceStatus` to "up" (2xx response) or "down"
	// (non-2xx / abort / network error). TUI callers pass `false` or
	// omit, in which case the field stays undefined and no fetch
	// occurs at all.
	//
	// The probe runs BEFORE the rewrite step so its latency never
	// contaminates `recallMs` / `rewriteMs` / `rerankMs` — those three
	// measurements stay scoped to their named stage. The probe may
	// cost up to 100ms; that budget shows up only in wall-clock total,
	// not in any `*Ms` field on the returned status.
	//
	// Best-effort: any throw (network error, AbortError on timeout,
	// malformed URL, etc.) is caught and reported as "down". This is
	// a hard contract — a probe failure MUST NEVER break the pipeline.
	// Mirrors the pattern at packages/webui/server/routes/memory.ts:882-896.
	// -----------------------------------------------------------------
	let embeddingServiceStatus: "up" | "down" | undefined;
	if (opts.embeddingServiceUrlProbe === true) {
		const probeUrl =
			opts.embeddingServiceUrl ?? DEFAULT_EMBEDDING_SERVICE_URL;
		try {
			const controller = new AbortController();
			const probeTimer = setTimeout(
				() => controller.abort(),
				PROBE_TIMEOUT_MS,
			);
			const probeRes = await fetch(`${probeUrl}/api/health`, {
				signal: controller.signal,
			});
			clearTimeout(probeTimer);
			embeddingServiceStatus = probeRes.ok ? "up" : "down";
		} catch {
			embeddingServiceStatus = "down";
		}
	}

	// -----------------------------------------------------------------
	// Step 2: Rewrite — decompose `query` (with optional `recent`) into
	// a list of subqueries for parallel recall. `rewriteQueries` returns
	// either `string[]` (success) or `RewriteFallback` (degraded single-
	// element `[rawQuery]` array with a failure `reason`). The fallback
	// branch keeps the pipeline producing *something* rather than
	// producing a no-memory-match status from a parser failure.
	// -----------------------------------------------------------------
	const rewriteStart = performance.now();
	const rewriteOutcome = await rewriteQueries(opts.query, opts.recent ?? null);
	const rewriteMs = performance.now() - rewriteStart;

	let rewriteStatus: RecallPipelineStatus["rewrite"];
	let subqueries: string[];
	if (Array.isArray(rewriteOutcome)) {
		rewriteStatus = "ok";
		subqueries = rewriteOutcome;
	} else {
		// reason ∈ "timeout" | "parse" | "unreachable" — directly assignable
		// to RecallPipelineStatus["rewrite"] (subset of the union).
		rewriteStatus = rewriteOutcome.reason;
		subqueries = rewriteOutcome.subqueries;
	}

	// -----------------------------------------------------------------
	// Step 3: Recall + Rerank — parallel across subqueries. Each branch
	// owns its own timing accumulator so the status reflects per-stage
	// cost rather than wall-clock overlap. The four-stage design is:
	//   a. recallAtoms(index, sq, {topK, filter, atomsDir, embeddingServiceUrl})
	//   b. if 0 hits, return [] (skip rerank — nothing to rerank)
	//   c. if !rerankEnabled, return raw RRF hits (skip rerank by request)
	//   d. rerankAndFilter(sq, sqResults, {serviceUrl: embeddingServiceUrl})
	//   e. discriminated union → array branch or .topK fallback branch
	// -----------------------------------------------------------------
	let recallMs = 0;
	let rerankMs = 0;
	// Sticky-priority aggregation across subqueries (review fix for 1.2).
	// `rerankStatus` is shared across the parallel `subqueries.map(...)`
	// branches, and `Promise.all` awaits whichever microtask finishes
	// last. A naive `rerankStatus = ...` assignment would let a later
	// "ok" subquery silently mask an earlier "fallback" / "all-below",
	// losing the degradation signal that downstream consumers (TUI
	// `setStatus`, webui response, `format.ts` warning injection) depend
	// on. Priority (worst → least): "all-below" > "fallback" > "skip" >
	// "ok". We only ever upgrade; never downgrade.
	let rerankStatus: RecallPipelineStatus["rerank"] = "skip";

	const poolResults = await Promise.all(
		subqueries.map(async (sq) => {
			const recallStart = performance.now();
			const sqResults = await recallAtoms(index, sq, {
				topK,
				filter: opts.filter,
				embeddingServiceUrl: opts.embeddingServiceUrl,
				atomsDir: opts.atomsDir,
			});
			recallMs += performance.now() - recallStart;

			if (sqResults.length === 0) return [] as RecallResult[];
			if (!rerankEnabled) return sqResults;

			const rerankStart = performance.now();
			const scored = await rerankAndFilter(sq, sqResults, {
				serviceUrl: opts.embeddingServiceUrl,
			});
			rerankMs += performance.now() - rerankStart;

			if (Array.isArray(scored)) {
				// An empty array from `rerankAndFilter` (when hits were non-empty
				// going in) means the threshold cut every hit — surface this as
				// `all-below` so the caller can distinguish "service returned
				// nothing usable" from "service returned the right hits".
				// Sticky: only set "ok" from "skip" (don't downgrade from a
				// previously-observed "fallback" / "all-below"), and "all-below"
				// from anything less severe.
				if (scored.length === 0) {
					if (rerankStatus !== "all-below") rerankStatus = "all-below";
				} else if (rerankStatus === "skip") {
					rerankStatus = "ok";
				}
				return scored;
			}
			// `RerankFallback` shape — service unreachable / http-error /
			// shape-mismatch / timeout. The .topK field holds the pre-rerank
			// RRF ranking so the caller still gets the best-effort top hits.
			// Sticky: only set "fallback" from "skip" or "ok" (i.e. never
			// downgrade an already-observed "all-below" — both are degradation
			// signals, and "all-below" is strictly worse in the priority order).
			if (rerankStatus === "skip" || rerankStatus === "ok") {
				rerankStatus = "fallback";
			}
			return scored.topK;
		}),
	);

	// -----------------------------------------------------------------
	// Step 4: Merge — dedup across subquery pools by atom.id, keep the
	// highest `rerankScore` per id, sort by `rerankScore` DESC. Pure
	// function: takes the per-subquery arrays and emits the final list.
	// -----------------------------------------------------------------
	const results = mergeByRerankScore(poolResults);

	return {
		results,
		status: {
			rewrite: rewriteStatus,
			rerank: rerankStatus,
			recallMs,
			rewriteMs,
			rerankMs,
			embeddingServiceStatus,
		},
	};
}
