import type { AgentTool } from "@kennyfrc/mu-ai";
import { StringEnum } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { getToolDescription } from "../prompts/index.js";
import type { TodoStatus } from "../todos/todo-file.js";
import { getTodoRootDirForCwd } from "../todos/todo-path.js";
import { TodoStore, type WhoAmI } from "../todos/todo-store.js";

const TodoAction = StringEnum(
	["list", "get", "create", "create_many", "update", "append", "claim", "release", "claim_next", "delete"] as const,
	{
		description: "Todo action: list, get, create, create_many, update, append, claim, release, claim_next, delete",
	},
);

const TodoStatusSchema = StringEnum(["open", "in_progress", "done", "cancelled"] as const, {
	description: "Todo status: open, in_progress, done, cancelled",
});

const AssignmentFilter = StringEnum(["any", "unassigned", "assigned", "mine"] as const, {
	description: "Assignment filter: any, unassigned, assigned, mine",
});

const TodoFiltersSchema = Type.Object({
	list: Type.Optional(Type.String({ description: "Filter by list" })),
	status: Type.Optional(Type.Array(TodoStatusSchema, { description: "Filter by status" })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Filter: todo must include all tags" })),
	assignment: Type.Optional(AssignmentFilter),
	includeClosed: Type.Optional(Type.Boolean({ description: "Include done/cancelled (default false)" })),
});

const todoSchema = Type.Object({
	action: TodoAction,

	// Common
	force: Type.Optional(Type.Boolean({ description: "Force operation (e.g. steal stale lock, override assignment)" })),

	// Identification
	id: Type.Optional(Type.String({ description: "Todo id" })),

	// Filters
	filters: Type.Optional(TodoFiltersSchema),

	// Create
	title: Type.Optional(Type.String({ description: "Todo title" })),
	list: Type.Optional(Type.String({ description: "List name (default inbox)" })),
	tags: Type.Optional(Type.Array(Type.String())),
	body: Type.Optional(Type.String({ description: "Markdown body" })),
	claim: Type.Optional(Type.Boolean({ description: "Claim this todo for current session/run" })),

	// Create many
	todos: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.String(),
				list: Type.Optional(Type.String()),
				tags: Type.Optional(Type.Array(Type.String())),
				body: Type.Optional(Type.String()),
				claim: Type.Optional(Type.Boolean()),
			}),
			{ description: "Batch create todos" },
		),
	),

	// Update
	status: Type.Optional(TodoStatusSchema),

	// Append
	markdown: Type.Optional(Type.String({ description: "Markdown to append" })),
});

function getWhoAmIFromEnv(): WhoAmI {
	const sessionId = process.env.MU_SESSION_ID;
	const runId = process.env.MU_RUN_ID;
	if (!sessionId || !runId) {
		throw new Error(
			"Missing MU_SESSION_ID or MU_RUN_ID. The mu CLI must set these environment variables at startup.",
		);
	}
	return { sessionId, runId };
}

function getStore(): TodoStore {
	const rootDir = getTodoRootDirForCwd(process.cwd());
	return new TodoStore({ rootDir });
}

function formatTodoOneLine(todo: { id: string; title: string; status: TodoStatus; list: string }): string {
	return `${todo.id} [${todo.status}] (${todo.list}) ${todo.title}`;
}

export const todoTool: AgentTool<typeof todoSchema> = {
	name: "todo",
	label: "todo",
	description: getToolDescription("todo"),
	parameters: todoSchema,
	execute: async (_toolCallId, args) => {
		const who = getWhoAmIFromEnv();
		const store = getStore();
		const force = args.force ?? false;

		switch (args.action) {
			case "create": {
				if (!args.title) throw new Error("Todo.create requires title");
				const created = await store.create({
					title: args.title,
					list: args.list,
					tags: args.tags,
					body: args.body,
					claim: args.claim,
					who,
				});
				return {
					content: [{ type: "text", text: `Created: ${formatTodoOneLine(created.frontmatter)}` }],
					details: { todo: created },
				};
			}
			case "create_many": {
				const items = args.todos ?? [];
				if (items.length === 0) throw new Error("Todo.create_many requires todos[]");
				const created = [];
				for (const t of items) {
					created.push(
						await store.create({
							title: t.title,
							list: t.list,
							tags: t.tags,
							body: t.body,
							claim: t.claim,
							who,
						}),
					);
				}

				return {
					content: [
						{
							type: "text",
							text:
								`Created ${created.length} todos:\n` +
								created.map((t) => `- ${formatTodoOneLine(t.frontmatter)}`).join("\n"),
						},
					],
					details: { todos: created },
				};
			}
			case "get": {
				if (!args.id) throw new Error("Todo.get requires id");
				const todo = await store.get(args.id);
				if (!todo) throw new Error(`Todo not found: ${args.id}`);
				return {
					content: [
						{
							type: "text",
							text: formatTodoOneLine(todo.frontmatter) + (todo.body.trim() ? `\n\n${todo.body}` : ""),
						},
					],
					details: { todo },
				};
			}
			case "list": {
				const todos = await store.list(args.filters, who);
				const lines = todos.map((t) => `- ${formatTodoOneLine(t.frontmatter)}`);
				return {
					content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No todos" }],
					details: { todos },
				};
			}
			case "update": {
				if (!args.id) throw new Error("Todo.update requires id");
				const updated = await store.update(args.id, {
					title: args.title,
					list: args.list,
					tags: args.tags,
					status: args.status,
					body: args.body,
					who,
					force,
				});
				return {
					content: [{ type: "text", text: `Updated: ${formatTodoOneLine(updated.frontmatter)}` }],
					details: { todo: updated },
				};
			}
			case "append": {
				if (!args.id) throw new Error("Todo.append requires id");
				if (!args.markdown) throw new Error("Todo.append requires markdown");
				const updated = await store.append(args.id, { markdown: args.markdown, who, force });
				return {
					content: [{ type: "text", text: `Appended note to: ${formatTodoOneLine(updated.frontmatter)}` }],
					details: { todo: updated },
				};
			}
			case "claim": {
				if (!args.id) throw new Error("Todo.claim requires id");
				const updated = await store.claim(args.id, { who, force });
				return {
					content: [{ type: "text", text: `Claimed: ${formatTodoOneLine(updated.frontmatter)}` }],
					details: { todo: updated },
				};
			}
			case "release": {
				if (!args.id) throw new Error("Todo.release requires id");
				const updated = await store.release(args.id, { who, force });
				return {
					content: [{ type: "text", text: `Released: ${formatTodoOneLine(updated.frontmatter)}` }],
					details: { todo: updated },
				};
			}
			case "claim_next": {
				const todo = await store.claimNext(args.filters, who, force);
				return {
					content: [
						{
							type: "text",
							text: todo ? `Claimed next: ${formatTodoOneLine(todo.frontmatter)}` : "No matching todos",
						},
					],
					details: { todo },
				};
			}
			case "delete": {
				if (!args.id) throw new Error("Todo.delete requires id");
				await store.delete(args.id, who, force);
				return {
					content: [{ type: "text", text: `Deleted todo: ${args.id}` }],
					details: { id: args.id },
				};
			}
			default:
				throw new Error(`Unknown Todo action: ${String((args as { action: string }).action)}`);
		}
	},
};
