import { beforeAll, describe, expect, it } from "vitest";
import { getTextOutput } from "../src/core/tools/render-utils.js";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.js";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { sanitizeBinaryOutput } from "../src/utils/shell.js";

function createTuiStub(): any {
	return {
		terminal: {
			columns: 120,
			rows: 24,
		},
		addInterval: (_cb: () => void, _ms: number) => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestRender: () => {},
	};
}

describe("large output guards", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("sanitizeBinaryOutput removes control, format, and lone surrogate characters", () => {
		const input = `a\u0000b\tc\nd\r🙂\uFFF9\uD800z`;

		expect(sanitizeBinaryOutput(input)).toBe("ab\tc\nd\r🙂z");
	});

	it("getTextOutput truncates oversized text for display", () => {
		const hugeText = "x".repeat(210_000);
		const output = getTextOutput(
			{
				content: [{ type: "text", text: hugeText }],
			},
			false,
		);

		expect(output).toContain("[display output truncated: too large]");
		expect(output.length).toBeLessThan(205_000);
		expect(output.startsWith("x")).toBe(true);
	});

	it("BashExecutionComponent keeps only a bounded streaming buffer", () => {
		const component = new BashExecutionComponent("printf test", createTuiStub());
		const largeChunk = `${"prefix-".repeat(20_000)}TAIL_MARKER`;

		component.appendOutput(largeChunk);
		component.setComplete(0, false);

		expect(component.getOutput()).toContain("TAIL_MARKER");
		expect(Buffer.byteLength(component.getOutput(), "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES * 2);
		expect(component.render(80).length).toBeGreaterThan(0);
	});
});
