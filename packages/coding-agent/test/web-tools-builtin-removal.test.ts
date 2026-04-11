/**
 * Tests verifying web tools are removed from built-in tools (TDD)
 *
 * After the migration, web_search and web_fetch should:
 * - NOT be exported from src/core/tools/index.ts
 * - NOT be in the codingTools array
 * - NOT be in the allTools object
 * - NOT be in webTools group
 * - NOT be in createAllTools() output
 * - NOT be in createAllToolDefinitions() output
 */

import { describe, expect, it } from "vitest";

// These tests verify that built-in web tools have been REMOVED
// They will fail until the migration is complete

describe("web tools removed from built-in exports", () => {
	describe("index.ts exports", () => {
		it("should NOT export web_search from index.ts", async () => {
			const index = await import("../src/core/tools/index.js");

			// This should NOT exist anymore
			expect(index).not.toHaveProperty("webSearchTool");
			expect(index).not.toHaveProperty("web_search");
		});

		it("should NOT export web_fetch from index.ts", async () => {
			const index = await import("../src/core/tools/index.js");

			// This should NOT exist anymore
			expect(index).not.toHaveProperty("webFetchTool");
			expect(index).not.toHaveProperty("web_fetch");
		});

		it("should NOT export createWebSearchTool from index.ts", async () => {
			const index = await import("../src/core/tools/index.js");

			expect(index).not.toHaveProperty("createWebSearchTool");
		});

		it("should NOT export createWebFetchTool from index.ts", async () => {
			const index = await import("../src/core/tools/index.js");

			expect(index).not.toHaveProperty("createWebFetchTool");
		});

		it("should NOT export webTools group from index.ts", async () => {
			const index = await import("../src/core/tools/index.js");

			expect(index).not.toHaveProperty("webTools");
		});
	});

	describe("codingTools array", () => {
		it("should NOT include web_search in codingTools", async () => {
			const { codingTools } = await import("../src/core/tools/index.js");

			const toolNames = codingTools.map((t) => t.name);
			expect(toolNames).not.toContain("web_search");
		});

		it("should NOT include web_fetch in codingTools", async () => {
			const { codingTools } = await import("../src/core/tools/index.js");

			const toolNames = codingTools.map((t) => t.name);
			expect(toolNames).not.toContain("web_fetch");
		});
	});

	describe("allTools object", () => {
		it("should NOT have web_search in allTools", async () => {
			const { allTools } = await import("../src/core/tools/index.js");

			expect(allTools).not.toHaveProperty("web_search");
		});

		it("should NOT have web_fetch in allTools", async () => {
			const { allTools } = await import("../src/core/tools/index.js");

			expect(allTools).not.toHaveProperty("web_fetch");
		});
	});

	describe("allToolDefinitions object", () => {
		it("should NOT have web_search in allToolDefinitions", async () => {
			const { allToolDefinitions } = await import("../src/core/tools/index.js");

			expect(allToolDefinitions).not.toHaveProperty("web_search");
		});

		it("should NOT have web_fetch in allToolDefinitions", async () => {
			const { allToolDefinitions } = await import("../src/core/tools/index.js");

			expect(allToolDefinitions).not.toHaveProperty("web_fetch");
		});
	});

	describe("createAllTools function", () => {
		it("should NOT create web_search in createAllTools", async () => {
			const { createAllTools } = await import("../src/core/tools/index.js");

			const tools = createAllTools("/tmp");

			expect(tools).not.toHaveProperty("web_search");
		});

		it("should NOT create web_fetch in createAllTools", async () => {
			const { createAllTools } = await import("../src/core/tools/index.js");

			const tools = createAllTools("/tmp");

			expect(tools).not.toHaveProperty("web_fetch");
		});
	});

	describe("createAllToolDefinitions function", () => {
		it("should NOT create web_search in createAllToolDefinitions", async () => {
			const { createAllToolDefinitions } = await import("../src/core/tools/index.js");

			const definitions = createAllToolDefinitions("/tmp");

			expect(definitions).not.toHaveProperty("web_search");
		});

		it("should NOT create web_fetch in createAllToolDefinitions", async () => {
			const { createAllToolDefinitions } = await import("../src/core/tools/index.js");

			const definitions = createAllToolDefinitions("/tmp");

			expect(definitions).not.toHaveProperty("web_fetch");
		});
	});
});

describe("web tool source files removed", () => {
	it("should NOT import web-search module in index.ts", async () => {
		// This test verifies the import statement is gone
		// We check the exports don't exist, which implicitly means imports are gone
		const index = await import("../src/core/tools/index.js");

		expect(index).not.toHaveProperty("webSearchTool");
		expect(index).not.toHaveProperty("createWebSearchTool");
	});

	it("should NOT import web-fetch module in index.ts", async () => {
		const index = await import("../src/core/tools/index.js");

		expect(index).not.toHaveProperty("webFetchTool");
		expect(index).not.toHaveProperty("createWebFetchTool");
	});
});
