// ---------------------------------------------------------------------------
// recallPipeline — shared TUI / webui recall entry point tests (task 1.1).
//
// TDD state for 1.1 (scaffold only):
//   - "signature + exports" suite PASSES (compile-time + import checks).
//   - "behavior" suite FAILS — the scaffold body throws "not implemented",
//     so any test that actually invokes `recallPipeline` and asserts on
//     its return value falls into the catch and reports RED.
//
// Tasks 1.2+ implement the body; the "behavior" suite turns GREEN there.
// The mocks below are set up now (1.1) so 1.2 can drop in the body
// without touching the test file.
//
// Scenarios covered (from docs/sdd/changes/agent-driven-memory-save/specs/tui-webui-recall-parity):
//   - "TUI passes recent user messages for anaphora" → recent forwarded to rewriteQueries
//   - "webui passes recent: null by default"          → null forwarded when recent omitted
//   - "TUI default topK = 20"                        → recallAtoms called with topK: 20
//   - "webui topK clamped to [1, 100]"                → (1.4) skipped here; 1.4 adds clamp tests
//   - "pipeline status reflects each stage's outcome" → status.{rewrite,rerank,recallMs,...} populated
//   - "rerank fallback surfaced in status"           → (1.2) status.rerank = "fallback"
//   - "webui embedding service status from pipeline" → (1.3) embeddingServiceStatus when probe=true
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	recallPipeline,
	type RecallPipelineOptions,
	type RecallPipelineResult,
	type RecallPipelineStatus,
} from "../recall.ts";
import type { RerankFallback } from "../rerank.ts";
import type { MemoryIndex } from "../storage.ts";
import type { MemoryAtom, MemoryAtomType, RecallResult } from "../types.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks — vitest hoists vi.mock() above imports, so the factory
// references must come from vi.hoisted(). The mocked functions are the
// four stages recallPipeline will use in 1.2: rewriteQueries, recallAtoms,
// rerankAndFilter, mergeByRerankScore. The scaffold (1.1) doesn't call
// them, but the mocks are wired up so 1.2's body works without test edits.
// ---------------------------------------------------------------------------

const mockRewriteQueries = vi.hoisted(
	() => vi.fn<(...args: unknown[]) => Promise<string[] | { reason: string; subqueries: string[] }>>(),
);
const mockRecallAtoms = vi.hoisted(
	() => vi.fn<(...args: unknown[]) => Promise<RecallResult[]>>(),
);
const mockRerankAndFilter = vi.hoisted(() => vi.fn());
const mockMergeByRerankScore = vi.hoisted(
	() => vi.fn<(groups: RecallResult[][]) => RecallResult[]>(),
);

vi.mock("../rewrite.ts", () => ({ rewriteQueries: mockRewriteQueries }));
vi.mock("../search.ts", () => ({ recallAtoms: mockRecallAtoms }));
vi.mock("../rerank.ts", () => ({ rerankAndFilter: mockRerankAndFilter }));
vi.mock("../merge.ts", () => ({ mergeByRerankScore: mockMergeByRerankScore }));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for a `MemoryIndex`. The cast is safe because the four
 * pipeline stages are mocked: `recallPipeline` hands the value through to
 * `recallAtoms(index, …)`, which the mock accepts regardless of shape. No
 * real `MemoryIndex.init()` / `getAtom()` / `close()` is ever invoked.
 */
function fakeIndex(): MemoryIndex {
	return {} as unknown as MemoryIndex;
}

function createAtom(id: string, type: MemoryAtom["type"] = "rule"): MemoryAtom {
	return {
		id,
		type,
		title: `Test ${type} ${id}`,
		content: `Content of ${id}`,
		summary: `Summary of ${id}`,
		tags: [],
		importance: 0.5,
		strength: 0.5,
		access_count: 0,
		version: 1,
		is_latest: 1 as const,
		parent_id: null,
		superseded_at: null,
		archived: 0 as const,
		created_at: Date.now(),
		updated_at: Date.now(),
		last_access: null,
		content_fingerprint: `fp_${id}`,
		source_session: null,
	};
}

