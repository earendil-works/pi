import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFindToolDefinition } from "../../../src/core/tools/find.ts";

const describeOnWindows = process.platform === "win32" ? describe : describe.skip;

describeOnWindows("issue #6104 find from a bare Windows drive root", () => {
	async function runFind(searchRoot: string, resultPath: string): Promise<string> {
		const def = createFindToolDefinition(searchRoot, {
			operations: {
				exists: () => true,
				glob: () => [resultPath],
			},
		});
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute("call-1", { pattern: "*", path: searchRoot }, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
		};
		return result.content[0]?.text?.trim() ?? "";
	}

	it("preserves the first path segment and a single directory slash", async () => {
		const driveRoot = path.parse(process.cwd()).root;
		const resultPath = `${path.join(driveRoot, "AI", "Models", "TextGen", "gemma4")}${path.sep}`;

		await expect(runFind(driveRoot, resultPath)).resolves.toBe("AI/Models/TextGen/gemma4/");
	});
});
