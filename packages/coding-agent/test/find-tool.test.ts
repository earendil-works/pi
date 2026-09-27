import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindToolDefinition } from "../src/core/tools/find.ts";

function getTextOutput(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n") ?? ""
	);
}

describe("find tool — directoryOnly parameter", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-find-dir-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		// Create a flat structure for predictable results
		mkdirSync(join(tempDir, "subdir1"), { recursive: true });
		mkdirSync(join(tempDir, "subdir2"), { recursive: true });
		writeFileSync(join(tempDir, "file1.txt"), "content1");
		writeFileSync(join(tempDir, "file2.md"), "content2");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("returns all entries (files + directories) when directoryOnly is false or omitted", async () => {
		const toolDef = createFindToolDefinition(tempDir);
		const result = await toolDef.execute("test-id", { pattern: "*", path: tempDir }, undefined, undefined, {} as any);
		const output = getTextOutput(result);
		const entries = output.split("\n").filter(Boolean);

		expect(entries).toContain("file1.txt");
		expect(entries).toContain("file2.md");
		// fd appends trailing slash to directory names in all modes
		expect(entries).toContain("subdir1/");
		expect(entries).toContain("subdir2/");
	});

	it("returns only directories when directoryOnly is true", async () => {
		const toolDef = createFindToolDefinition(tempDir);
		const result = await toolDef.execute(
			"test-id",
			{ pattern: "*", path: tempDir, directoryOnly: true },
			undefined,
			undefined,
			{} as any,
		);
		const output = getTextOutput(result);
		const entries = output.split("\n").filter(Boolean);

		expect(entries).toContain("subdir1/");
		expect(entries).toContain("subdir2/");

		// Should NOT contain files
		expect(entries).not.toContain("file1.txt");
		expect(entries).not.toContain("file2.md");
	});

	it("returns only directories when directoryOnly is true with specific glob", async () => {
		const toolDef = createFindToolDefinition(tempDir);
		const result = await toolDef.execute(
			"test-id",
			{ pattern: "subdir*", path: tempDir, directoryOnly: true },
			undefined,
			undefined,
			{} as any,
		);
		const output = getTextOutput(result);
		const entries = output.split("\n").filter(Boolean);

		expect(entries).toContain("subdir1/");
		expect(entries).toContain("subdir2/");
	});

	it("returns empty when no directories match", async () => {
		const toolDef = createFindToolDefinition(tempDir);
		const result = await toolDef.execute(
			"test-id",
			{ pattern: "*.nonexistent", path: tempDir, directoryOnly: true },
			undefined,
			undefined,
			{} as any,
		);
		const output = getTextOutput(result);

		expect(output).toBe("No files found matching pattern");
	});

	it("respects limit with directoryOnly", async () => {
		const toolDef = createFindToolDefinition(tempDir);
		const result = await toolDef.execute(
			"test-id",
			{ pattern: "*", path: tempDir, directoryOnly: true, limit: 1 },
			undefined,
			undefined,
			{} as any,
		);
		const output = getTextOutput(result);

		expect(output).toContain("1 results limit reached");
	});

	it("directoryOnly=false explicitly returns files and directories", async () => {
		const toolDef = createFindToolDefinition(tempDir);
		const result = await toolDef.execute(
			"test-id",
			{ pattern: "*", path: tempDir, directoryOnly: false },
			undefined,
			undefined,
			{} as any,
		);
		const output = getTextOutput(result);
		const entries = output.split("\n").filter(Boolean);

		expect(entries).toContain("file1.txt");
		expect(entries).toContain("file2.md");
		expect(entries).toContain("subdir1/");
		expect(entries).toContain("subdir2/");
	});
});
