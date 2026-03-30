import { beforeEach, describe, expect, it } from "vitest";
import { formatTodosForHandoff, getTodos, resetTodosForTest, todowriteTool } from "../src/tools/todowrite.js";

describe("todowrite tool", () => {
	beforeEach(() => {
		resetTodosForTest();
	});

	it("assigns ids when missing", async () => {
		const result = await todowriteTool.execute(
			"call-1",
			{
				todos: [
					{ content: "First task", status: "pending" },
					{ content: "Second task", status: "pending" },
				],
			},
			undefined,
			undefined,
		);

		const todos = getTodos();
		expect(todos).toHaveLength(2);
		expect(todos[0].id).toBe("todo_1");
		expect(todos[1].id).toBe("todo_2");
		expect(result.details?.todos).toEqual(todos);
	});

	it("preserves provided ids", async () => {
		await todowriteTool.execute(
			"call-1",
			{
				todos: [
					{ id: "my-custom-id", content: "Custom task", status: "pending" },
					{ content: "Auto id task", status: "pending" },
				],
			},
			undefined,
			undefined,
		);

		const todos = getTodos();
		expect(todos[0].id).toBe("my-custom-id");
		expect(todos[1].id).toBe("todo_1");
	});

	it("defaults priority to medium", async () => {
		await todowriteTool.execute(
			"call-1",
			{
				todos: [
					{ content: "No priority", status: "pending" },
					{ content: "High priority", status: "pending", priority: "high" },
				],
			},
			undefined,
			undefined,
		);

		const todos = getTodos();
		expect(todos[0].priority).toBe("medium");
		expect(todos[1].priority).toBe("high");
	});

	it("rejects when two todos are in_progress", async () => {
		await expect(
			todowriteTool.execute(
				"call-1",
				{
					todos: [
						{ content: "Task 1", status: "in_progress" },
						{ content: "Task 2", status: "in_progress" },
					],
				},
				undefined,
				undefined,
			),
		).rejects.toThrow("Only one todo can be in_progress at a time");
	});

	it("rejects duplicate ids", async () => {
		await expect(
			todowriteTool.execute(
				"call-1",
				{
					todos: [
						{ id: "same-id", content: "Task 1", status: "pending" },
						{ id: "same-id", content: "Task 2", status: "pending" },
					],
				},
				undefined,
				undefined,
			),
		).rejects.toThrow('Duplicate todo id: "same-id"');
	});

	it("rejects empty content", async () => {
		await expect(
			todowriteTool.execute(
				"call-1",
				{
					todos: [{ id: "empty", content: "   ", status: "pending" }],
				},
				undefined,
				undefined,
			),
		).rejects.toThrow('Todo item "empty" has empty content');
	});

	it("replaces entire list on each call", async () => {
		// First call
		await todowriteTool.execute(
			"call-1",
			{
				todos: [
					{ id: "a", content: "Task A", status: "pending" },
					{ id: "b", content: "Task B", status: "pending" },
				],
			},
			undefined,
			undefined,
		);

		expect(getTodos()).toHaveLength(2);

		// Second call replaces
		await todowriteTool.execute(
			"call-2",
			{
				todos: [{ id: "c", content: "Task C", status: "completed" }],
			},
			undefined,
			undefined,
		);

		const todos = getTodos();
		expect(todos).toHaveLength(1);
		expect(todos[0].id).toBe("c");
	});

	it("returns formatted checklist in content", async () => {
		const result = await todowriteTool.execute(
			"call-1",
			{
				todos: [
					{ content: "Pending task", status: "pending" },
					{ content: "In progress task", status: "in_progress" },
					{ content: "Completed task", status: "completed" },
				],
			},
			undefined,
			undefined,
		);

		const textContent = result.content[0];
		expect(textContent.type).toBe("text");
		if (textContent.type === "text") {
			expect(textContent.text).toContain("[pending] [medium] Pending task");
			expect(textContent.text).toContain("[in_progress] [medium] In progress task");
			expect(textContent.text).toContain("[completed] [medium] Completed task");
			// Should NOT contain IDs or JSON
			expect(textContent.text).not.toMatch(/todo_\\d+/);
			expect(textContent.text).not.toContain("{");
		}
	});

	it("provides summary counts in details", async () => {
		const result = await todowriteTool.execute(
			"call-1",
			{
				todos: [
					{ content: "Pending 1", status: "pending" },
					{ content: "Pending 2", status: "pending" },
					{ content: "Done", status: "completed" },
					{ content: "Blocked", status: "blocked" },
				],
			},
			undefined,
			undefined,
		);

		expect(result.details?.summary).toEqual({
			total: 4,
			pending: 2,
			inProgress: 0,
			completed: 1,
			blocked: 1,
		});
	});

	it("returns mu_display metadata for concise TUI rendering", async () => {
		const result = await todowriteTool.execute(
			"call-1",
			{
				todos: [
					{ content: "Pending 1", status: "pending" },
					{ content: "In progress", status: "in_progress" },
					{ content: "Done", status: "completed" },
					{ content: "Blocked", status: "blocked" },
				],
			},
			undefined,
			undefined,
		);

		const details = result.details as
			| {
					mu_display?: {
						version?: number;
						call?: { text?: string };
						summary?: { text?: string };
						output?: { collapse?: { maxVisualLines?: number } };
					};
			  }
			| undefined;

		expect(details?.mu_display?.version).toBe(1);
		expect(details?.mu_display?.call?.text).toContain("todo_write");
		expect(details?.mu_display?.summary?.text).toContain("1 in_progress");
		expect(details?.mu_display?.summary?.text).toContain("1 pending");
		expect(details?.mu_display?.summary?.text).toContain("1 completed");
		expect(details?.mu_display?.summary?.text).toContain("1 blocked");
		expect(details?.mu_display?.output?.collapse?.maxVisualLines).toBe(5);
	});

	it("does not embed system_reminder in the tool result content", async () => {
		const result = await todowriteTool.execute(
			"call-1",
			{
				todos: [
					{ content: "Pending 1", status: "pending" },
					{ content: "In progress", status: "in_progress" },
				],
			},
			undefined,
			undefined,
		);

		const textContent = result.content[0];
		expect(textContent.type).toBe("text");
		if (textContent.type === "text") {
			expect(textContent.text).not.toContain("<system_reminder");
		}
	});
});

