/**
 * Red tests for TUI rendering of streaming output for edit/write tools.
 * These tests verify that ToolExecutionComponent correctly renders streaming output.
 *
 * Expected behavior:
 * - For edit tool: partialOutput with diff format should get syntax highlighting
 * - For write tool: partialOutput should show content with collapse behavior
 * - Streaming output appears BEFORE final result is available
 */

import { beforeEach, describe, expect, it } from "vitest";
import { initTheme } from "../src/theme/theme.js";
import { ToolExecutionComponent } from "../src/tui/tool-execution.js";

// Initialize theme before tests
beforeEach(() => {
	initTheme();
});

/**
 * Helper to render component and get plain text output.
 * Strips ANSI codes for easier assertions.
 */
function renderPlain(component: ToolExecutionComponent, width: number = 80): string {
	const lines = component.render(width);
	// Strip ANSI escape codes
	return lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
}

describe("ToolExecutionComponent streaming render", () => {
	describe("edit tool", () => {
		it("renders diff-colored streaming output for edit tool", () => {
			const component = new ToolExecutionComponent("edit", { path: "/src/hello.ts" });

			// Simulate streaming diff output
			const diffOutput = `  1 function hello() {
- 2   console.log("Hello, World!");
+ 2   console.log("Hello, Universe!");
  3   return 1;`;

			component.appendOutput(diffOutput + "\n");

			const rendered = renderPlain(component, 80);

			// Should show tool name and path
			expect(rendered).toContain("edit");
			expect(rendered).toContain("hello.ts");

			// Should show the streamed diff content
			expect(rendered).toContain("Hello, World!");
			expect(rendered).toContain("Hello, Universe!");
			expect(rendered).toContain("-"); // Removed line marker
			expect(rendered).toContain("+"); // Added line marker
		});

		it("applies diff syntax highlighting to streaming output", () => {
			const component = new ToolExecutionComponent("edit", { path: "/src/hello.ts" });

			const diffOutput = `- 1 old line
+ 1 new line`;

			component.appendOutput(diffOutput + "\n");

			// Get the raw rendered output with ANSI codes
			const lines = component.render(80);
			const renderedWithColors = lines.join("\n");

			// Lines starting with - should have red color (toolDiffRemoved)
			// Lines starting with + should have green color (toolDiffAdded)
			// We check that ANSI codes are present for colors
			expect(renderedWithColors).toMatch(/\x1b\[/); // Has some ANSI codes
		});

		it("shows streaming output before result is available", () => {
			const component = new ToolExecutionComponent("edit", { path: "/src/hello.ts" });

			// Before any streaming: should just show header
			let rendered = renderPlain(component, 80);
			expect(rendered).toContain("edit");
			expect(rendered).toContain("hello.ts");
			expect(rendered).not.toContain("Hello, World!"); // No content yet

			// After streaming starts: should show partial content
			component.appendOutput(`- 1 console.log("Hello, World!");\n`);
			rendered = renderPlain(component, 80);
			expect(rendered).toContain("Hello, World!");
		});

		it("clears streaming output when final result arrives", () => {
			const component = new ToolExecutionComponent("edit", { path: "/src/hello.ts" });

			// Stream some content
			component.appendOutput(`- 1 old line\n+ 1 new line\n`);

			// Final result arrives
			component.updateResult({
				content: [{ type: "text", text: "Successfully replaced text in /src/hello.ts." }],
				details: {
					diff: "  1 context\n- 2 old line\n+ 2 new line\n  3 context",
					path: "/src/hello.ts",
					oldText: "old line",
					newText: "new line",
					index: 10,
					newContentHash: "abc123",
				},
				isError: false,
			});

			const rendered = renderPlain(component, 80);

			// Should show final diff from result.details, not streaming output
			expect(rendered).toContain("context");
			expect(rendered).toContain("old line");
			expect(rendered).toContain("new line");
		});
	});

	describe("write tool", () => {
		it("renders streaming content for write tool", () => {
			const component = new ToolExecutionComponent("write", { path: "/src/newfile.ts" });

			// Simulate streaming content
			const content = `import { foo } from "./foo.js";

export function main() {
  foo();
}
`;
			component.appendOutput(content);

			const rendered = renderPlain(component, 80);

			// Should show tool name and path
			expect(rendered).toContain("write");
			expect(rendered).toContain("newfile.ts");

			// Should show the streamed content
			expect(rendered).toContain("import { foo }");
			expect(rendered).toContain("export function main");
		});

		it("shows streaming output before result is available", () => {
			const component = new ToolExecutionComponent("write", { path: "/src/newfile.ts" });

			// Before any streaming: should just show header
			let rendered = renderPlain(component, 80);
			expect(rendered).toContain("write");
			expect(rendered).not.toContain("import"); // No content yet

			// After streaming starts: should show partial content
			component.appendOutput(`import { foo } from "./foo.js";\n`);
			rendered = renderPlain(component, 80);
			expect(rendered).toContain("import { foo }");
		});

		it("collapses large streaming content in collapsed mode", () => {
			const component = new ToolExecutionComponent("write", { path: "/src/large.ts" });

			// Stream many lines
			const lines: string[] = [];
			for (let i = 1; i <= 50; i++) {
				lines.push(`// Line ${i}: This is line ${i} of the file`);
			}
			component.appendOutput(lines.join("\n") + "\n");

			const rendered = renderPlain(component, 80);

			// Should show first few lines
			expect(rendered).toContain("Line 1:");
			expect(rendered).toContain("Line 2:");

			// Should indicate more lines available (collapsed)
			expect(rendered).toMatch(/more lines|ctrl\+o/i);
		});

		it("expands to show all streaming content in expanded mode", () => {
			const component = new ToolExecutionComponent("write", { path: "/src/large.ts" });

			// Stream many lines
			const lines: string[] = [];
			for (let i = 1; i <= 20; i++) {
				lines.push(`// Line ${i}`);
			}
			component.appendOutput(lines.join("\n") + "\n");

			// Expand the view
			component.setExpanded(true);

			const rendered = renderPlain(component, 80);

			// Should show all lines
			for (let i = 1; i <= 20; i++) {
				expect(rendered).toContain(`Line ${i}`);
			}
		});

		it("clears streaming output when final result arrives", () => {
			const component = new ToolExecutionComponent("write", { path: "/src/newfile.ts" });

			// Stream some content
			component.appendOutput(`import { foo } from "./foo.js";\n`);

			// Final result arrives
			component.updateResult({
				content: [{ type: "text", text: "Successfully wrote 25 bytes to /src/newfile.ts" }],
				details: {
					path: "/src/newfile.ts",
					created: true,
					previousContent: null,
					newContentHash: "abc123",
				},
				isError: false,
			});

			const rendered = renderPlain(component, 80);

			// Should show success message, not streaming content
			expect(rendered).toContain("Successfully wrote");
		});
	});

	describe("general streaming behavior", () => {
		it("accumulates multiple appendOutput calls", () => {
			const component = new ToolExecutionComponent("edit", { path: "/src/file.ts" });

			// Stream in multiple chunks
			component.appendOutput("  1 context line\n");
			component.appendOutput("- 2 old line\n");
			component.appendOutput("+ 2 new line\n");

			const rendered = renderPlain(component, 80);

			// All chunks should be present
			expect(rendered).toContain("context line");
			expect(rendered).toContain("old line");
			expect(rendered).toContain("new line");
		});

		it("handles rapid consecutive streaming updates", () => {
			const component = new ToolExecutionComponent("write", { path: "/src/file.ts" });

			// Simulate rapid streaming (many quick updates)
			for (let i = 1; i <= 10; i++) {
				component.appendOutput(`line ${i}\n`);
			}

			const rendered = renderPlain(component, 80);

			// All lines should be accumulated
			for (let i = 1; i <= 10; i++) {
				expect(rendered).toContain(`line ${i}`);
			}
		});
	});
});