function recallResult(id: string, type: MemoryAtom["type"] = "rule"): RecallResult {
	return {
		atom: createAtom(id, type),
		cosine: 0.9,
		sparseScore: 0.7,
		rrf: 0.5,
		rerankScore: 0.85,
	};
}

// ---------------------------------------------------------------------------
// Suite 1: signature + exports — PASSES in 1.1 (scaffold) and in 1.2+.
// These tests are pure compile-time / module-load checks. They never call
// `recallPipeline`, so the "not implemented" throw is irrelevant.
// ---------------------------------------------------------------------------

describe("recallPipeline signature + exports", () => {
	it("exports recallPipeline as a function", () => {
		expect(typeof recallPipeline).toBe("function");
	});

	it("RecallPipelineOptions accepts the full option set (compile-time)", () => {
		// If any field name or type is wrong, this assignment fails to compile.
		const opts: RecallPipelineOptions = {
			query: "what is X?",
			recent: ["msg1", "msg2"],
			topK: 20,
			filter: { type: "rule" as MemoryAtomType },
			rerankEnabled: true,
			atomsDir: "/tmp/atoms",
			embeddingServiceUrl: "http://127.0.0.1:11435",
			embeddingServiceUrlProbe: true,
		};
		expect(opts.query).toBe("what is X?");
		expect(opts.recent).toEqual(["msg1", "msg2"]);
		expect(opts.topK).toBe(20);
		expect(opts.filter?.type).toBe("rule");
		expect(opts.rerankEnabled).toBe(true);
	});

	it("only query and atomsDir are required; everything else is optional", () => {
		// Minimal options — recent, topK, filter, rerankEnabled,
		// embeddingServiceUrl, embeddingServiceUrlProbe all default to
		// undefined at the call site and are filled in by the body.
		const opts: RecallPipelineOptions = {
			query: "minimal",
			atomsDir: "/tmp/atoms",
		};
		expect(opts.recent).toBeUndefined();
		expect(opts.topK).toBeUndefined();
		expect(opts.filter).toBeUndefined();
		expect(opts.rerankEnabled).toBeUndefined();
		expect(opts.embeddingServiceUrl).toBeUndefined();
		expect(opts.embeddingServiceUrlProbe).toBeUndefined();
	});

	it("RecallPipelineOptions accepts recent: null (webui default)", () => {
		// webui's POST /api/memory/search forwards `recent ?? null` even
		// when the field is absent in the body. The pipeline must accept
		// an explicit null and treat it the same as undefined.
		const opts: RecallPipelineOptions = {
			query: "test",
			atomsDir: "/tmp/atoms",
			recent: null,
		};
		expect(opts.recent).toBeNull();
	});

	it("RecallPipelineStatus accepts the full set of stage outcomes", () => {
		// Compile-time check: every value of each union is assignable.
		const rewriteOutcomes: RecallPipelineStatus["rewrite"][] = [
			"ok",
			"skip",
			"parse",
			"timeout",
			"unreachable",
			"disabled",
		];
		const rerankOutcomes: RecallPipelineStatus["rerank"][] = [
			"ok",
			"fallback",
			"skip",
			"all-below",
		];
		const status: RecallPipelineStatus = {
			rewrite: "ok",
			rerank: "ok",
			recallMs: 12,
			rewriteMs: 34,
			rerankMs: 56,
			embeddingServiceStatus: "up",
		};
		expect(rewriteOutcomes).toContain(status.rewrite);
		expect(rerankOutcomes).toContain(status.rerank);
		expect(status.embeddingServiceStatus).toBe("up");
	});

	it("embeddingServiceStatus is optional (TUI callers pass probe=false)", () => {
		// TUI never sets embeddingServiceUrlProbe, so the field stays
		// undefined on the returned status. The shape must allow that.
		const status: RecallPipelineStatus = {
			rewrite: "skip",
			rerank: "skip",
			recallMs: 0,
			rewriteMs: 0,
			rerankMs: 0,
		};
		expect(status.embeddingServiceStatus).toBeUndefined();
	});

	it("RecallPipelineResult carries results and status", () => {
		const r: RecallPipelineResult = {
			results: [],
			status: {
				rewrite: "skip",
				rerank: "skip",
				recallMs: 0,
				rewriteMs: 0,
				rerankMs: 0,
			},
		};
		expect(r.results).toEqual([]);
		expect(r.status.rewrite).toBe("skip");
	});
});

