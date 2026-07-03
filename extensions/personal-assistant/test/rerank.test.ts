import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	rerankAndFilter,
	type RerankOptions,
	type RerankFallback,
	type RerankFallbackReason,
} from "../rerank.ts";
import type { MemoryAtom, RecallResult } from "../types.ts";

let originalFetch: typeof fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function makeHit(id: string, overrides?: Partial<MemoryAtom>): RecallResult {
	return {
		atom: {
			id,
			type: "fact",
			title: "Test title",
			summary: "Test summary",
			content: "",
			tags: ["test"],
			importance: 0.5,
			strength: 0.5,
			access_count: 0,
			version: 1,
			is_latest: 1,
			parent_id: null,
			superseded_at: null,
			archived: 0,
			created_at: 0,
			updated_at: 0,
			last_access: null,
			content_fingerprint: "abc",
			source_session: null,
			...overrides,
		},
		cosine: 0.9,
		sparseScore: 0.8,
		rrf: 0.5,
	};
}

// ---------------------------------------------------------------------------
// 3.1 — Skeleton + signature + type-level coverage.
//
// The active tests below exercise what 3.1 actually implements:
//   - rerankAndFilter exists and is a function
//   - placeholder body returns an empty array
//   - RerankFallback union with all four reason values compiles
//
// The `it.todo` placeholders mark the R1-R7 scenarios that 3.2 and 3.3 will
// fill in. They exist now so the file structure is stable and the next two
// tasks can target specific describe blocks without reshuffling.
// ---------------------------------------------------------------------------

describe("rerankAndFilter skeleton", () => {
	it("exports rerankAndFilter function", () => {
		expect(typeof rerankAndFilter).toBe("function");
	});

	it("returns array (placeholder body)", async () => {
		const result = await rerankAndFilter("q", [], {});
		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual([]);
	});

	it("accepts RerankOptions with all four fields", async () => {
		// Compile-time check: every RerankOptions field is a valid input.
		const options: RerankOptions = {
			serviceUrl: "http://example",
			timeoutMs: 100,
			threshold: 0.3,
			gap: 0.1,
		};
		expect(options.serviceUrl).toBe("http://example");
	});

	it("returns [] when hits is empty (short-circuits before fetch)", async () => {
		const result = await rerankAndFilter("test query", []);
		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual([]);
	});

	it("returns RecallResult[] | RerankFallback (discriminable by Array.isArray)", async () => {
		// The discriminator used by task 5.2 to decide between
		// threshold-filtered hits and a fallback. Empty placeholder body
		// is the array branch; a populated {reason,topK} would be the
		// fallback branch (filled in 3.2).
		const result = await rerankAndFilter("q", [], {});
		if (Array.isArray(result)) {
			expect(Array.isArray(result)).toBe(true);
		} else {
			const reason: RerankFallbackReason = result.reason;
			expect(["timeout", "http-error", "shape-mismatch", "unreachable"]).toContain(reason);
		}
	});
});

describe("RerankFallback type compiles", () => {
	it("accepts {reason:'timeout', topK:[]}", () => {
		const f: RerankFallback = { reason: "timeout", topK: [] };
		expect(f.reason).toBe("timeout");
	});

	it("accepts {reason:'http-error'|'shape-mismatch'|'unreachable'}", () => {
		const a: RerankFallback = { reason: "http-error", topK: [] };
		const b: RerankFallback = { reason: "shape-mismatch", topK: [] };
		const c: RerankFallback = { reason: "unreachable", topK: [] };
		expect([a.reason, b.reason, c.reason]).toHaveLength(3);
	});

	it("topK carries RecallResult[]", () => {
		const hits: RecallResult[] = [];
		const f: RerankFallback = { reason: "unreachable", topK: hits };
		expect(f.topK).toBe(hits);
	});
});

