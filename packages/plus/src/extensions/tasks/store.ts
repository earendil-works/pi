/**
 * File-backed task store for the TaskCreate/TaskUpdate/TaskList/TaskGet tools
 * (Claude Code-style task tracking, adapted from openclaude's V2 task system).
 *
 * Tasks live under <agentDir>/tasks/<listId>/<id>.json, one JSON file per
 * task. <listId> is the session id, so each session gets its own list and
 * profiles (per-profile agent dirs) stay isolated. A `.highwatermark` file
 * makes ids monotonic — deleted ids are never reused.
 *
 * Writes are atomic (tmp file + rename) and serialized through an in-process
 * promise queue. Cross-process writers of the same list are not expected (a
 * session owns its list; sub-agent children run with their own session), so
 * no file locking is used.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../../../coding-agent/src/config.ts";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
	id: string;
	subject: string;
	description: string;
	activeForm?: string;
	owner?: string;
	status: TaskStatus;
	blocks: string[];
	blockedBy: string[];
	metadata?: Record<string, unknown>;
}

export interface TaskCreateInput {
	subject: string;
	description: string;
	activeForm?: string;
	owner?: string;
}

export interface TaskUpdateInput {
	subject?: string;
	description?: string;
	activeForm?: string;
	owner?: string;
	status?: TaskStatus | "deleted";
	addBlocks?: string[];
	addBlockedBy?: string[];
}

export type TaskUpdateResult =
	| { task: Omit<Task, "status"> & { status: TaskStatus | "deleted" }; updatedFields: string[] }
	| { error: string };

const HIGHWATERMARK_FILE = ".highwatermark";

function sanitizeListId(listId: string): string {
	return listId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class TaskStore {
	private listDir: string;
	private queue: Promise<unknown> = Promise.resolve();

	private constructor(listDir: string) {
		this.listDir = listDir;
	}

	/** Task store for a list id (normally the session id). */
	static forList(listId: string): TaskStore {
		return new TaskStore(path.join(getAgentDir(), "tasks", sanitizeListId(listId)));
	}

	/** Direct constructor for tests with an injected directory. */
	static forDir(listDir: string): TaskStore {
		return new TaskStore(listDir);
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(fn, fn);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private ensureDir(): void {
		fs.mkdirSync(this.listDir, { recursive: true });
	}

	private taskPath(id: string): string {
		return path.join(this.listDir, `${id}.json`);
	}

	private readTask(id: string): Task | null {
		try {
			const raw = fs.readFileSync(this.taskPath(id), "utf-8");
			return JSON.parse(raw) as Task;
		} catch {
			return null;
		}
	}

	private writeTask(task: Task): void {
		this.ensureDir();
		const target = this.taskPath(task.id);
		const tmp = `${target}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(task, null, 2), { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tmp, target);
	}

	private nextId(): string {
		this.ensureDir();
		let current = 0;
		try {
			current = Number.parseInt(fs.readFileSync(path.join(this.listDir, HIGHWATERMARK_FILE), "utf-8"), 10) || 0;
		} catch {
			/* no high-water mark yet */
		}
		const next = current + 1;
		const target = path.join(this.listDir, HIGHWATERMARK_FILE);
		fs.writeFileSync(`${target}.tmp-${process.pid}`, String(next), { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(`${target}.tmp-${process.pid}`, target);
		return String(next);
	}

	create(input: TaskCreateInput): Promise<Task> {
		return this.enqueue(async () => {
			const task: Task = {
				id: this.nextId(),
				subject: input.subject,
				description: input.description,
				activeForm: input.activeForm,
				owner: input.owner,
				status: "pending",
				blocks: [],
				blockedBy: [],
			};
			this.writeTask(task);
			return task;
		});
	}

	update(id: string, input: TaskUpdateInput): Promise<TaskUpdateResult> {
		return this.enqueue(async () => {
			const task = this.readTask(id);
			if (!task) return { error: `Task #${id} not found` };

			const updatedFields: string[] = [];
			const setField = <K extends "subject" | "description" | "activeForm" | "owner">(
				key: K,
				value: Task[K] | undefined,
			) => {
				if (value !== undefined && value !== task[key]) {
					task[key] = value;
					updatedFields.push(key);
				}
			};
			setField("subject", input.subject);
			setField("description", input.description);
			setField("activeForm", input.activeForm);
			setField("owner", input.owner);

			if (input.status !== undefined) {
				if (input.status === "deleted") {
					try {
						fs.unlinkSync(this.taskPath(id));
					} catch {
						/* already gone */
					}
					updatedFields.push("status");
					return { task: { ...task, status: "deleted" }, updatedFields };
				}
				if (input.status !== task.status) {
					task.status = input.status;
					updatedFields.push("status");
				}
			}

			if (input.addBlocks) {
				const added = input.addBlocks.filter((b) => !task.blocks.includes(b));
				if (added.length > 0) {
					task.blocks.push(...added);
					updatedFields.push("blocks");
				}
			}
			if (input.addBlockedBy) {
				const added = input.addBlockedBy.filter((b) => !task.blockedBy.includes(b));
				if (added.length > 0) {
					task.blockedBy.push(...added);
					updatedFields.push("blockedBy");
				}
			}

			this.writeTask(task);
			return { task, updatedFields };
		});
	}

	get(id: string): Promise<Task | null> {
		return this.enqueue(async () => this.readTask(id));
	}

	/**
	 * All tasks sorted by numeric id. Tasks with `metadata._internal` are
	 * hidden, and `blockedBy` entries pointing at completed tasks are stripped.
	 */
	list(): Promise<Task[]> {
		return this.enqueue(async () => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(this.listDir, { withFileTypes: true });
			} catch {
				return [];
			}

			const tasks: Task[] = [];
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
				try {
					const raw = fs.readFileSync(path.join(this.listDir, entry.name), "utf-8");
					const task = JSON.parse(raw) as Task;
					if (task.metadata?._internal) continue;
					tasks.push(task);
				} catch {
					/* skip unreadable files */
				}
			}

			const byId = new Map(tasks.map((t) => [t.id, t]));
			for (const task of tasks) {
				task.blockedBy = task.blockedBy.filter((id) => byId.get(id)?.status !== "completed");
			}

			tasks.sort((a, b) => Number(a.id) - Number(b.id));
			return tasks;
		});
	}
}

/** One-line summary used in tool result text: `#3 [in_progress] Fix auth bug (alice) [blocked by #1]`. */
export function formatTaskLine(task: Omit<Task, "status"> & { status: string }): string {
	const parts = [`#${task.id}`, `[${task.status}]`, task.subject];
	if (task.owner) parts.push(`(${task.owner})`);
	if (task.blockedBy.length > 0) parts.push(`[blocked by ${task.blockedBy.map((b) => `#${b}`).join(", ")}]`);
	return parts.join(" ");
}