// ---------------------------------------------------------------------------
// Suite 2: behavior — FAILS in 1.1 (scaffold throws "not implemented").
//
// Every test in this block actually invokes `recallPipeline` and asserts
// on its return value. In 1.1 the body throws, so the await rejects and
// vitest reports each test as failed — this is the RED state.
//
// In 1.2 (rewrite → recall → rerank → merge core) and 1.3 (probe) the body
// is implemented and these tests turn GREEN. The mocks below carry the
// fixture the body needs; the body in 1.2+ just consumes them.
// ---------------------------------------------------------------------------

describe("recallPipeline behavior (RED in 1.1, GREEN in 1.2+)", () => {
	beforeEach(() => {
		// Default fixtures: 1 subquery, no recall hits, no rerank hits,
		// merge returns the concatenated (empty) groups.
		mockRewriteQueries.mockReset();
		mockRewriteQueries.mockImplementation(async (q: unknown) => [q as string]);
		mockRecallAtoms.mockReset();
		mockRecallAtoms.mockResolvedValue([]);
		mockRerankAndFilter.mockReset();
		mockRerankAndFilter.mockResolvedValue([]);
		mockMergeByRerankScore.mockReset();
		mockMergeByRerankScore.mockImplementation((groups: RecallResult[][]) => groups.flat());
	});

	// -----------------------------------------------------------------------
	// Recent forwarding
	// -----------------------------------------------------------------------

	it("forwards recent: string[] to rewriteQueries verbatim (TUI)", async () => {
		// Scenario: TUI context hook extracts the last 3 prior user
		// messages and hands them to recallPipeline. The internal
		// rewriteQueries call must receive them in the same order.
		await recallPipeline(fakeIndex(), {
			query: "current",
			recent: ["msg1", "msg2", "msg3"],
			atomsDir: "/tmp/atoms",
		});

		expect(mockRewriteQueries).toHaveBeenCalledTimes(1);
		const call = mockRewriteQueries.mock.calls[0]!;
		expect(call[0]).toBe("current");
		expect(call[1]).toEqual(["msg1", "msg2", "msg3"]);
	});

	it("forwards recent: null to rewriteQueries when caller passes null (webui)", async () => {
		// Scenario: webui request body has no `recent` field; the route
		// forwards `recent: null` to the pipeline. The internal
		// rewriteQueries call must receive null so the rewrite prompt
		// shows the "Recent user messages: None" placeholder.
		await recallPipeline(fakeIndex(), {
			query: "current",
			recent: null,
			atomsDir: "/tmp/atoms",
		});

		expect(mockRewriteQueries).toHaveBeenCalledTimes(1);
		expect(mockRewriteQueries.mock.calls[0]![1]).toBeNull();
	});

	it("forwards null to rewriteQueries when recent is omitted entirely", async () => {
		// The two paths (explicit null vs omitted) must produce the
		// same downstream behavior — both end up as `null` at
		// rewriteQueries, both produce the "None" placeholder.
		await recallPipeline(fakeIndex(), {
			query: "current",
			atomsDir: "/tmp/atoms",
		});

		expect(mockRewriteQueries).toHaveBeenCalledTimes(1);
		expect(mockRewriteQueries.mock.calls[0]![1]).toBeNull();
	});

	// -----------------------------------------------------------------------
	// topK default
	// -----------------------------------------------------------------------

	it("uses topK: 20 by default when opts.topK is undefined (TUI default)", async () => {
		// Scenario: TUI context hook calls recallPipeline without topK;
		// the internal recallAtoms call must use topK: 20 so the recall
		// pool matches the design's stated default.
		await recallPipeline(fakeIndex(), {
			query: "test",
			atomsDir: "/tmp/atoms",
		});

		expect(mockRecallAtoms).toHaveBeenCalledTimes(1);
		const opts = mockRecallAtoms.mock.calls[0]![2] as { topK?: number };
		expect(opts.topK).toBe(20);
	});

	it("passes caller's topK through to recallAtoms when specified", async () => {
		// Sanity: a non-default topK reaches recallAtoms unchanged at 1.1's
		// scaffold level. Task 1.4 will replace this with the [1, 100] clamp.
		await recallPipeline(fakeIndex(), {
			query: "test",
			topK: 50,
			atomsDir: "/tmp/atoms",
		});

		expect(mockRecallAtoms).toHaveBeenCalledTimes(1);
		const opts = mockRecallAtoms.mock.calls[0]![2] as { topK?: number };
		expect(opts.topK).toBe(50);
	});

	// -----------------------------------------------------------------------
	// Return shape + status
	// -----------------------------------------------------------------------

	it("returns {results, status} with status.recallMs / rewriteMs / rerankMs populated", async () => {
		// Scenario: pipeline status reflects each stage's outcome. The
		// three timing fields are required (not optional) and must be
		// numbers — they are the source of truth for the TUI debug log
		// and the webui response body's recallTimeMs / rewriteTimeMs /
		// rerankTimeMs fields.
		const out = await recallPipeline(fakeIndex(), {
			query: "test",
			atomsDir: "/tmp/atoms",
		});

		expect(out).toHaveProperty("results");
		expect(out).toHaveProperty("status");
		expect(Array.isArray(out.results)).toBe(true);
		expect(typeof out.status.recallMs).toBe("number");
		expect(typeof out.status.rewriteMs).toBe("number");
		expect(typeof out.status.rerankMs).toBe("number");
	});

	it("status.rewrite === 'ok' when rewriteQueries returns string[]", async () => {
		// Successful rewrite: LLM returned a parseable subquery array.
		mockRewriteQueries.mockResolvedValue(["sub1", "sub2"]);
		mockRecallAtoms.mockResolvedValue([recallResult("a", "rule")]);
		mockRerankAndFilter.mockResolvedValue([recallResult("a", "rule")]);
		mockMergeByRerankScore.mockReturnValue([recallResult("a", "rule")]);

		const out = await recallPipeline(fakeIndex(), {
			query: "test",
			atomsDir: "/tmp/atoms",
		});

		expect(out.status.rewrite).toBe("ok");
	});

	it("returns results from mergeByRerankScore (final dedup + sort step)", async () => {
		// The pipeline's last step before returning is mergeByRerankScore.
		// Whatever it returns is what recallPipeline hands to the caller
		// as `results` — no further mutation in the pipeline.
		const merged = [recallResult("a", "rule"), recallResult("b", "fact")];
		mockRewriteQueries.mockResolvedValue(["sub1"]);
		mockRecallAtoms.mockResolvedValue([]);
		mockRerankAndFilter.mockResolvedValue([]);
		mockMergeByRerankScore.mockReturnValue(merged);

		const out = await recallPipeline(fakeIndex(), {
			query: "test",
			atomsDir: "/tmp/atoms",
		});

		expect(out.results).toBe(merged);
		expect(out.results).toHaveLength(2);
	});

	// -----------------------------------------------------------------------
	// Multi-subquery rerankStatus aggregation (task 1.2 review fix)
	// -----------------------------------------------------------------------

	it("status.rerank === 'fallback' is sticky across subqueries (sticky priority)", async () => {
		// Scenario: rewrite returns two subqueries. subq1's rerank returns a
		// `RerankFallback` (rerank service unreachable) — the worst case.
		// subq2's rerank returns successful `RecallResult[]`. With a naive
		// `rerankStatus = ...` closure assignment, the final value is whichever
		// subquery's microtask writes last — making a "fallback" silently
		// maskable by a later "ok". Downstream consumers (TUI setStatus,
		// webui response, format.ts warning injection) depend on
		// `status.rerank === "fallback"` to surface the degradation signal,
		// so this MUST be sticky.
		//
		// Determinism: subq1's mock resolves immediately; subq2's mock
		// resolves on the next microtask tick. In the buggy code subq2's
		// `rerankStatus = "ok"` runs LAST → final value is "ok" (the bug).
		// In the fixed code "fallback" sticks → final value is "fallback".
		const subq1Hit = recallResult("from-subq1", "rule");
		const subq2Hit = recallResult("from-subq2", "fact");
		const fallback: RerankFallback = {
			reason: "unreachable",
			topK: [subq1Hit],
		};

		mockRewriteQueries.mockResolvedValue(["subq1", "subq2"]);
		mockRecallAtoms.mockImplementation(
			async (_idx: unknown, sq: unknown) =>
				sq === "subq1" ? [subq1Hit] : [subq2Hit],
		);
		mockRerankAndFilter.mockImplementation(async (sq: unknown) => {
			if (sq === "subq1") {
				// Resolves immediately → `rerankStatus = "fallback"` runs first.
				return fallback;
			}
			// Resolves one microtask later → `rerankStatus = "ok"` runs
			// second. In the buggy code this LAST write wins ("ok"),
			// silently masking the fallback signal.
			return Promise.resolve().then(() => [subq2Hit]);
		});
		mockMergeByRerankScore.mockImplementation(
			(groups: RecallResult[][]) => groups.flat(),
		);

		const out = await recallPipeline(fakeIndex(), {
			query: "test",
			atomsDir: "/tmp/atoms",
		});

		// "fallback" must stick — even though subq2 finished later with "ok".
		expect(out.status.rerank).toBe("fallback");
	});
});

