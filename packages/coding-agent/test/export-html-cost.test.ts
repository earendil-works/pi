import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type ExportStats = {
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
};

describe("export HTML cost", () => {
	it("uses recorded totals while falling back to component sums for old sessions", () => {
		// Regression test for #9980: provider-reported totals may differ from catalog-estimated components.
		const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
		const functionStart = templateJs.indexOf("function computeStats(entryList)");
		const functionEnd = templateJs.indexOf("const globalStats = computeStats(entries);");
		expect(functionStart).toBeGreaterThanOrEqual(0);
		expect(functionEnd).toBeGreaterThan(functionStart);

		const context: { result?: ExportStats } = {};
		runInNewContext(
			`${templateJs.slice(functionStart, functionEnd)}
			result = computeStats(${JSON.stringify([
				{
					type: "message",
					message: {
						role: "assistant",
						content: [],
						usage: { cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.9 } },
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						content: [],
						usage: { cost: { input: 0.4, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
					},
				},
			])});`,
			context,
		);

		expect(context.result?.cost.input).toBeCloseTo(0.5);
		expect(context.result?.cost.output).toBeCloseTo(0.3);
		expect(context.result?.cost.total).toBeCloseTo(1.4);
	});
});
