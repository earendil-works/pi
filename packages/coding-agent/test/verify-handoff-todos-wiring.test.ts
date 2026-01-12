/**
 * Verification: Handoff todos wiring is correctly set up.
 *
 * This test verifies that:
 * 1. formatTodosForHandoff is exported from todowrite.ts
 * 2. The function signature matches expected contract
 * 3. tui-renderer.ts can import the function (verified at compile time)
 *
 * Note: We cannot directly test generateHandoffDraft() because it:
 * - Is a private method on TUIRenderer class
 * - Requires LLM API calls
 * - Requires full TUI initialization
 *
 * The actual integration is verified by:
 * - TypeScript compilation (import works)
 * - Manual testing (run pi, create todos, trigger handoff)
 */

import { describe, expect, it } from "vitest";
import { formatTodosForHandoff } from "../src/tools/todowrite.js";

describe("handoff todos wiring verification", () => {
	it("formatTodosForHandoff is exported and callable", () => {
		expect(typeof formatTodosForHandoff).toBe("function");
	});

	it("formatTodosForHandoff returns string | null", () => {
		const result = formatTodosForHandoff();
		expect(result === null || typeof result === "string").toBe(true);
	});

	it("formatTodosForHandoff takes no parameters", () => {
		expect(formatTodosForHandoff.length).toBe(0);
	});
});

describe("formatTodosForHandoff output contract", () => {
	it("returns null for empty state (verified by type)", () => {
		// This is a type-level contract: null means "no section to add"
		const result = formatTodosForHandoff();
		expect(result).toBeNull();
	});

	it("when non-null, starts with markdown header", async () => {
		// Import execute to set up state
		const { todowriteTool, resetTodosForTest } = await import("../src/tools/todowrite.js");
		resetTodosForTest();

		await todowriteTool.execute("test", { todos: [{ content: "Test", status: "pending" }] }, undefined, undefined);

		const result = formatTodosForHandoff();
		expect(result).not.toBeNull();
		expect(result!.startsWith("## Active Tasks")).toBe(true);

		resetTodosForTest();
	});

	it("output is valid markdown (no HTML, no JSON)", async () => {
		const { todowriteTool, resetTodosForTest } = await import("../src/tools/todowrite.js");
		resetTodosForTest();

		await todowriteTool.execute(
			"test",
			{
				todos: [
					{ content: "Task 1", status: "pending", priority: "high" },
					{ content: "Task 2", status: "in_progress" },
					{ content: "Task 3", status: "completed" },
				],
			},
			undefined,
			undefined,
		);

		const result = formatTodosForHandoff()!;

		// No HTML tags
		expect(result).not.toMatch(/<[a-z]+>/i);
		// No JSON braces (except in content which we control)
		expect(result).not.toMatch(/^\s*\{/m);
		expect(result).not.toMatch(/^\s*\[(?!\s*[x\s]\])/m); // Allow [ ] checkboxes
		// Has markdown list syntax
		expect(result).toMatch(/^- \[ \]/m);

		resetTodosForTest();
	});
});
