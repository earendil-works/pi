/**
 * Task tracking tools (Claude Code-style, adapted from openclaude's V2 task
 * system): TaskCreate / TaskUpdate / TaskList / TaskGet, backed by a
 * file-per-task store under <agentDir>/tasks/<sessionId>/, plus a /tasks
 * command and a ctrl+shift+t shortcut opening a task-list overlay.
 *
 * Use these to break multi-step work into trackable tasks: create the plan up
 * front, mark tasks in_progress while working on them, and complete them as
 * they finish.
 */

import { Text } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "../../../../coding-agent/src/core/extensions/types.ts";
import { TaskListComponent } from "./component.ts";
import { formatTaskLine, type Task, TaskStore } from "./store.ts";
import { TaskCreateParams, TaskGetParams, TaskListParams, TaskUpdateParams } from "./tools.ts";

export const TASKS_SECTION_NAME = "tasks";

/**
 * Nudge the model to actually use the task tools: without a system-prompt
 * mention they sit unused, and also surfaces the current list so a resumed
 * session can pick up where it left off. The tool signatures are spelled out
 * explicitly because extension tools have no snippet in the <tools> section —
 * without this the model has to discover them blind (flash-tier models in
 * particular just ignore the nudge and plow ahead with one tool at a time).
 */
export function buildTasksSection(tasks: Task[]): string {
	let section =
		"Task tracking: for any non-trivial multi-step request, break the work into tasks " +
		"with TaskCreate up front (typically 2-5 tasks covering the whole job). Mark a task " +
		"in_progress when you start it and completed immediately when it finishes. Use " +
		"TaskUpdate for corrections and blocks/blockedBy when order matters; check state " +
		"with TaskList. Do not create tasks for trivial single-step requests.\n" +
		"Available tools:\n" +
		"- TaskCreate({ subject, description, activeForm?, owner? }) — create a task; subject is a short " +
		'imperative ("Fix auth bug"), activeForm is the progress display ("Fixing auth bug")\n' +
		"- TaskUpdate({ taskId, status?, subject?, description?, activeForm?, addBlocks?, addBlockedBy?, owner? }) — " +
		"status is pending | in_progress | completed | deleted (deleted removes); task ids are numeric strings\n" +
		"- TaskList({}) — list all tasks with ids and statuses\n" +
		"- TaskGet({ taskId }) — full details of one task";
	if (tasks.length > 0) {
		section += `\n\nCurrent tasks:\n${tasks.map(formatTaskLine).join("\n")}`;
	}
	return section;
}

function storeFor(ctx: ExtensionContext): TaskStore {
	let listId = "default";
	try {
		listId = ctx.sessionManager.getSessionId() || "default";
	} catch {
		/* fall back to the shared default list */
	}
	return TaskStore.forList(listId);
}

async function showTaskOverlay(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The task list requires interactive mode (or use the TaskList tool)", "warning");
		return;
	}
	const store = storeFor(ctx);
	const tasks = await store.list();
	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		return new TaskListComponent(tasks, theme, () => done());
	});
}

