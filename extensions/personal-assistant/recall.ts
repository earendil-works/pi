// ---------------------------------------------------------------------------
// recallPipeline — shared TUI / webui recall entry point (task 1.1 scaffold).
//
// This module is the single recall entry point used by both:
//   - the TUI `context` hook (personal-assistant memory.ts:726)
//   - the webui `POST /api/memory/search` route (webui routes/memory.ts:845)
//
// The pipeline runs `rewrite → recall → rerank → merge`. The gate decision
// lives in the caller (not in the pipeline) so that this helper stays a
// pure function over `(index, opts) → {results, status}`.
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
//     100ms `/api/health` probe populates `status.embeddingServiceStatus`.
//     TUI callers pass `false` or omit.
//
// This file is the 1.1 SCAFFOLD. The body throws "not implemented" so the
// signature and type contract can be locked in and call sites wired up
// (tasks 5.1, 6.1) before the full implementation lands in tasks 1.2-1.4.
// ---------------------------------------------------------------------------

import type { MemoryIndex } from "./storage.ts";
import type { MemoryAtomType, RecallResult } from "./types.ts";

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
 *   - `embeddingServiceUrl`     — override the bge-m3 / rerank service URL.
 *   - `embeddingServiceUrlProbe` — webui-only. When `true`, probe `/api/health` and
 *                                   populate `status.embeddingServiceStatus`.
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
 * SCAFFOLD (task 1.1): body throws "not implemented". The signature and
 * type contract are the only deliverables for 1.1. Tasks 1.2-1.4 fill in:
 *   - 1.2: rewrite → recall → rerank → merge core
 *   - 1.3: embedding service health probe
 *   - 1.4: topK clamp to [1, 100]
 *
 * The caller owns the `MemoryIndex` lifecycle (open + `init()` + `close()`).
 * `recallPipeline` is a pure pipeline — it does not open, init, or close
 * the index. The webui route and the TUI context hook keep their existing
 * index ownership semantics.
 */
export async function recallPipeline(
	_index: MemoryIndex,
	_opts: RecallPipelineOptions,
): Promise<RecallPipelineResult> {
	throw new Error("not implemented");
}
