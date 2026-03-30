import type { AgentTool } from "@kennyfrc/mu-ai";
import { StringEnum } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import type { ToolProjectionV1 } from "../display/projection.js";
import { getToolDescription } from "../prompts/index.js";

// Use StringEnum instead of Type.Union([Type.Literal(...)]) for Google API compatibility.
// Google's API doesn't support anyOf/const patterns - only enum arrays.
const TodoStatus = StringEnum(["pending", "in_progress", "completed", "blocked"] as const, {
	description: "Current status of the task: pending, in_progress, completed, blocked",
});

const TodoPriority = StringEnum(["high", "medium", "low"] as const, {
	description: "Priority level of the task: high, medium, low",
});

const TodoItemInput = Type.Object({
	id: Type.Optional(Type.String({ description: "Unique identifier for the todo item (auto-generated if omitted)" })),
	content: Type.String({ description: "Brief description of the task" }),
	status: TodoStatus,
	priority: Type.Optional(TodoPriority),
});

type TodoStatus = "pending" | "in_progress" | "completed" | "blocked";
type TodoPriority = "high" | "medium" | "low";

export interface TodoItem {
	id: string;
	content: string;
	status: TodoStatus;
	priority: TodoPriority;
}

interface TodoItemInput {
	id?: string;
	content: string;
	status: TodoStatus;
	priority?: TodoPriority;
}

export interface TodoWriteToolDetails {
	todos: TodoItem[];
	summary: { total: number; pending: number; inProgress: number; completed: number; blocked: number };
	projection: ToolProjectionV1;
}

export interface TodoSummary {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
	blocked: number;
}

// Module-level state: one agent per process, so this acts as session state
let todos: TodoItem[] = [];
let nextId = 1;

export function resetTodosForTest(): void {
	todos = [];
	nextId = 1;
}

export function getTodos(): readonly TodoItem[] {
	return todos;
}

export function getTodoSummary(items: readonly TodoItem[] = todos): TodoSummary {
	return {
		total: items.length,
		pending: items.filter((t) => t.status === "pending").length,
		inProgress: items.filter((t) => t.status === "in_progress").length,
		completed: items.filter((t) => t.status === "completed").length,
		blocked: items.filter((t) => t.status === "blocked").length,
	};
}

export function buildTodoContinuationReminder(summary: Pick<TodoSummary, "pending" | "inProgress">): string | null {
	if (summary.pending <= 0 && summary.inProgress <= 0) {
		return null;
	}
	return `\n\n<system_reminder pending="${summary.pending}" in_progress="${summary.inProgress}">Continue now. Execute the remaining todo items using available tools. Prefer the in_progress item first, otherwise take the next pending item. Keep going until there are no pending/in_progress items left, or you are blocked (then ask the user for what you need). Update the todo list with todo_write as you make progress.</system_reminder>`;
}

/**
 * Format active todos for handoff document.
 * Returns markdown section with pending/in_progress items and summary counts.
 * Returns null if no todos exist.
 */
export function formatTodosForHandoff(): string | null {
	if (todos.length === 0) return null;

	const active = todos.filter((t) => t.status === "pending" || t.status === "in_progress");
	const completedCount = todos.filter((t) => t.status === "completed").length;
	const blockedCount = todos.filter((t) => t.status === "blocked").length;

	// Nothing to report if no active items and no history
	if (active.length === 0 && completedCount === 0 && blockedCount === 0) return null;

	const lines: string[] = ["## Active Tasks", ""];

	if (active.length === 0) {
		lines.push("*No active tasks remaining.*");
	} else {
		for (const t of active) {
			const priority = `[${t.priority}]`;
			const statusSuffix = t.status === "in_progress" ? " (in_progress)" : "";
			lines.push(`- [ ] ${priority} ${t.content}${statusSuffix}`);
		}
	}

	// Summary line for completed/blocked
	const summaryParts: string[] = [];
	if (completedCount > 0) summaryParts.push(`${completedCount} completed`);
	if (blockedCount > 0) summaryParts.push(`${blockedCount} blocked`);
	if (summaryParts.length > 0) {
		lines.push("");
		lines.push(`*${summaryParts.join(", ")}*`);
	}

	return lines.join("\n");
}

function normalize(input: TodoItemInput, idGenerator: () => string): TodoItem {
	return {
		id: input.id?.trim() || idGenerator(),
		content: input.content.trim(),
		status: input.status,
		priority: input.priority ?? "medium",
	};
}

function validate(items: TodoItem[]): string | null {
	for (const item of items) {
		if (!item.content) {
			return `Todo item "${item.id}" has empty content`;
		}
	}

	const ids = new Set<string>();
	for (const item of items) {
		if (ids.has(item.id)) {
			return `Duplicate todo id: "${item.id}"`;
		}
		ids.add(item.id);
	}

	const inProgressCount = items.filter((t) => t.status === "in_progress").length;
	if (inProgressCount > 1) {
		return `Only one todo can be in_progress at a time (found ${inProgressCount})`;
	}

	return null;
}

function formatTodos(items: TodoItem[]): string {
	if (items.length === 0) {
		return "No todos";
	}

	return items.map((t) => `[${t.status}] [${t.priority}] ${t.content}`).join("\n");
}

const todowriteSchema = Type.Object({
	todos: Type.Array(TodoItemInput, {
		description: "The updated todo list. Replaces the current list entirely.",
	}),
});

export const todowriteTool: AgentTool<typeof todowriteSchema, TodoWriteToolDetails> = {
	name: "todo_write",
	label: "todo_write",
	description: getToolDescription("todo_write"),
	parameters: todowriteSchema,
	execute: async (
		_toolCallId: string,
		{ todos: inputTodos }: { todos: TodoItemInput[] },
		_signal?: AbortSignal,
		_onProgress?: (chunk: string) => void,
	) => {
		const idGenerator = () => `todo_${nextId++}`;
		const normalized = inputTodos.map((t) => normalize(t, idGenerator));

		const error = validate(normalized);
		if (error) {
			throw new Error(error);
		}

		todos = normalized;

		const summary = getTodoSummary(todos);
		const { pending, inProgress, completed, blocked, total } = summary;

		const text = formatTodos(todos);

		const summaryText = [
			`${inProgress} in_progress`,
			`${pending} pending`,
			`${completed} completed`,
			`${blocked} blocked`,
		].join(" · ");

		return {
			content: [{ type: "text", text }],
			details: {
				todos: todos,
				summary,
				projection: {
					version: 1,
					kind: "tool_panel",
					intent: {
						preferredSurface: "inline",
					},
					call: {
						style: "argv",
						text: `todo_write set --items ${total}`,
						command: "todo_write",
						argv: ["set", "--items", String(total)],
					},
					summary: {
						text: summaryText,
						severity: "info",
					},
					output: {
						collapse: {
							maxVisualLines: 5,
							expandHint: "ctrl+o to expand",
						},
					},
					state: {
						title: "Todo List",
						summary: summaryText,
						items: todos
							.filter((todo) => todo.status !== "completed")
							.map((todo) => `[${todo.status}] [${todo.priority}] ${todo.content}`),
					},
				},
			},
		};
	},
};
