import { describe, expect, it } from "vitest";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../../src/core/tools/edit.ts";
import { createWriteToolDefinition } from "../../src/core/tools/write.ts";

const cwd = "/test";

describe("tool prepareArguments sanitization", () => {
	describe("edit tool", () => {
		const tool = createEditToolDefinition(cwd);

		it("strips frontmatter fields from root level", () => {
			const prepared = tool.prepareArguments!({
				title: "My File — PRD",
				path: "/test/file.md",
				edits: [{ oldText: "hello", newText: "world" }],
			}) as Record<string, unknown>;
			expect(prepared).not.toHaveProperty("title");
			expect(prepared).toHaveProperty("path", "/test/file.md");
			expect(prepared).toHaveProperty("edits");
		});

		it("strips multiple leaked frontmatter keys", () => {
			const prepared = tool.prepareArguments!({
				title: "Doc",
				tags: "foo,bar",
				status: "active",
				type: "product",
				ftypes: "product",
				description: "A note",
				path: "/test/file.md",
				edits: [{ oldText: "a", newText: "b" }],
			}) as Record<string, unknown>;
			expect(prepared).not.toHaveProperty("title");
			expect(prepared).not.toHaveProperty("tags");
			expect(prepared).not.toHaveProperty("status");
			expect(prepared).not.toHaveProperty("type");
			expect(prepared).not.toHaveProperty("ftypes");
			expect(prepared).not.toHaveProperty("description");
			expect(prepared).toHaveProperty("path", "/test/file.md");
		});

		it("parses stringified edits", () => {
			const edits = JSON.stringify([{ oldText: "a", newText: "b" }]);
			const prepared = tool.prepareArguments!({
				path: "/test/file.md",
				edits,
			}) as Record<string, unknown>;
			expect(Array.isArray(prepared.edits)).toBe(true);
			expect((prepared.edits as Array<Record<string, unknown>>)[0]).toMatchObject({
				oldText: "a",
				newText: "b",
			});
		});

		it("recovers from malformed JSON with unescaped newlines", () => {
			// Simulate a model embedding literal newlines in JSON string values
			const malformed = '[{"oldText":"line1","newText":"line1\\nline2"}]';
			const prepared = tool.prepareArguments!({
				path: "/test/file.md",
				edits: malformed,
			}) as Record<string, unknown>;
			expect(Array.isArray(prepared.edits)).toBe(true);
			expect((prepared.edits as Array<Record<string, unknown>>)[0]).toHaveProperty("newText");
		});

		it("strips frontmatter keys from within parsed edits elements", () => {
			const edits = JSON.stringify([
				{ oldText: "a", newText: "b" },
				{ oldText: "x", newText: "y", title: "Leaked Title", ftypes: "product" },
			]);
			const prepared = tool.prepareArguments!({
				path: "/test/file.md",
				edits,
			}) as Record<string, unknown>;
			const editsArr = prepared.edits as Array<Record<string, unknown>>;
			expect(editsArr[1]).not.toHaveProperty("title");
			expect(editsArr[1]).not.toHaveProperty("ftypes");
			expect(editsArr[1]).toHaveProperty("oldText", "x");
			expect(editsArr[1]).toHaveProperty("newText", "y");
		});

		it("passes clean args through unchanged", () => {
			const input = { path: "/test/file.md", edits: [{ oldText: "a", newText: "b" }] };
			const prepared = tool.prepareArguments!(input) as Record<string, unknown>;
			expect(prepared).toHaveProperty("path", "/test/file.md");
			expect(Array.isArray(prepared.edits)).toBe(true);
		});
	});

	describe("write tool", () => {
		const tool = createWriteToolDefinition(cwd);

		it("strips frontmatter fields from root level", () => {
			const prepared = tool.prepareArguments!({
				title: "My Doc",
				path: "/test/file.md",
				content: "# Hello",
			}) as Record<string, unknown>;
			expect(prepared).not.toHaveProperty("title");
			expect(prepared).toHaveProperty("path", "/test/file.md");
			expect(prepared).toHaveProperty("content", "# Hello");
		});

		it("passes clean args through unchanged", () => {
			const input = { path: "/test/file.md", content: "# Hello" };
			const prepared = tool.prepareArguments!(input) as Record<string, unknown>;
			expect(prepared).toEqual(input);
		});
	});

	describe("bash tool", () => {
		const tool = createBashToolDefinition(cwd);

		it("strips frontmatter fields from root level", () => {
			const prepared = tool.prepareArguments!({
				title: "Script",
				status: "active",
				command: "echo hi",
			}) as Record<string, unknown>;
			expect(prepared).not.toHaveProperty("title");
			expect(prepared).not.toHaveProperty("status");
			expect(prepared).toHaveProperty("command", "echo hi");
		});

		it("passes clean args through unchanged", () => {
			const input = { command: "ls -la" };
			const prepared = tool.prepareArguments!(input) as Record<string, unknown>;
			expect(prepared).toEqual(input);
		});

		it("passes timeout through when present", () => {
			const prepared = tool.prepareArguments!({
				title: "Timed Script",
				command: "sleep 10",
				timeout: 5,
			}) as Record<string, unknown>;
			expect(prepared).not.toHaveProperty("title");
			expect(prepared).toHaveProperty("command", "sleep 10");
			expect(prepared).toHaveProperty("timeout", 5);
		});
	});
});
