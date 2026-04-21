import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
	appendLog,
	createTask,
	getTaskDir,
	listTasks,
	readLogTail,
	readStatus,
	updateStatus,
} from "./src/task-manager.js";

type TaskState = "queued" | "running" | "completed" | "failed" | "cancelled";

interface TaskSummary {
	id: string;
	dir: string;
	state: TaskState;
	stage: string;
	progress: number;
	updatedAt: string;
	input: string;
}

const EXTENSION_ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = path.join(EXTENSION_ROOT, "worker-entry.mjs");

export default function paperAuditExtension(pi: ExtensionAPI): void {
	pi.registerCommand("audit-paper", {
		description: "Start a background paper-audit task for a .md or .txt paper",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (!arg) {
				ctx.ui.notify("Usage: /audit-paper <path-to-paper.md|.txt>", "warning");
				return;
			}
			const abs = resolveInputPath(ctx.cwd, arg);
			if (!fs.existsSync(abs)) {
				ctx.ui.notify(`No such file: ${abs}`, "error");
				return;
			}
			if (!fs.statSync(abs).isFile()) {
				ctx.ui.notify(`Not a regular file: ${abs}`, "error");
				return;
			}
			const ext = path.extname(abs).toLowerCase();
			if (ext !== ".md" && ext !== ".markdown" && ext !== ".txt") {
				ctx.ui.notify(`Unsupported input extension ${ext}. Use .md or .txt.`, "error");
				return;
			}

			const relInput = path.relative(ctx.cwd, abs) || path.basename(abs);
			const record = await createTask(ctx.cwd, "paper-audit", relInput);
			await appendLog(ctx.cwd, record.id, `/audit-paper invoked with ${relInput}`);

			try {
				spawnDetachedWorker(ctx.cwd, record.id);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				await updateStatus(ctx.cwd, record.id, { state: "failed", error: `failed to spawn worker: ${message}` });
				ctx.ui.notify(`Failed to start worker: ${message}`, "error");
				return;
			}

			ctx.ui.notify(
				`Started ${record.id}. Use /task-status ${record.id} to follow progress, /tasks to list all tasks.`,
				"info",
			);
		},
	});

	pi.registerCommand("tasks", {
		description: "List recent paper-audit tasks",
		handler: async (_args, ctx) => {
			const tasks = (await listTasks(ctx.cwd)) as TaskSummary[];
			if (tasks.length === 0) {
				ctx.ui.notify("No tasks found under .pi/tasks/", "info");
				return;
			}
			const items = tasks.map(formatTaskLine);
			if (!ctx.hasUI) {
				ctx.ui.notify(items.join("\n"), "info");
				return;
			}
			const selected = await ctx.ui.select("Paper-audit tasks", items);
			if (!selected) return;
			const idx = items.indexOf(selected);
			if (idx < 0) return;
			await showTaskStatus(ctx, tasks[idx].id);
		},
	});

	pi.registerCommand("task-status", {
		description: "Show the current stage, progress, and artifacts for a task",
		getArgumentCompletions: async (prefix) => {
			const tasks = (await safeListTasks()) as TaskSummary[];
			const trimmed = prefix.trim();
			return tasks
				.map((t) => t.id)
				.filter((id) => id.startsWith(trimmed))
				.map((id) => ({ value: id, label: id }));
		},
		handler: async (args, ctx) => {
			const taskId = args.trim();
			if (!taskId) {
				ctx.ui.notify("Usage: /task-status <task-id>", "warning");
				return;
			}
			await showTaskStatus(ctx, taskId);
		},
	});

	async function safeListTasks(): Promise<TaskSummary[]> {
		try {
			return (await listTasks(process.cwd())) as TaskSummary[];
		} catch {
			return [];
		}
	}
}

async function showTaskStatus(ctx: ExtensionCommandContext, taskId: string): Promise<void> {
	const status = await readStatus(ctx.cwd, taskId);
	if (!status) {
		ctx.ui.notify(`No such task: ${taskId}`, "error");
		return;
	}
	const dir = getTaskDir(ctx.cwd, taskId);
	const tail = await readLogTail(ctx.cwd, taskId, 8);
	const lines = [
		`${stateIcon(status.state as TaskState)} ${status.id} [${status.state}]`,
		`  stage:    ${status.stage}`,
		`  progress: ${(status.progress * 100).toFixed(0)}%`,
		`  input:    ${status.input}`,
		`  created:  ${status.createdAt}`,
		`  updated:  ${status.updatedAt}`,
		`  dir:      ${path.relative(ctx.cwd, dir) || dir}`,
	];
	if (status.error) lines.push(`  error:    ${status.error}`);
	if (status.artifacts.length > 0) {
		lines.push("  artifacts:");
		for (const a of status.artifacts) lines.push(`    - ${a}`);
	}
	if (tail.length > 0) {
		lines.push("  log (tail):");
		for (const l of tail) lines.push(`    ${l}`);
	}
	ctx.ui.notify(lines.join("\n"), status.state === "failed" ? "error" : "info");
}

function formatTaskLine(t: TaskSummary): string {
	const pct = `${(t.progress * 100).toFixed(0)}%`;
	return `${stateIcon(t.state)} ${t.id}  ${t.state.padEnd(9)}  ${t.stage.padEnd(18)}  ${pct.padStart(4)}  ${t.input}`;
}

function stateIcon(state: TaskState): string {
	switch (state) {
		case "completed":
			return "[ok]";
		case "failed":
			return "[!!]";
		case "running":
			return "[..]";
		case "queued":
			return "[..]";
		case "cancelled":
			return "[xx]";
	}
}

function resolveInputPath(cwd: string, arg: string): string {
	if (path.isAbsolute(arg)) return arg;
	if (arg.startsWith("~/")) return path.join(process.env.HOME ?? "", arg.slice(2));
	return path.resolve(cwd, arg);
}

function spawnDetachedWorker(cwd: string, taskId: string): void {
	const logFile = path.join(getTaskDir(cwd, taskId), "log.txt");
	const out = fs.openSync(logFile, "a");
	const err = fs.openSync(logFile, "a");
	const child = spawn(process.execPath, [WORKER_ENTRY, taskId], {
		cwd,
		detached: true,
		stdio: ["ignore", out, err],
		env: {
			...process.env,
			PI_AUDIT_CWD: cwd,
			PI_AUDIT_TASK_ID: taskId,
		},
	});
	child.unref();
	fs.closeSync(out);
	fs.closeSync(err);
}
