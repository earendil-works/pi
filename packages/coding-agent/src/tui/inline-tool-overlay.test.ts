import { beforeEach, describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import type { TodoWriteToolDetails } from "../tools/todowrite.js";
import { InlineToolOverlayComponent } from "./inline-tool-overlay.js";

describe("InlineToolOverlayComponent", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	it("should render todo_write call with compact formatting", () => {
		const component = new InlineToolOverlayComponent("todo_write", {
			todos: [{ id: "todo_1", content: "Read README", status: "pending", priority: "high" }],
		});

		component.updateResult({
			content: [{ type: "text", text: "[pending] Read README" }],
			isError: false,
			details: {
				todos: [{ id: "todo_1", content: "Read README", status: "pending", priority: "high" }],
				summary: { total: 1, pending: 1, inProgress: 0, completed: 0, blocked: 0 },
				mu_display: {
					version: 1,
					call: {
						style: "argv",
						text: "todo_write set --items 1",
						command: "todo_write",
						argv: ["set", "--items", "1"],
					},
					summary: {
						text: "0 in_progress · 1 pending · 0 completed · 0 blocked",
						severity: "info",
					},
					output: {
						collapse: {
							maxVisualLines: 3,
							expandHint: "esc to dismiss",
						},
					},
				},
			} as TodoWriteToolDetails,
		});

		const lines = component.render(80);
		const text = lines.join("\n");

		// Should show the tool name and summary
		expect(text).toContain("todo_write");
		expect(text).toContain("in_progress");
		expect(text).toContain("pending");

		// Should be compact (limited height)
		expect(lines.length).toBeLessThanOrEqual(5);
	});

	it("should handle collapsed state by default", () => {
		const component = new InlineToolOverlayComponent("todo_write", {});

		const longOutput = Array(20).fill("line").join("\n");
		component.updateResult({
			content: [{ type: "text", text: longOutput }],
			isError: false,
			details: {
				todos: [],
				summary: { total: 0, pending: 0, inProgress: 0, completed: 0, blocked: 0 },
				mu_display: {
					version: 1,
					call: { style: "argv", text: "todo_write", command: "todo_write", argv: [] },
					summary: { text: "No todos", severity: "info" },
					output: {
						collapse: { maxVisualLines: 3, expandHint: "esc to dismiss" },
					},
				},
			} as TodoWriteToolDetails,
		});

		const lines = component.render(80);

		// Should be collapsed (limited lines)
		expect(lines.length).toBeLessThanOrEqual(6);
	});

	it("should expand when expand() is called", () => {
		const component = new InlineToolOverlayComponent("todo_write", {});

		const longOutput = Array(20).fill("line content here").join("\n");
		component.updateResult({
			content: [{ type: "text", text: longOutput }],
			isError: false,
			details: {
				todos: [],
				summary: { total: 0, pending: 0, inProgress: 0, completed: 0, blocked: 0 },
				mu_display: {
					version: 1,
					call: { style: "argv", text: "todo_write", command: "todo_write", argv: [] },
					summary: { text: "No todos", severity: "info" },
					output: {
						collapse: { maxVisualLines: 3, expandHint: "esc to dismiss" },
					},
				},
			} as TodoWriteToolDetails,
		});

		// Initially collapsed
		const collapsedLines = component.render(80);
		expect(collapsedLines.length).toBeLessThanOrEqual(6);

		// Expand
		component.setExpanded(true);
		const expandedLines = component.render(80);

		// Should show more content when expanded
		expect(expandedLines.length).toBeGreaterThan(collapsedLines.length);
	});

	it("should be dismissable via dismiss()", () => {
		const component = new InlineToolOverlayComponent("todo_write", {});

		expect(component.isDismissed()).toBe(false);

		component.dismiss();

		expect(component.isDismissed()).toBe(true);

		// Render after dismiss should return empty
		const lines = component.render(80);
		expect(lines.length).toBe(0);
	});

	it("should handle tool output expansion hint", () => {
		const component = new InlineToolOverlayComponent("todo_write", {});

		component.updateResult({
			content: [{ type: "text", text: "Output line 1\nOutput line 2\nOutput line 3\nOutput line 4" }],
			isError: false,
			details: {
				todos: [],
				summary: { total: 0, pending: 0, inProgress: 0, completed: 0, blocked: 0 },
				mu_display: {
					version: 1,
					call: { style: "argv", text: "todo_write", command: "todo_write", argv: [] },
					summary: { text: "Summary here", severity: "info" },
					output: {
						collapse: { maxVisualLines: 2, expandHint: "esc to dismiss" },
					},
				},
			} as TodoWriteToolDetails,
		});

		const lines = component.render(80);
		const text = lines.join("\n");

		// Should show expansion hint
		expect(text).toContain("esc to dismiss");
	});
});
