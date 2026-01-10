import type { AgentTool } from "@kennyfrc/pi-ai";
import { Type } from "@sinclair/typebox";
import { getToolDescription } from "../prompts/index.js";

const TodoStatus = Type.Union(
	[Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("cancelled")],
	{ description: "Current status of the task: pending, in_progress, completed, cancelled" },
);

const TodoPriority = Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
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
	name: "todowrite",
	label: "todowrite",
	description: getToolDescription("todowrite"),
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

		return {
			content: [{ type: "text", text: formatTodos(todos) }],
			details: {
				todos: todos,
				summary: { total: todos.length, pending, inProgress, completed, cancelled },
			},
		};
	},
};
