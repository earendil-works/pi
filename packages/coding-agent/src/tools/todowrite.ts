import type { AgentTool } from "@kennyfrc/mu-ai";
import { StringEnum } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { getToolDescription } from "../prompts/index.js";

// Use StringEnum instead of Type.Union([Type.Literal(...)]) for Google API compatibility.
// Google's API doesn't support anyOf/const patterns - only enum arrays.
const TodoStatus = StringEnum(["pending", "in_progress", "completed", "cancelled"] as const, {
	description: "Current status of the task: pending, in_progress, completed, cancelled",
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

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
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

/**
 * Format active todos for handoff document.
 * Returns markdown section with pending/in_progress items and summary counts.
 * Returns null if no todos exist.
 */
export function formatTodosForHandoff(): string | null {
	if (todos.length === 0) return null;

	const active = todos.filter((t) => t.status === "pending" || t.status === "in_progress");
	const completedCount = todos.filter((t) => t.status === "completed").length;
	const cancelledCount = todos.filter((t) => t.status === "cancelled").length;

	// Nothing to report if no active items and no history
	if (active.length === 0 && completedCount === 0 && cancelledCount === 0) return null;

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

	// Summary line for completed/cancelled
	const summaryParts: string[] = [];
	if (completedCount > 0) summaryParts.push(`${completedCount} completed`);
	if (cancelledCount > 0) summaryParts.push(`${cancelledCount} cancelled`);
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

	const statusIcon: Record<TodoStatus, string> = {
		pending: "○",
		in_progress: "◐",
		completed: "●",
		cancelled: "✗",
	};

	const priorityLabel: Record<TodoPriority, string> = {
		high: "[H]",
		medium: "[M]",
		low: "[L]",
	};

	return items.map((t) => `${statusIcon[t.status]} ${priorityLabel[t.priority]} ${t.content}`).join("\n");
}

const todowriteSchema = Type.Object({
	todos: Type.Array(TodoItemInput, {
		description: "The updated todo list. Replaces the current list entirely.",
	}),
});

export const todowriteTool: AgentTool<typeof todowriteSchema> = {
	name: "TodoWrite",
	label: "TodoWrite",
	description: getToolDescription("TodoWrite"),
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

		const pending = todos.filter((t) => t.status === "pending").length;
		const inProgress = todos.filter((t) => t.status === "in_progress").length;
		const completed = todos.filter((t) => t.status === "completed").length;
		const cancelled = todos.filter((t) => t.status === "cancelled").length;

		let text = formatTodos(todos);

		// If there is active work left, add an out-of-band reminder for the model.
		// The TUI hides this tag, but the model still receives it via the tool result.
		if (pending > 0 || inProgress > 0) {
			text += `\n\n<system_reminder pending="${pending}" in_progress="${inProgress}">Continue now. Execute the remaining todo items using available tools. Prefer the in_progress item first, otherwise take the next pending item. Keep going until there are no pending/in_progress items left, or you are blocked (then ask the user for what you need). Update the todo list with TodoWrite as you make progress.</system_reminder>`;
		}

		return {
			content: [{ type: "text", text }],
			details: {
				todos: todos,
				summary: { total: todos.length, pending, inProgress, completed, cancelled },
			},
		};
	},
};