export function registerTasks(pi: ExtensionAPI): void {
	// Prompt nudge + current-list recall, mirroring the memory extension.
	pi.on("before_agent_start", async (event, ctx) => {
		event.systemPromptOptions.sections[TASKS_SECTION_NAME] = buildTasksSection(await storeFor(ctx).list());
	});

	pi.registerTool({
		name: "TaskCreate",
		label: "Task Create",
		description:
			"Create a new task in the session's task list. Use proactively to break down multi-step work: " +
			"create 2-5 tasks up front for anything non-trivial, then update statuses as you go.",
		parameters: TaskCreateParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = storeFor(ctx);
			const task = await store.create({
				subject: params.subject,
				description: params.description,
				activeForm: params.activeForm,
				owner: params.owner,
			});
			return {
				content: [{ type: "text", text: `Created ${formatTaskLine(task)}` }],
				details: { task },
			};
		},

		renderCall(args, theme, _context) {
			const text = theme.fg("toolTitle", theme.bold("TaskCreate ")) + theme.fg("accent", `"${args.subject}"`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const text = result.content[0];
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", text?.type === "text" ? text.text : ""), 0, 0);
		},
	});

	pi.registerTool({
		name: "TaskUpdate",
		label: "Task Update",
		description:
			"Update a task: set status (pending/in_progress/completed/deleted), edit fields, or add " +
			"blocks/blockedBy dependencies between task ids. Mark a task in_progress before starting it " +
			"and completed right after finishing it.",
		parameters: TaskUpdateParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = storeFor(ctx);
			const result = await store.update(params.taskId, params);
			if ("error" in result) throw new Error(result.error);
			const { task, updatedFields } = result;
			return {
				content: [
					{
						type: "text",
						text:
							updatedFields.length > 0
								? `Updated #${task.id} (${updatedFields.join(", ")})\n${formatTaskLine(task)}`
								: `No changes for #${task.id}`,
					},
				],
				details: { success: true, taskId: task.id, updatedFields, statusChange: params.status },
			};
		},

		renderCall(args, theme, _context) {
			const status = args.status ? theme.fg("accent", args.status) : theme.fg("dim", "update");
			const text = `${theme.fg("toolTitle", theme.bold("TaskUpdate "))}${theme.fg("accent", `#${args.taskId}`)} ${status}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, _theme, _context) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	pi.registerTool({
		name: "TaskList",
		label: "Task List",
		description: "List all tasks in the session's task list with status, owner, and blockers.",
		parameters: TaskListParams,

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const store = storeFor(ctx);
			const tasks = await store.list();
			return {
				content: [
					{
						type: "text",
						text: tasks.length > 0 ? tasks.map(formatTaskLine).join("\n") : "No tasks",
					},
				],
				details: {
					tasks: tasks.map((t) => ({
						id: t.id,
						subject: t.subject,
						status: t.status,
						owner: t.owner,
						blockedBy: t.blockedBy,
					})),
				},
			};
		},

		renderCall(_args, theme, _context) {
			return new Text(theme.fg("toolTitle", theme.bold("TaskList")), 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as { tasks: { id: string; subject: string; status: string }[] } | undefined;
			const text = result.content[0];
			if (!details || details.tasks.length === 0) {
				return new Text(theme.fg("dim", text?.type === "text" ? text.text : "No tasks"), 0, 0);
			}
			const display = expanded ? details.tasks : details.tasks.slice(0, 5);
			let listText = theme.fg("muted", `${details.tasks.length} task(s):`);
			for (const t of display) {
				const check =
					t.status === "completed"
						? theme.fg("success", "✓")
						: t.status === "in_progress"
							? theme.fg("warning", "◐")
							: theme.fg("dim", "○");
				listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${t.status === "completed" ? theme.fg("dim", t.subject) : theme.fg("muted", t.subject)}`;
			}
			if (!expanded && details.tasks.length > 5) {
				listText += `\n${theme.fg("dim", `... ${details.tasks.length - 5} more`)}`;
			}
			return new Text(listText, 0, 0);
		},
	});

	pi.registerTool({
		name: "TaskGet",
		label: "Task Get",
		description: "Get full details of a single task by id, including description and dependencies.",
		parameters: TaskGetParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = storeFor(ctx);
			const task = await store.get(params.taskId);
			if (!task) throw new Error(`Task #${params.taskId} not found`);
			const blockedBy =
				task.blockedBy.length > 0 ? `\nBlocked by: ${task.blockedBy.map((b) => `#${b}`).join(", ")}` : "";
			const blocks = task.blocks.length > 0 ? `\nBlocks: ${task.blocks.map((b) => `#${b}`).join(", ")}` : "";
			return {
				content: [
					{
						type: "text",
						text: `${formatTaskLine(task)}\n${task.description}${blockedBy}${blocks}`,
					},
				],
				details: { task },
			};
		},

		renderCall(args, theme, _context) {
			return new Text(theme.fg("toolTitle", theme.bold("TaskGet ")) + theme.fg("accent", `#${args.taskId}`), 0, 0);
		},

		renderResult(result, _options, _theme, _context) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	pi.registerCommand("tasks", {
		description: "Show the session's task list",
		handler: async (_args, ctx) => {
			await showTaskOverlay(ctx);
		},
	});

	// ctrl+t is taken (thinking toggle / tree filter) and ctrl+y is the editor's
	// yank binding, so the task list gets ctrl+shift+t.
	pi.registerShortcut("ctrl+shift+t", {
		description: "Show the task list",
		handler: async (ctx) => {
			await showTaskOverlay(ctx);
		},
	});
}