function mockSuccessResponse(scores: Array<{ id: string; score: number }>) {
	globalThis.fetch = vi.fn(
		async () =>
			new Response(JSON.stringify({ scores }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
	) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// R1 — happy path (3.2 fills body)
// 3.2 implements the fetch + 200-shape branch; 3.3 adds threshold + gap.
// ---------------------------------------------------------------------------
describe("R1 — rerank happy path", () => {
	it("returns hits reordered by rerank score when server responds 200", async () => {
		// Server returns scores in a different order than hits; mapping by id
		// must still produce the correct DESC sort.
		// Gaps between consecutive scores are < 0.15 to avoid gap cutoff.
		const scores = [
			{ id: "c", score: 0.82 },
			{ id: "a", score: 0.92 },
			{ id: "b", score: 0.85 },
		];
		mockSuccessResponse(scores);
		const hits = ["a", "b", "c"].map((id) => makeHit(id));
		const result = await rerankAndFilter("test query", hits);
		expect(Array.isArray(result)).toBe(true);
		const arr = result as RecallResult[];
		expect(arr).toHaveLength(3);
		expect(arr[0].atom.id).toBe("a");
		expect(arr[1].atom.id).toBe("b");
		expect(arr[2].atom.id).toBe("c");
	});

	it("attaches rerankScore to each returned hit", async () => {
		const scores = [
			{ id: "x", score: 0.88 },
			{ id: "y", score: 0.76 },
		];
		mockSuccessResponse(scores);
		const hits = [makeHit("x"), makeHit("y")];
		const result = await rerankAndFilter("test query", hits);
		expect(Array.isArray(result)).toBe(true);
		const arr = result as RecallResult[];
		expect(arr[0].rerankScore).toBe(0.88);
		expect(arr[1].rerankScore).toBe(0.76);
	});

	it("threshold + gap: cuts at first gap > 0.15", async () => {
		// R1 scenario: [0.92,0.85,0.55,0.32,0.21,0.18,0.15,0.10]
		// threshold >= 0.5 keeps [0.92,0.85,0.55]; gap at 0.85->0.55 (0.30 > 0.15)
		// returns [0.92, 0.85]
		const scores = [
			{ id: "1", score: 0.92 },
			{ id: "2", score: 0.85 },
			{ id: "3", score: 0.55 },
			{ id: "4", score: 0.32 },
			{ id: "5", score: 0.21 },
			{ id: "6", score: 0.18 },
			{ id: "7", score: 0.15 },
			{ id: "8", score: 0.10 },
		];
		mockSuccessResponse(scores);
		const hits = ["1", "2", "3", "4", "5", "6", "7", "8"].map((id) => makeHit(id));
		const result = await rerankAndFilter("test query", hits);
		expect(Array.isArray(result)).toBe(true);
		const arr = result as RecallResult[];
		expect(arr).toHaveLength(2);
		expect(arr[0].atom.id).toBe("1");
		expect(arr[0].rerankScore).toBe(0.92);
		expect(arr[1].atom.id).toBe("2");
		expect(arr[1].rerankScore).toBe(0.85);
	});
});

// ---------------------------------------------------------------------------
// R2 — partial filter (3.2 + 3.3 fill body)
// 3.2 implements fetch; 3.3 implements threshold/gap filter.
// ---------------------------------------------------------------------------
describe("R2 — threshold drops low-score hits", () => {
	it("threshold + gap: keeps above-threshold hits then cuts at gap", async () => {
		// R2 scenario: [0.92,0.85,0.55,0.52,0.51,0.50,0.30,0.28]
		// threshold >= 0.5 keeps [0.92,0.85,0.55,0.52,0.51,0.50]
		// gap at 0.85->0.55 (0.30 > 0.15) returns [0.92,0.85]
		const scores = [
			{ id: "1", score: 0.92 },
			{ id: "2", score: 0.85 },
			{ id: "3", score: 0.55 },
			{ id: "4", score: 0.52 },
			{ id: "5", score: 0.51 },
			{ id: "6", score: 0.50 },
			{ id: "7", score: 0.30 },
			{ id: "8", score: 0.28 },
		];
		mockSuccessResponse(scores);
		const hits = ["1", "2", "3", "4", "5", "6", "7", "8"].map((id) => makeHit(id));
		const result = await rerankAndFilter("test query", hits);
		expect(Array.isArray(result)).toBe(true);
		const arr = result as RecallResult[];
		expect(arr).toHaveLength(2);
		expect(arr[0].atom.id).toBe("1");
		expect(arr[1].atom.id).toBe("2");
	});

	it("keeps all hits when all above threshold and no gap found", async () => {
		const scores = [
			{ id: "a", score: 0.90 },
			{ id: "b", score: 0.85 },
			{ id: "c", score: 0.82 },
			{ id: "d", score: 0.80 },
		];
		mockSuccessResponse(scores);
		const hits = ["a", "b", "c", "d"].map((id) => makeHit(id));
		const result = await rerankAndFilter("test query", hits);
		expect(Array.isArray(result)).toBe(true);
		const arr = result as RecallResult[];
		expect(arr).toHaveLength(4);
	});
});

// ---------------------------------------------------------------------------
// R3 — all below threshold (3.3 fills body)
// 3.3 implements the threshold filter producing the empty array.
// ---------------------------------------------------------------------------
describe("R3 — all hits below threshold", () => {
	it("returns [] when every rerank score is below threshold", async () => {
		// R3 scenario: [0.48,0.45,0.42,0.30] all < 0.5 => return []
		const scores = [
			{ id: "1", score: 0.48 },
			{ id: "2", score: 0.45 },
			{ id: "3", score: 0.42 },
			{ id: "4", score: 0.30 },
		];
		mockSuccessResponse(scores);
		const hits = ["1", "2", "3", "4"].map((id) => makeHit(id));
		const result = await rerankAndFilter("test query", hits);
		expect(Array.isArray(result)).toBe(true);
		expect(result).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// R7 + tie — threshold + gap edge cases (3.3 fills body)
// ---------------------------------------------------------------------------
describe("threshold + gap edge cases", () => {
	it("single element: returns it when threshold passes", async () => {
		// R7: [0.7] >= 0.5, no gap to detect => return [0.7]
		const scores = [{ id: "1", score: 0.7 }];
		mockSuccessResponse(scores);
		const hits = [makeHit("1")];
		const result = await rerankAndFilter("test query", hits);
		expect(Array.isArray(result)).toBe(true);
		const arr = result as RecallResult[];
		expect(arr).toHaveLength(1);
		expect(arr[0].atom.id).toBe("1");
		expect(arr[0].rerankScore).toBe(0.7);
	});

	it("tie scores: returns both ordered by rrf DESC", async () => {
		// Two hits both score 0.55; different rrf => both pass threshold,
		// no gap (0.55-0.55=0 <= 0.15), sorted by rrf DESC.
		const scores = [
			{ id: "a", score: 0.55 },
			{ id: "b", score: 0.55 },
		];
		mockSuccessResponse(scores);
		const hits: RecallResult[] = [
			{ ...makeHit("a", { title: "A" }), rrf: 0.3 },
			{ ...makeHit("b", { title: "B" }), rrf: 0.8 },
		];
		const result = await rerankAndFilter("test query", hits);
		expect(Array.isArray(result)).toBe(true);
		const arr = result as RecallResult[];
		expect(arr).toHaveLength(2);
		// rrf DESC: b (0.8) before a (0.3)
		expect(arr[0].atom.id).toBe("b");
		expect(arr[0].rerankScore).toBe(0.55);
		expect(arr[1].atom.id).toBe("a");
		expect(arr[1].rerankScore).toBe(0.55);
	});
});

// ---------------------------------------------------------------------------
// R4 — timeout fallback (3.2 fills body)
// 3.2 wires AbortController + timeoutMs to produce a fallback.
// ---------------------------------------------------------------------------
describe("R4 — rerank timeout fallback", () => {
	it("returns {reason:'timeout', topK:RRF top-K} on AbortError", async () => {
		let observedAbort = false;
		globalThis.fetch = vi.fn(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (signal) {
						if (signal.aborted) {
							observedAbort = true;
							reject(new DOMException("aborted", "AbortError"));
							return;
						}
						signal.addEventListener("abort", () => {
							observedAbort = true;
							reject(new DOMException("aborted", "AbortError"));
						});
					}
				}),
		) as unknown as typeof fetch;

		const hits = [makeHit("1"), makeHit("2"), makeHit("3"), makeHit("4")];
		const result = await rerankAndFilter("test query", hits, { timeoutMs: 50 });
		expect(observedAbort).toBe(true);
		expect(Array.isArray(result)).toBe(false);
		const fb = result as RerankFallback;
		expect(fb.reason).toBe("timeout");
		expect(fb.topK).toHaveLength(3);
		expect(fb.topK[0].atom.id).toBe("1");
	});

	it.todo("does not retry on timeout");
	it.todo("emits fallback within timeoutMs + small slack");
	it.todo("uses DEFAULT_TIMEOUT_MS = 500 when not specified");
});

// ---------------------------------------------------------------------------
// R5 — service unreachable / http-error fallback (3.2 fills body)
// 3.2 distinguishes 404 / 503 / connection refused from the body shape.
// ---------------------------------------------------------------------------
describe("R5 — rerank service unavailable fallback", () => {
	it("returns {reason:'unreachable'} on fetch network error", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof fetch;

		const hits = [makeHit("1"), makeHit("2"), makeHit("3")];
		const result = await rerankAndFilter("test query", hits);
		expect(Array.isArray(result)).toBe(false);
		const fb = result as RerankFallback;
		expect(fb.reason).toBe("unreachable");
		expect(fb.topK).toHaveLength(3);
	});

	it("returns {reason:'http-error'} on 404 / 503", async () => {
		// 404
		globalThis.fetch = vi.fn(
			async () => new Response("Not Found", { status: 404 }),
		) as unknown as typeof fetch;
		let hits = [makeHit("a"), makeHit("b"), makeHit("c")];
		let result = await rerankAndFilter("test", hits);
		expect(Array.isArray(result)).toBe(false);
		let fb = result as RerankFallback;
		expect(fb.reason).toBe("http-error");
		expect(fb.topK).toHaveLength(3);

		// 503
		globalThis.fetch = vi.fn(
			async () => new Response("Service Unavailable", { status: 503 }),
		) as unknown as typeof fetch;
		result = await rerankAndFilter("test", hits);
		expect(Array.isArray(result)).toBe(false);
		fb = result as RerankFallback;
		expect(fb.reason).toBe("http-error");
		expect(fb.topK).toHaveLength(3);
	});

	it("returns {reason:'shape-mismatch'} on malformed response body", async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ scores: [{ id: "1", score: 0.9 }] }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		) as unknown as typeof fetch;

		// 3 hits but only 1 score entry -> shape-mismatch
		const hits = [makeHit("1"), makeHit("2"), makeHit("3")];
		const result = await rerankAndFilter("test query", hits);
		expect(Array.isArray(result)).toBe(false);
		const fb = result as RerankFallback;
		expect(fb.reason).toBe("shape-mismatch");
		expect(fb.topK).toHaveLength(3);
	});
});