// ---------------------------------------------------------------------------
// Suite 3: embeddingServiceStatus probe (task 1.3) — RED before 1.3 body is
// implemented. The pipeline's "Step 2: Probe" branch is currently empty
// (TODO placeholder) so `status.embeddingServiceStatus` is never set, even
// when the caller asks for the probe. Tests 1 and 2 must FAIL.
//
// Scenarios covered (from docs/sdd/changes/agent-driven-memory-save/specs
// /tui-webui-recall-parity/spec.md § "recallPipeline exposes pipeline
// timing and status metadata"):
//   - "webui embedding service status from pipeline"  → probe + 2xx → "up"
//   - "webui embedding service down surfaces status" → probe + 5xx / throw
//                                                       → "down"
//   - TUI probe=false / omitted                        → field undefined,
//                                                       fetch NOT called
//
// fetch is mocked via globalThis.fetch (assignment + restore in afterEach)
// since `vi.mock("../search.ts")` etc. don't intercept the global fetch.
// All four pipeline stages are still mocked at the module level via the
// vi.mock() calls at the top of the file — so the only `fetch` calls
// inside `recallPipeline` come from the probe branch itself.
// ---------------------------------------------------------------------------

describe("recallPipeline embedding probe", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		// Pipeline-stage fixture: a single subquery, no recall hits, no
		// rerank hits. The probe suite exercises the probe branch only —
		// the downstream stages stay inert.
		mockRewriteQueries.mockReset();
		mockRewriteQueries.mockImplementation(async (q: unknown) => [q as string]);
		mockRecallAtoms.mockReset();
		mockRecallAtoms.mockResolvedValue([]);
		mockRerankAndFilter.mockReset();
		mockRerankAndFilter.mockResolvedValue([]);
		mockMergeByRerankScore.mockReset();
		mockMergeByRerankScore.mockImplementation(
			(groups: RecallResult[][]) => groups.flat(),
		);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("status.embeddingServiceStatus === 'up' when probe=true and /api/health returns 2xx", async () => {
		// Scenario: webui route passes embeddingServiceUrlProbe: true. The
		// bge-m3 service is healthy and /api/health returns 200. The
		// response body the webui hands back to the client must include
		// `embeddingServiceStatus: "up"`.
		const fetchSpy = vi.fn(
			async () => new Response("ok", { status: 200 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchSpy;

		const out = await recallPipeline(fakeIndex(), {
			query: "test",
			atomsDir: "/tmp/atoms",
			embeddingServiceUrl: "http://127.0.0.1:11435",
			embeddingServiceUrlProbe: true,
		});

		expect(out.status.embeddingServiceStatus).toBe("up");
		// /api/health must be called exactly once with the override URL.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy).toHaveBeenCalledWith(
			"http://127.0.0.1:11435/api/health",
			expect.objectContaining({ signal: expect.any(Object) as unknown as AbortSignal }),
		);
	});

	it("status.embeddingServiceStatus === 'down' when probe=true and /api/health returns non-2xx", async () => {
		// Scenario: webui route passes embeddingServiceUrlProbe: true. The
		// bge-m3 service is up but /api/health reports 500. Surface "down"
		// so the UI can show "embedding service down" instead of "no
		// memory match" with no cause hint.
		globalThis.fetch = vi.fn(
			async () => new Response("boom", { status: 500 }),
		) as unknown as typeof fetch;

		const out = await recallPipeline(fakeIndex(), {
			query: "test",
			atomsDir: "/tmp/atoms",
			embeddingServiceUrlProbe: true,
		});

		expect(out.status.embeddingServiceStatus).toBe("down");
	});

	it("status.embeddingServiceStatus === 'down' when probe=true and fetch throws (network / abort)", async () => {
		// Scenario: bge-m3 service is down — fetch rejects before the 100ms
		// timeout OR the AbortController aborts after 100ms. Either way the
		// probe must catch and report "down" — never throw out of the
		// pipeline.
		globalThis.fetch = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;

		const out = await recallPipeline(fakeIndex(), {
			query: "test",
			atomsDir: "/tmp/atoms",
			embeddingServiceUrlProbe: true,
		});

		expect(out.status.embeddingServiceStatus).toBe("down");
	});

	it("status.embeddingServiceStatus stays undefined when embeddingServiceUrlProbe is omitted (TUI default)", async () => {
		// Scenario: TUI context hook calls recallPipeline without
		// embeddingServiceUrlProbe. The probe branch must be entirely
		// skipped — no fetch, no status field. Fetch is the strongest
		// assertion here: in the mocked test environment, fetch is only
		// called from the probe branch, so a successful assertion of
		// `not.toHaveBeenCalled()` proves the flag was honored.
		const fetchSpy = vi.fn(async () => {
			throw new Error("fetch should not be called when probe is omitted");
		}) as unknown as typeof fetch;
		globalThis.fetch = fetchSpy;

		const out = await recallPipeline(fakeIndex(), {
			query: "test",
			atomsDir: "/tmp/atoms",
		});

		expect(out.status.embeddingServiceStatus).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("status.embeddingServiceStatus stays undefined when embeddingServiceUrlProbe === false (TUI explicit false)", async () => {
		// Scenario: TUI passes probe=false explicitly. Same semantics as
		// omitted — the probe branch is gated by `=== true`, so false and
		// undefined are identical at the type level and at runtime.
		const fetchSpy = vi.fn(async () => {
			throw new Error("fetch should not be called when probe is false");
		}) as unknown as typeof fetch;
		globalThis.fetch = fetchSpy;

		const out = await recallPipeline(fakeIndex(), {
			query: "test",
			atomsDir: "/tmp/atoms",
			embeddingServiceUrlProbe: false,
		});

		expect(out.status.embeddingServiceStatus).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("uses http://127.0.0.1:11435 as probe URL when embeddingServiceUrl is omitted", async () => {
		// Default URL matches hybrid-search.ts:40 DEFAULT_EMBEDDING_SERVICE_URL
		// — same default the bge-m3 rerank service uses. Falls back when
		// the caller only sets probe=true without overriding the URL.
		const fetchSpy = vi.fn(
			async () => new Response("ok", { status: 200 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchSpy;

		await recallPipeline(fakeIndex(), {
			query: "test",
			atomsDir: "/tmp/atoms",
			embeddingServiceUrlProbe: true,
		});

		expect(fetchSpy).toHaveBeenCalledWith(
			"http://127.0.0.1:11435/api/health",
			expect.anything(),
		);
	});
});