describe("formatTodosForHandoff", () => {
	beforeEach(() => {
		resetTodosForTest();
	});

	it("returns null when no todos exist", () => {
		expect(formatTodosForHandoff()).toBeNull();
	});

	it("formats pending and in_progress items with markdown checkboxes", async () => {
		await todowriteTool.execute(
			"call-1",
			{
				todos: [
					{ content: "Implement login", status: "in_progress", priority: "high" },
					{ content: "Add tests", status: "pending", priority: "medium" },
					{ content: "Update docs", status: "pending", priority: "low" },
				],
			},
			undefined,
			undefined,
		);

		const result = formatTodosForHandoff();
		expect(result).not.toBeNull();
		expect(result).toContain("## Active Tasks");
		expect(result).toContain("- [ ] [high] Implement login (in_progress)");
		expect(result).toContain("- [ ] [medium] Add tests");
		expect(result).toContain("- [ ] [low] Update docs");
		// pending items should NOT have status suffix
		expect(result).not.toContain("Add tests (pending)");
	});

	it("excludes completed and blocked items from checklist but shows summary", async () => {
		await todowriteTool.execute(
			"call-1",
			{
				todos: [
					{ content: "Active task", status: "pending" },
					{ content: "Done task", status: "completed" },
					{ content: "Blocked task", status: "blocked" },
				],
			},
			undefined,
			undefined,
		);

		const result = formatTodosForHandoff();
		expect(result).not.toBeNull();
		expect(result).toContain("- [ ] [medium] Active task");
		expect(result).not.toContain("Done task");
		expect(result).not.toContain("Blocked task");
		expect(result).toContain("*1 completed, 1 blocked*");
	});

	it("shows 'no active tasks' message when only completed/blocked exist", async () => {
		await todowriteTool.execute(
			"call-1",
			{
				todos: [
					{ content: "Done 1", status: "completed" },
					{ content: "Done 2", status: "completed" },
					{ content: "Blocked 1", status: "blocked" },
				],
			},
			undefined,
			undefined,
		);

		const result = formatTodosForHandoff();
		expect(result).not.toBeNull();
		expect(result).toContain("*No active tasks remaining.*");
		expect(result).toContain("*2 completed, 1 blocked*");
	});

	it("omits summary line when no completed/blocked items", async () => {
		await todowriteTool.execute(
			"call-1",
			{
				todos: [{ content: "Only pending", status: "pending" }],
			},
			undefined,
			undefined,
		);

		const result = formatTodosForHandoff();
		expect(result).not.toBeNull();
		expect(result).toContain("- [ ] [medium] Only pending");
		expect(result).not.toContain("completed");
		expect(result).not.toContain("blocked");
	});

	it("handles only completed count in summary", async () => {
		await todowriteTool.execute(
			"call-1",
			{
				todos: [
					{ content: "Active", status: "pending" },
					{ content: "Done", status: "completed" },
				],
			},
			undefined,
			undefined,
		);

		const result = formatTodosForHandoff();
		expect(result).toContain("*1 completed*");
		expect(result).not.toContain("cancelled");
	});

	it("handles only blocked count in summary", async () => {
		await todowriteTool.execute(
			"call-1",
			{
				todos: [
					{ content: "Active", status: "pending" },
					{ content: "Blocked", status: "blocked" },
				],
			},
			undefined,
			undefined,
		);

		const result = formatTodosForHandoff();
		expect(result).toContain("*1 blocked*");
		expect(result).not.toContain("completed");
	});
});
