import { describe, expect, it, vi } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";

vi.mock("../src/core/tools/edit-diff.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/tools/edit-diff.ts")>();
	return {
		...original,
		generateEditDiff: () => {
			throw new Error("diff failed");
		},
	};
});

describe("edit tool diff before write", () => {
	it("should compute the diff before writing, so a diff failure leaves the file unchanged", async () => {
		const writeFile = vi.fn(async () => {});
		const tool = createEditTool(process.cwd(), {
			operations: {
				access: async () => {},
				readFile: async () => Buffer.from("a\nb\n"),
				writeFile,
			},
		});

		await expect(
			tool.execute("test-diff-before-write", { path: "f.txt", edits: [{ oldText: "b", newText: "B" }] }),
		).rejects.toThrow("diff failed");
		expect(writeFile).not.toHaveBeenCalled();
	});
});
