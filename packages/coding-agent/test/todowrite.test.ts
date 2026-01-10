import { beforeEach, describe, expect, it } from "vitest";
import { getTodos, resetTodosForTest, todowriteTool } from "../src/tools/todowrite.js";

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
			expect(textContent.text).toContain("○ [M] Pending task");
			expect(textContent.text).toContain("◐ [M] In progress task");
			expect(textContent.text).toContain("● [M] Completed task");
			// Should NOT contain IDs or JSON
			expect(textContent.text).not.toContain("todo_");
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
					{ content: "Cancelled", status: "cancelled" },
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
			cancelled: 1,
		});
	});
});
