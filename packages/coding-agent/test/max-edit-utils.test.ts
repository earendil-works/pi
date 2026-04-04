import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyPreparedOperations,
	parseProposalOutput,
	parseSelectorChoice,
	validateAndPrepareOperations,
} from "../examples/extensions/max-edit/utils.js";

describe("max-edit utils", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("parses proposal tool results from pi json output", () => {
		const stdout = [
			JSON.stringify({
				type: "tool_result_end",
				message: {
					toolName: "propose_edit",
					details: { kind: "edit", path: "src/app.ts", oldText: "a", newText: "b" },
				},
			}),
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Candidate summary" }],
				},
			}),
		].join("\n");

		const parsed = parseProposalOutput(stdout);

		expect(parsed.summary).toBe("Candidate summary");
		expect(parsed.proposals).toEqual([{ kind: "edit", path: "src/app.ts", oldText: "a", newText: "b" }]);
	});

	it("validates and applies exact edit proposals atomically", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-max-edit-"));
		tempDirs.push(tempDir);
		const filePath = join(tempDir, "app.ts");
		writeFileSync(filePath, "const value = 1;\n", "utf-8");

		const prepared = validateAndPrepareOperations(tempDir, [
			{
				kind: "edit" as const,
				path: "app.ts",
				oldText: "const value = 1;",
				newText: "const value = 2;",
			},
		]);

		applyPreparedOperations(prepared);
		expect(readFileSync(filePath, "utf-8")).toContain("const value = 2;");
	});

	it("parses selector json into a zero-based choice", () => {
		const choice = parseSelectorChoice('{"index": 2, "reason": "best tradeoff"}', 3);

		expect(choice).toEqual({
			candidateIndex: 1,
			reason: "best tradeoff",
		});
	});
});
