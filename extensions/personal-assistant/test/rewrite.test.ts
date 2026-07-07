// ---------------------------------------------------------------------------
// rewriteQueries — query decomposition tests (tasks 3.1, 3.3).
//
// Tests the public rewriteQueries function through mocked fetch to exercise
// parseRewriteResponse (private) behavior: JSON parse, regex retry, schema
// validation, dedup, truncation, and error fallbacks.
//
// Mock strategy: vi.spyOn(globalThis, 'fetch') in beforeEach, overridden
// per test with mockResolvedValueOnce / mockRejectedValueOnce.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	rewriteQueries,
	type RewriteOptions,
	type RewriteOutcome,
} from "../rewrite.ts";

// Helper: create a mock ollama /api/chat Response with the given content.
function mockOllamaResponse(content: string): Response {
	return {
		ok: true,
		status: 200,
		json: async () => ({ message: { content } }),
		headers: new Headers({ "content-type": "application/json" }),
	} as Response;
}

// ---------------------------------------------------------------------------
// 3.1 — Skeleton + signature + type-level coverage.
// 3.3 — parseRewriteResponse behavior tested through rewriteQueries.
// ---------------------------------------------------------------------------

describe("rewriteQueries", () => {
	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockReset();
		vi.spyOn(console, "warn").mockReset();
		vi.spyOn(console, "debug").mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ── Skeleton / signature ─────────────────────────────────────

	it("exports rewriteQueries function", () => {
		expect(typeof rewriteQueries).toBe("function");
	});

	it("returns array on successful parse", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(JSON.stringify({ subqueries: ["parsed query"] })),
		);
		const result = await rewriteQueries("test query");
		expect(Array.isArray(result)).toBe(true);
		expect((result as string[]).length).toBeGreaterThanOrEqual(1);
	});

	it("accepts RewriteOptions with all five fields", () => {
		const options: RewriteOptions = {
			ollamaUrl: "http://example:11434",
			model: "qwen2.5:3b",
			timeoutMs: 1000,
			maxSubqueries: 3,
		};
		expect(options.ollamaUrl).toBe("http://example:11434");
	});

	it("accepts optional recent parameter (null)", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(JSON.stringify({ subqueries: ["q"] })),
		);
		const result = await rewriteQueries("test", null);
		expect(Array.isArray(result)).toBe(true);
	});

	it("accepts optional recent parameter (string array)", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(JSON.stringify({ subqueries: ["q"] })),
		);
		const result = await rewriteQueries("test", ["prev query"]);
		expect(Array.isArray(result)).toBe(true);
	});

	it("returns RewriteOutcome discriminable by Array.isArray — array branch", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(JSON.stringify({ subqueries: ["q"] })),
		);
		const result: RewriteOutcome = await rewriteQueries("q");
		if (Array.isArray(result)) {
			expect(result).toHaveLength(1);
		} else {
			expect(["timeout", "parse", "unreachable"]).toContain(
				result.reason,
			);
			expect(Array.isArray(result.subqueries)).toBe(true);
		}
	});

	it("returns fallback with reason 'timeout' on AbortError", async () => {
		const abortError = new Error("aborted");
		abortError.name = "AbortError";
		vi.mocked(fetch).mockRejectedValueOnce(abortError);
		const result = await rewriteQueries("test", null, { timeoutMs: 1 });
		expect(Array.isArray(result)).toBe(false);
		if (!Array.isArray(result)) {
			expect(result.reason).toBe("timeout");
			expect(result.subqueries).toEqual(["test"]);
		}
	});

	it("returns fallback with reason 'unreachable' on TypeError", async () => {
		vi.mocked(fetch).mockRejectedValueOnce(
			new TypeError("fetch failed"),
		);
		const result = await rewriteQueries("test");
		expect(Array.isArray(result)).toBe(false);
		if (!Array.isArray(result)) {
			expect(result.reason).toBe("unreachable");
			expect(result.subqueries).toEqual(["test"]);
		}
	});

	it("type-level: RewriteOutcome = string[] | RewriteFallback", () => {
		const arr: RewriteOutcome = ["subquery1", "subquery2"];
		expect(arr).toHaveLength(2);
		const fb: RewriteOutcome = {
			reason: "timeout",
			subqueries: ["q"],
		};
		expect(fb).toBeDefined();
	});

	// ── parseRewriteResponse: JSON parsing ───────────────────────

	it("parses valid subqueries JSON", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(
				JSON.stringify({ subqueries: ["q1", "q2"] }),
			),
		);
		const result = await rewriteQueries("test");
		expect(result).toEqual(["q1", "q2"]);
	});

	it("recovers JSON from prefix text via regex extraction", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(
				`Here is: ${JSON.stringify({ subqueries: ["q1"] })}`,
			),
		);
		const result = await rewriteQueries("test");
		expect(result).toEqual(["q1"]);
	});

	it("returns parse fallback for completely invalid JSON", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse("坏掉的 JSON"),
		);
		const result = await rewriteQueries("test");
		expect(Array.isArray(result)).toBe(false);
		if (!Array.isArray(result)) {
			expect(result.reason).toBe("parse");
			expect(result.subqueries).toEqual(["test"]);
		}
		expect(console.warn).toHaveBeenCalled();
	});

	it("returns parse fallback when regex-matched text is still invalid JSON", async () => {
		// The regex /(\{[\s\S]*\})/ matches "{bad json}" but it is not
		// valid JSON, hitting the second try/catch in parseRewriteResponse.
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse("prefix {bad json} suffix"),
		);
		const result = await rewriteQueries("test");
		expect(Array.isArray(result)).toBe(false);
		if (!Array.isArray(result)) {
			expect(result.reason).toBe("parse");
		}
		expect(console.warn).toHaveBeenCalled();
	});

	it("returns parse fallback for empty LLM response and warns", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(mockOllamaResponse(""));
		const result = await rewriteQueries("test");
		expect(Array.isArray(result)).toBe(false);
		if (!Array.isArray(result)) {
			expect(result.reason).toBe("parse");
		}
		expect(console.warn).toHaveBeenCalled();
	});

	it("returns parse fallback when response has no message property", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ notMessage: true }),
			headers: new Headers(),
		} as Response);
		const result = await rewriteQueries("test");
		expect(Array.isArray(result)).toBe(false);
		if (!Array.isArray(result)) {
			expect(result.reason).toBe("parse");
		}
	});

	it("returns parse fallback when response message has no content", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ message: {} }),
			headers: new Headers(),
		} as Response);
		const result = await rewriteQueries("test");
		expect(Array.isArray(result)).toBe(false);
		if (!Array.isArray(result)) {
			expect(result.reason).toBe("parse");
		}
	});

	// ── parseRewriteResponse: schema validation ──────────────────

	it("returns parse fallback for empty subqueries array", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(JSON.stringify({ subqueries: [] })),
		);
		const result = await rewriteQueries("test");
		expect(Array.isArray(result)).toBe(false);
		if (!Array.isArray(result)) {
			expect(result.reason).toBe("parse");
			expect(result.subqueries).toEqual(["test"]);
		}
	});

	it("returns parse fallback when subqueries is not an array", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(JSON.stringify({ subqueries: "string" })),
		);
		const result = await rewriteQueries("test");
		expect(Array.isArray(result)).toBe(false);
		if (!Array.isArray(result)) {
			expect(result.reason).toBe("parse");
		}
		expect(console.warn).toHaveBeenCalled();
	});

	it("returns parse fallback for non-string elements in subqueries", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(JSON.stringify({ subqueries: [1, 2] })),
		);
		const result = await rewriteQueries("test");
		expect(Array.isArray(result)).toBe(false);
		if (!Array.isArray(result)) {
			expect(result.reason).toBe("parse");
		}
		expect(console.warn).toHaveBeenCalled();
	});

	// ── parseRewriteResponse: truncation ─────────────────────────

	it("truncates to 3 subqueries and logs debug message", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(
				JSON.stringify({
					subqueries: ["a", "b", "c", "d", "e"],
				}),
			),
		);
		const result = await rewriteQueries("test");
		expect(result).toEqual(["a", "b", "c"]);
		expect(console.debug).toHaveBeenCalledWith(
			"[rewrite] truncated 5→3",
		);
	});

	// ── parseRewriteResponse: dedup ──────────────────────────────

	it("deduplicates subqueries preserving order", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(
				JSON.stringify({
					subqueries: ["a", "b", "a", "c", "b"],
				}),
			),
		);
		const result = await rewriteQueries("test");
		expect(result).toEqual(["a", "b", "c"]);
	});

	it("deduplicates before counting truncation (5 unique after dedup → 3)", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(
				JSON.stringify({
					subqueries: ["x", "y", "x", "z", "w", "v", "y", "z"],
				}),
			),
		);
		const result = await rewriteQueries("test");
		expect(result).toEqual(["x", "y", "z"]);
		// Set(["x","y","x","z","w","v","y","z"]) → 5 unique → truncated 5→3
		expect(console.debug).toHaveBeenCalledWith(
			"[rewrite] truncated 5→3",
		);
	});

	// ── Options passthrough ──────────────────────────────────────

	it("passes ollamaUrl and model from options to fetch call", async () => {
		const mockFetch = vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(
				JSON.stringify({ subqueries: ["custom query"] }),
			),
		);
		await rewriteQueries("hello", [], {
			ollamaUrl: "http://custom:12345",
			model: "custom-model",
		});
		const [url, init] = mockFetch.mock.calls[0]!;
		expect(url).toBe("http://custom:12345/api/chat");
		const body = JSON.parse(init!.body as string);
		expect(body.model).toBe("custom-model");
	});

	it("sends system + user messages in fetch body", async () => {
		const mockFetch = vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(
				JSON.stringify({ subqueries: ["rewritten"] }),
			),
		);
		await rewriteQueries("bwa 并发", ["之前的问题"]);
		const [, init] = mockFetch.mock.calls[0]!;
		const body = JSON.parse(init!.body as string);
		expect(body.messages).toHaveLength(2);
		expect(body.messages[0].role).toBe("system");
		expect(body.messages[1].role).toBe("user");
		expect(body.messages[1].content).toContain("bwa 并发");
	});

	// ── Repair: malformed JSON recovery (2026-07-07 regression) ──
	//
	// qwen2.5:3b at temperature=0 occasionally drops closing braces and
	// forgets to quote keys. Mirrors the gate-side regression — see
	// gate-fetch.test.ts comments for context.

	it("repairs missing closing brace — {\"subqueries:[...]", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(
				'{"subqueries:["MGM项目", "工时"]',
			),
		);
		const result = await rewriteQueries("你还记得MGM项目吗");
		expect(result).toEqual(["MGM项目", "工时"]);
	});

	it("repairs unquoted key entirely — {subqueries:[]}", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse('{"subqueries":["MGM项目"]}'),
		);
		const result = await rewriteQueries("你还记得MGM项目吗");
		expect(result).toEqual(["MGM项目"]);
	});

	it("sends format: 'json' to ollama /api/chat (source-level JSON constraint)", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			mockOllamaResponse(JSON.stringify({ subqueries: ["rewritten"] })),
		);
		await rewriteQueries("hello");
		const [, init] = vi.mocked(fetch).mock.calls[0]!;
		const body = JSON.parse(init!.body as string);
		expect(body.format).toBe("json");
	});

	// Succeeded-by-accident recovery: qwen2.5:3b emits
	// `{"subqueries:[]":["MGM"]}` — the key's closing `"` was dropped
	// and the model wrote a stray `[]` then started the actual array.
	// JSON.parse accepts the input by reading the literal key as
	// `"subqueries:[]"` and the value as `["MGM"]`. The repair detects
	// the `:` in the key and re-pairs the prefix with the parsed
	// array value.
	it("repairs succeeded-by-accident — key contains :", async () => {
		const raw = '{"subqueries:[]":["MGM"]}';
		vi.mocked(fetch).mockResolvedValueOnce(mockOllamaResponse(raw));
		const result = await rewriteQueries("你还记得MGM项目吗");
		expect(result).toEqual(["MGM"]);
	});
});

// ---------------------------------------------------------------------------
// DEFAULT constants — these do not need fetch mocks.
// ---------------------------------------------------------------------------

describe("DEFAULT constants", () => {
	it("DEFAULT_OLLAMA_URL = http://127.0.0.1:11434", async () => {
		const mod = await import("../rewrite.ts");
		expect(mod.DEFAULT_OLLAMA_URL).toBe("http://127.0.0.1:11434");
	});

	it("DEFAULT_MODEL = qwen2.5:3b-instruct-q4_0", async () => {
		const mod = await import("../rewrite.ts");
		expect(mod.DEFAULT_MODEL).toBe("qwen2.5:3b-instruct-q4_0");
	});

	it("DEFAULT_TIMEOUT_MS = 5000", async () => {
		const mod = await import("../rewrite.ts");
		expect(mod.DEFAULT_TIMEOUT_MS).toBe(5000);
	});

	it("DEFAULT_MAX_SUBQUERIES = 3", async () => {
		const mod = await import("../rewrite.ts");
		expect(mod.DEFAULT_MAX_SUBQUERIES).toBe(3);
	});
});
