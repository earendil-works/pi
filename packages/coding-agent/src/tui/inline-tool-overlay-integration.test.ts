import { beforeEach, describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import type { TodoWriteToolDetails } from "../tools/todowrite.js";
import { InlineToolOverlayComponent } from "./inline-tool-overlay.js";

describe("InlineToolOverlayComponent integration", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	it("should update with todo_write result", () => {
		const component = new InlineToolOverlayComponent("todo_write", {
			todos: [{ id: "todo_1", content: "Read README", status: "in_progress", priority: "high" }],
		});

		const result = {
			content: [
				{ type: "text" as const, text: "[in_progress] Read README\n[pending] Another task\n[completed] Done task" },
			],
			isError: false,
			details: {
				todos: [{ id: "todo_1", content: "Read README", status: "in_progress", priority: "high" }],
				summary: { total: 1, pending: 0, inProgress: 1, completed: 0, blocked: 0 },
				mu_display: {
					version: 1,
					call: {
						style: "argv" as const,
						text: "todo_write set --items 1",
						command: "todo_write",
						argv: ["set", "--items", "1"],
					},
					summary: {
						text: "1 in_progress · 0 pending · 0 completed · 0 blocked",
						severity: "info" as const,
					},
					output: {
						collapse: {
							maxVisualLines: 1,
							expandHint: "esc to dismiss",
						},
					},
				},
			} as TodoWriteToolDetails,
		};

		component.updateResult(result);

		const lines = component.render(80);
		const text = lines.join("\n");

		expect(text).toContain("todo_write");
		expect(text).toContain("in_progress");
		// Hint shows when content is truncated
		expect(text).toContain("esc to dismiss");
	});

	it("should be dismissible and stay dismissed", () => {
		const component = new InlineToolOverlayComponent("todo_write", {});

		component.updateResult({
			content: [{ type: "text" as const, text: "Some output" }],
			isError: false,
			details: {
				todos: [],
				summary: { total: 0, pending: 0, inProgress: 0, completed: 0, blocked: 0 },
				mu_display: {
					version: 1,
					call: { style: "argv" as const, text: "todo_write", command: "todo_write", argv: [] },
					summary: { text: "No todos", severity: "info" as const },
					output: { collapse: { maxVisualLines: 3, expandHint: "esc to dismiss" } },
				},
			} as TodoWriteToolDetails,
		});

		// Should render before dismiss
		expect(component.render(80).length).toBeGreaterThan(0);
		expect(component.isDismissed()).toBe(false);

		// Dismiss
		component.dismiss();

		// Should be dismissed and render empty
		expect(component.isDismissed()).toBe(true);
		expect(component.render(80).length).toBe(0);

		// Updating result after dismiss should not re-show
		component.updateResult({
			content: [{ type: "text" as const, text: "New output" }],
			isError: false,
			details: {
				todos: [],
				summary: { total: 0, pending: 0, inProgress: 0, completed: 0, blocked: 0 },
				mu_display: {
					version: 1,
					call: { style: "argv" as const, text: "todo_write", command: "todo_write", argv: [] },
					summary: { text: "Still dismissed", severity: "info" as const },
					output: { collapse: { maxVisualLines: 3, expandHint: "esc to dismiss" } },
				},
			} as TodoWriteToolDetails,
		});

		expect(component.isDismissed()).toBe(true);
		expect(component.render(80).length).toBe(0);
	});

	it("should expand and collapse", () => {
		const component = new InlineToolOverlayComponent("todo_write", {});

		component.updateResult({
			content: [{ type: "text" as const, text: Array(10).fill("line").join("\n") }],
			isError: false,
			details: {
				todos: [],
				summary: { total: 0, pending: 0, inProgress: 0, completed: 0, blocked: 0 },
				mu_display: {
					version: 1,
					call: { style: "argv" as const, text: "todo_write", command: "todo_write", argv: [] },
					summary: { text: "Summary", severity: "info" as const },
					output: { collapse: { maxVisualLines: 2, expandHint: "esc to dismiss" } },
				},
			} as TodoWriteToolDetails,
		});

		// Initially collapsed
		expect(component.isExpanded()).toBe(false);
		const collapsedLines = component.render(80).length;

		// Expand
		component.setExpanded(true);
		expect(component.isExpanded()).toBe(true);
		const expandedLines = component.render(80).length;

		// Expanded should show more lines
		expect(expandedLines).toBeGreaterThan(collapsedLines);

		// Collapse again
		component.setExpanded(false);
		expect(component.isExpanded()).toBe(false);
		expect(component.render(80).length).toBe(collapsedLines);
	});

	it("should hide system_reminder tags from display", () => {
		const component = new InlineToolOverlayComponent("todo_write", {});

		component.updateResult({
			content: [
				{
					type: "text" as const,
					text: '[pending] Task 1\n\n<system_reminder pending="1" in_progress="0">Continue now.</system_reminder>',
				},
			],
			isError: false,
			details: {
				todos: [{ id: "todo_1", content: "Task 1", status: "pending", priority: "medium" }],
				summary: { total: 1, pending: 1, inProgress: 0, completed: 0, blocked: 0 },
				mu_display: {
					version: 1,
					call: { style: "argv" as const, text: "todo_write", command: "todo_write", argv: [] },
					summary: { text: "Summary", severity: "info" as const },
					output: { collapse: { maxVisualLines: 5, expandHint: "esc to dismiss" } },
				},
			} as TodoWriteToolDetails,
		});

		const text = component.render(80).join("\n");

		// Should show the task but not the system_reminder
		expect(text).toContain("Task 1");
		expect(text).not.toContain("system_reminder");
		expect(text).not.toContain("Continue now");
	});

	it("does not show completed todo lines in the inline overlay", () => {
		const component = new InlineToolOverlayComponent("todo_write", {});

		component.updateResult({
			content: [
				{
					type: "text" as const,
					text: "[in_progress] Active task\n[completed] Finished task\n[blocked] Waiting task",
				},
			],
			isError: false,
			details: {
				todos: [
					{ id: "todo_1", content: "Active task", status: "in_progress", priority: "medium" },
					{ id: "todo_2", content: "Finished task", status: "completed", priority: "medium" },
					{ id: "todo_3", content: "Waiting task", status: "blocked", priority: "medium" },
				],
				summary: { total: 3, pending: 0, inProgress: 1, completed: 1, blocked: 1 },
				mu_display: {
					version: 1,
					call: { style: "argv" as const, text: "todo_write", command: "todo_write", argv: [] },
					summary: { text: "1 in_progress · 0 pending · 1 completed · 1 blocked", severity: "info" as const },
					output: { collapse: { maxVisualLines: 5, expandHint: "esc to dismiss" } },
				},
			} as TodoWriteToolDetails,
		});

		const text = component.render(80).join("\n");
		expect(text).toContain("Active task");
		expect(text).toContain("Waiting task");
		expect(text).not.toContain("Finished task");
		expect(text).not.toContain("[completed]");
	});

	it("auto-dismisses when every todo is completed", () => {
		const component = new InlineToolOverlayComponent("todo_write", {});

		component.updateResult({
			content: [{ type: "text" as const, text: "[completed] Done task" }],
			isError: false,
			details: {
				todos: [{ id: "todo_1", content: "Done task", status: "completed", priority: "medium" }],
				summary: { total: 1, pending: 0, inProgress: 0, completed: 1, blocked: 0 },
				mu_display: {
					version: 1,
					call: { style: "argv" as const, text: "todo_write", command: "todo_write", argv: [] },
					summary: { text: "0 in_progress · 0 pending · 1 completed · 0 blocked", severity: "info" as const },
					output: { collapse: { maxVisualLines: 5, expandHint: "esc to dismiss" } },
				},
			} as TodoWriteToolDetails,
		});

		expect(component.isDismissed()).toBe(true);
		expect(component.render(80)).toHaveLength(0);
	});
});
