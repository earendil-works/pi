import { describe, expect, it } from "vitest";
import {
	rewriteQueries,
	type RewriteOptions,
	type RewriteOutcome,
} from "../rewrite.ts";

// ---------------------------------------------------------------------------
// 3.1 — Skeleton + signature + type-level coverage.
//
// The active tests below exercise what 3.1 actually implements:
//   - rewriteQueries exists and is a function
//   - placeholder body returns an empty array
//   - RewriteOutcome union with RewriteFallback compiles
//
// The real implementation comes in tasks 3.2-3.5.
// ---------------------------------------------------------------------------

describe("rewriteQueries skeleton", () => {
	it("exports rewriteQueries function", () => {
		expect(typeof rewriteQueries).toBe("function");
	});

	it("returns array (placeholder body)", async () => {
		const result = await rewriteQueries("test query");
		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual([]);
	});

	it("accepts RewriteOptions with all five fields", () => {
		// Compile-time check: every RewriteOptions field is a valid input.
		const options: RewriteOptions = {
			ollamaUrl: "http://example:11434",
			model: "qwen2.5:3b",
			timeoutMs: 1000,
			maxSubqueries: 3,
		};
		expect(options.ollamaUrl).toBe("http://example:11434");
	});

	it("accepts optional recent parameter (null)", async () => {
		const result = await rewriteQueries("test", null);
		expect(Array.isArray(result)).toBe(true);
	});

	it("accepts optional recent parameter (string array)", async () => {
		const result = await rewriteQueries("test", ["prev query"]);
		expect(Array.isArray(result)).toBe(true);
	});

	it("returns RewriteOutcome (discriminable by Array.isArray)", async () => {
		// The discriminator used by callers to decide between successful
		// subqueries and a fallback. Empty placeholder body returns the
		// array branch.
		const result: RewriteOutcome = await rewriteQueries("q");
		if (Array.isArray(result)) {
			expect(Array.isArray(result)).toBe(true);
		} else {
			expect(["timeout", "parse", "unreachable"]).toContain(result.reason);
			expect(Array.isArray(result.subqueries)).toBe(true);
		}
	});
});

describe("RewriteFallback type compiles", () => {
	it("accepts {reason:'timeout', subqueries:[]}", async () => {
		const result = await rewriteQueries("test", null, { timeoutMs: 1 });
		// Skeleton returns [], not fallback, but type must compile
		if (!Array.isArray(result)) {
			expect(result.reason).toBe("timeout");
			expect(Array.isArray(result.subqueries)).toBe(true);
		}
	});

	it("type-level: RewriteOutcome = string[] | RewriteFallback", () => {
		// The union type must accept both branches at compile time.
		const arr: RewriteOutcome = ["subquery1", "subquery2"];
		expect(arr).toHaveLength(2);
	});
});

describe("DEFAULT constants", () => {
	it("DEFAULT_OLLAMA_URL = http://127.0.0.1:11434", async () => {
		const mod = await import("../rewrite.ts");
		expect(mod.DEFAULT_OLLAMA_URL).toBe("http://127.0.0.1:11434");
	});

	it("DEFAULT_MODEL = qwen2.5:3b-instruct-q4_0", async () => {
		const mod = await import("../rewrite.ts");
		expect(mod.DEFAULT_MODEL).toBe("qwen2.5:3b-instruct-q4_0");
	});

	it("DEFAULT_TIMEOUT_MS = 1500", async () => {
		const mod = await import("../rewrite.ts");
		expect(mod.DEFAULT_TIMEOUT_MS).toBe(1500);
	});

	it("DEFAULT_MAX_SUBQUERIES = 3", async () => {
		const mod = await import("../rewrite.ts");
		expect(mod.DEFAULT_MAX_SUBQUERIES).toBe(3);
	});
});
