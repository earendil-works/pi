import { describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";

describe("read pagination", () => {
	const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
	const tool = createReadTool(process.cwd(), {
		operations: {
			access: async () => {},
			readFile: async () => Buffer.from(lines.join("\n")),
		},
	});

	// Regression: https://github.com/earendil-works/pi/issues/10380
	it.each([
		{ limit: -90, offset: undefined, firstLine: 1, lastLine: 1 },
		{ limit: 0, offset: undefined, firstLine: 1, lastLine: 1 },
		{ limit: 0.5, offset: undefined, firstLine: 1, lastLine: 1 },
		{ limit: 10.5, offset: undefined, firstLine: 1, lastLine: 10 },
		{ limit: 10, offset: undefined, firstLine: 1, lastLine: 10 },
		{ limit: -90, offset: 41, firstLine: 41, lastLine: 41 },
		{ limit: 10, offset: 41.5, firstLine: 41, lastLine: 50 },
		{ limit: 10.5, offset: 41.5, firstLine: 41, lastLine: 50 },
		{ limit: 10, offset: -5, firstLine: 1, lastLine: 10 },
		{ limit: 10, offset: 0, firstLine: 1, lastLine: 10 },
		{ limit: 10, offset: 0.5, firstLine: 1, lastLine: 10 },
	])(
		"keeps pagination consistent for limit=$limit, offset=$offset",
		async ({ limit, offset, firstLine, lastLine }) => {
			const result = await tool.execute("first-page", { path: "lines.txt", offset, limit });
			const expectedText = lines.slice(firstLine - 1, lastLine).join("\n");
			const notice = `[${100 - lastLine} more lines in file. Use offset=${lastLine + 1} to continue.]`;
			expect(result.content).toEqual([{ type: "text", text: `${expectedText}\n\n${notice}` }]);
			expect(result.structuredContent).toBe(`${expectedText}\n\n${notice}`);

			const rest = await tool.execute("next-page", { path: "lines.txt", offset: lastLine + 1 });
			expect(rest.content).toEqual([{ type: "text", text: lines.slice(lastLine).join("\n") }]);
		},
	);

	it("stops at the end of the file without a continuation notice", async () => {
		const result = await tool.execute("last-page", { path: "lines.txt", offset: 95.5, limit: 10.5 });
		expect(result.content).toEqual([{ type: "text", text: lines.slice(94).join("\n") }]);
	});

	it("normalizes the offset when no limit is supplied", async () => {
		const result = await tool.execute("remaining-lines", { path: "lines.txt", offset: 95.5 });
		expect(result.content).toEqual([{ type: "text", text: lines.slice(94).join("\n") }]);
	});
});
