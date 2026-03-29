/**
 * Integration tests verifying the relationship between todowrite operations
 * and handoff functionality.
 *
 * Tests the dependency chain:
 *   todowriteTool.execute() → module state → getTodos() → formatTodosForHandoff()
 *
 * These tests verify:
 * 1. O1 ← O2: formatTodosForHandoff reads from getTodos
 * 2. O3 → O2: execute writes state that getTodos reads
 * 3. O1 ↔ O3: formatTodosForHandoff reflects execute's mutations
 * 4. O4 → O1,O2,O3: resetTodosForTest clears state for all operations
 */

import { beforeEach, describe, expect, it } from "vitest";
import { formatTodosForHandoff, getTodos, resetTodosForTest, todowriteTool } from "../src/tools/todowrite.js";

describe("todowrite-handoff integration", () => {
	beforeEach(() => {
		resetTodosForTest();
	});

	describe("O1 ← O2: formatTodosForHandoff reads from getTodos", () => {
		it("formatTodosForHandoff returns null when getTodos returns empty", () => {
			expect(getTodos()).toHaveLength(0);
			expect(formatTodosForHandoff()).toBeNull();
		});

		it("formatTodosForHandoff reflects all items from getTodos", async () => {
			await todowriteTool.execute(
				"call-1",
				{
					todos: [
						{ content: "Task A", status: "pending" },
						{ content: "Task B", status: "in_progress" },
					],
				},
				undefined,
				undefined,
			);

			const todos = getTodos();
			const handoff = formatTodosForHandoff();

			// Both active items should appear
			expect(todos).toHaveLength(2);
			expect(handoff).toContain("Task A");
			expect(handoff).toContain("Task B");
		});
	});

	describe("O3 → O2: execute writes state that getTodos reads", () => {
		it("getTodos reflects state after execute", async () => {
			expect(getTodos()).toHaveLength(0);

			await todowriteTool.execute(
				"call-1",
				{ todos: [{ content: "New task", status: "pending" }] },
				undefined,
				undefined,
			);

			const todos = getTodos();
			expect(todos).toHaveLength(1);
			expect(todos[0].content).toBe("New task");
		});

		it("execute replaces previous state completely", async () => {
			await todowriteTool.execute(
				"call-1",
				{
					todos: [
						{ content: "First", status: "pending" },
						{ content: "Second", status: "pending" },
					],
				},
				undefined,
				undefined,
			);
			expect(getTodos()).toHaveLength(2);

			await todowriteTool.execute(
				"call-2",
				{ todos: [{ content: "Only one now", status: "pending" }] },
				undefined,
				undefined,
			);

			const todos = getTodos();
			expect(todos).toHaveLength(1);
			expect(todos[0].content).toBe("Only one now");
		});
	});

	describe("O1 ↔ O3: formatTodosForHandoff reflects execute mutations", () => {
		it("formatTodosForHandoff updates after each execute call", async () => {
			// Initial state
			await todowriteTool.execute(
				"call-1",
				{ todos: [{ content: "Initial task", status: "pending" }] },
				undefined,
				undefined,
			);
			expect(formatTodosForHandoff()).toContain("Initial task");

			// Mutate state
			await todowriteTool.execute(
				"call-2",
				{ todos: [{ content: "Replaced task", status: "pending" }] },
				undefined,
				undefined,
			);

			const handoff = formatTodosForHandoff();
			expect(handoff).toContain("Replaced task");
			expect(handoff).not.toContain("Initial task");
		});

		it("formatTodosForHandoff correctly partitions by status", async () => {
			await todowriteTool.execute(
				"call-1",
				{
					todos: [
						{ content: "Active", status: "pending" },
						{ content: "Working", status: "in_progress" },
						{ content: "Done", status: "completed" },
						{ content: "Dropped", status: "blocked" },
					],
				},
				undefined,
				undefined,
			);

			const handoff = formatTodosForHandoff()!;

			// Active items in checklist
			expect(handoff).toContain("- [ ] [medium] Active");
			expect(handoff).toContain("- [ ] [medium] Working (in_progress)");

			// Completed/blocked NOT in checklist but in summary
			expect(handoff).not.toMatch(/- \[.\] .*Done/);
			expect(handoff).not.toMatch(/- \[.\] .*Blocked/);
			expect(handoff).toContain("1 completed");
			expect(handoff).toContain("1 blocked");
		});
	});

	describe("O4 → O1,O2,O3: resetTodosForTest clears all state", () => {
		it("reset clears state visible to getTodos", async () => {
			await todowriteTool.execute(
				"call-1",
				{ todos: [{ content: "Task", status: "pending" }] },
				undefined,
				undefined,
			);
			expect(getTodos()).toHaveLength(1);

			resetTodosForTest();
			expect(getTodos()).toHaveLength(0);
		});

		it("reset clears state visible to formatTodosForHandoff", async () => {
			await todowriteTool.execute(
				"call-1",
				{ todos: [{ content: "Task", status: "pending" }] },
				undefined,
				undefined,
			);
			expect(formatTodosForHandoff()).not.toBeNull();

			resetTodosForTest();
			expect(formatTodosForHandoff()).toBeNull();
		});

		it("reset allows fresh execute without ID conflicts", async () => {
			await todowriteTool.execute(
				"call-1",
				{ todos: [{ content: "First run", status: "pending" }] },
				undefined,
				undefined,
			);
			const firstId = getTodos()[0].id;
			expect(firstId).toBe("todo_1");

			resetTodosForTest();

			await todowriteTool.execute(
				"call-2",
				{ todos: [{ content: "Second run", status: "pending" }] },
				undefined,
				undefined,
			);
			const secondId = getTodos()[0].id;
			expect(secondId).toBe("todo_1"); // ID counter reset
		});
	});

	describe("Edge cases for handoff formatting", () => {
		it("handles transition from active to all-completed", async () => {
			// Start with active task
			await todowriteTool.execute(
				"call-1",
				{ todos: [{ content: "Task", status: "in_progress" }] },
				undefined,
				undefined,
			);
			expect(formatTodosForHandoff()).toContain("- [ ]");

			// Mark as completed
			await todowriteTool.execute(
				"call-2",
				{ todos: [{ content: "Task", status: "completed" }] },
				undefined,
				undefined,
			);

			const handoff = formatTodosForHandoff()!;
			expect(handoff).toContain("*No active tasks remaining.*");
			expect(handoff).toContain("*1 completed*");
		});

		it("preserves priority in handoff output", async () => {
			await todowriteTool.execute(
				"call-1",
				{
					todos: [
						{ content: "High task", status: "pending", priority: "high" },
						{ content: "Low task", status: "pending", priority: "low" },
					],
				},
				undefined,
				undefined,
			);

			const handoff = formatTodosForHandoff()!;
			expect(handoff).toContain("[high] High task");
			expect(handoff).toContain("[low] Low task");
		});
	});
});
