import { randomBytes } from "crypto";
import { constants } from "fs";
import { mkdir, open, readdir, readFile, rm, stat, unlink, writeFile } from "fs/promises";
import { basename, join } from "path";
import {
	coerceTodoFrontmatter,
	formatTodoMarkdown,
	parseTodoMarkdownOrThrow,
	type TodoFile,
	type TodoFrontmatter,
	type TodoStatus,
} from "./todo-file.js";

export interface WhoAmI {
	sessionId: string;
	runId: string;
}

export interface TodoRecord {
	path: string;
	frontmatter: TodoFrontmatter;
	body: string;
}

export interface TodoListFilters {
	list?: string;
	status?: TodoStatus | TodoStatus[];
	tags?: string[];
	assignment?: "any" | "unassigned" | "assigned" | "mine";
	/** If true, include done/cancelled. Default false. */
	includeClosed?: boolean;
}

export interface TodoStoreOptions {
	rootDir: string;
	lockTtlMs?: number;
	now?: () => number;
}

export class TodoStore {
	readonly rootDir: string;
	readonly lockTtlMs: number;
	private readonly now: () => number;

	constructor(options: TodoStoreOptions) {
		this.rootDir = options.rootDir;
		this.lockTtlMs = options.lockTtlMs ?? 30 * 60 * 1000;
		this.now = options.now ?? (() => Date.now());
	}

	private isoNow(): string {
		return new Date(this.now()).toISOString();
	}

	async ensureDir(): Promise<void> {
		await mkdir(this.rootDir, { recursive: true });
	}

	private todoPath(id: string): string {
		return join(this.rootDir, `${id}.md`);
	}

	private lockPath(id: string): string {
		return join(this.rootDir, `${id}.lock`);
	}

	private async acquireLock(id: string, who: WhoAmI, force: boolean): Promise<void> {
		await this.ensureDir();
		const lockPath = this.lockPath(id);
		const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;

		const tryAcquire = async (): Promise<void> => {
			const handle = await open(lockPath, flags, 0o666);
			try {
				const payload = {
					pid: process.pid,
					session: who.sessionId,
					run: who.runId,
					created_at: this.isoNow(),
				};
				await handle.writeFile(JSON.stringify(payload) + "\n", "utf8");
			} finally {
				await handle.close();
			}
		};

		try {
			await tryAcquire();
			return;
		} catch (err: unknown) {
			const e = err as NodeJS.ErrnoException;
			if (e.code !== "EEXIST") throw err;
		}

		// Lock exists. Check staleness.
		const s = await stat(lockPath);
		const ageMs = this.now() - s.mtimeMs;
		const isStale = ageMs > this.lockTtlMs;
		if (!isStale || !force) {
			throw new Error(`Todo ${id} is locked (age ${Math.round(ageMs / 1000)}s)`);
		}

		await rm(lockPath, { force: true });
		await tryAcquire();
	}

	private async releaseLock(id: string): Promise<void> {
		await unlink(this.lockPath(id)).catch(() => undefined);
	}

	private async withLock<T>(id: string, who: WhoAmI, force: boolean, fn: () => Promise<T>): Promise<T> {
		await this.acquireLock(id, who, force);
		try {
			return await fn();
		} finally {
			await this.releaseLock(id);
		}
	}

	private async readTodoOrThrow(id: string): Promise<TodoRecord> {
		const path = this.todoPath(id);
		const content = await readFile(path, "utf8");
		const parsed = parseTodoMarkdownOrThrow(content);
		const fm = coerceTodoFrontmatter(parsed.frontmatter);
		return { path, frontmatter: fm, body: parsed.body };
	}

	async get(id: string): Promise<TodoRecord | null> {
		try {
			return await this.readTodoOrThrow(id);
		} catch (err: unknown) {
			const e = err as NodeJS.ErrnoException;
			if (e.code === "ENOENT") return null;
			throw err;
		}
	}

	async list(filters: TodoListFilters | undefined, who: WhoAmI): Promise<TodoRecord[]> {
		await this.ensureDir();
		const entries = await readdir(this.rootDir, { withFileTypes: true });
		const mdFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);

		const todos: TodoRecord[] = [];
		for (const name of mdFiles) {
			const id = basename(name, ".md");
			const record = await this.readTodoOrThrow(id);
			if (!this.matchesFilters(record, filters, who)) continue;
			// By default hide closed
			if (
				!filters?.includeClosed &&
				(record.frontmatter.status === "done" || record.frontmatter.status === "cancelled")
			) {
				continue;
			}
			todos.push(record);
		}

		return todos.sort((a, b) => this.compareForList(a.frontmatter, b.frontmatter, who));
	}

	private matchesFilters(todo: TodoRecord, filters: TodoListFilters | undefined, who?: WhoAmI): boolean {
		if (!filters) return true;
		if (filters.list && todo.frontmatter.list !== filters.list) return false;

		if (filters.status) {
			const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
			if (!statuses.includes(todo.frontmatter.status)) return false;
		}

		if (filters.tags && filters.tags.length > 0) {
			const tags = todo.frontmatter.tags ?? [];
			for (const t of filters.tags) {
				if (!tags.includes(t)) return false;
			}
		}

		const assignment = filters.assignment ?? "any";
		if (assignment !== "any") {
			const assignedSession = todo.frontmatter.assigned_to_session;
			if (assignment === "unassigned") {
				if (assignedSession) return false;
			} else if (assignment === "assigned") {
				if (!assignedSession) return false;
			} else if (assignment === "mine") {
				if (!who || assignedSession !== who.sessionId) return false;
			}
		}

		return true;
	}

	private compareForList(a: TodoFrontmatter, b: TodoFrontmatter, who: WhoAmI): number {
		const statusRank: Record<TodoStatus, number> = {
			open: 0,
			in_progress: 1,
			done: 2,
			cancelled: 3,
		};
		const r = statusRank[a.status] - statusRank[b.status];
		if (r !== 0) return r;

		const aMine = a.assigned_to_session === who.sessionId;
		const bMine = b.assigned_to_session === who.sessionId;
		if (aMine !== bMine) return aMine ? -1 : 1;

		// Oldest first (stable, predictable)
		const created = a.created_at.localeCompare(b.created_at);
		if (created !== 0) return created;
		return a.id.localeCompare(b.id);
	}

	private genId(): string {
		return randomBytes(4).toString("hex");
	}

	async create(input: {
		title: string;
		list?: string;
		tags?: string[];
		body?: string;
		claim?: boolean;
		who: WhoAmI;
	}): Promise<TodoRecord> {
		await this.ensureDir();
		const id = this.genId();
		const now = this.isoNow();
		const list = input.list?.trim() || "inbox";
		const body = input.body ?? "";
		const status: TodoStatus = "open";

		const fm: TodoFrontmatter = {
			id,
			title: input.title,
			list,
			tags: input.tags && input.tags.length > 0 ? input.tags : undefined,
			status,
			created_at: now,
			updated_at: now,
		};
		if (input.claim) {
			fm.assigned_to_session = input.who.sessionId;
			fm.assigned_to_run = input.who.runId;
		}

		const file: TodoFile = { frontmatter: fm, body };
		const path = this.todoPath(id);
		await writeFile(path, formatTodoMarkdown(file), { encoding: "utf8", flag: "wx" });
		return { path, frontmatter: fm, body };
	}

	async update(
		id: string,
		input: {
			title?: string;
			list?: string;
			tags?: string[];
			status?: TodoStatus;
			body?: string;
			who: WhoAmI;
			force?: boolean;
		},
	): Promise<TodoRecord> {
		return this.withLock(id, input.who, input.force ?? false, async () => {
			const current = await this.readTodoOrThrow(id);
			const nextTags =
				input.tags === undefined ? current.frontmatter.tags : input.tags.length > 0 ? input.tags : undefined;
			const next: TodoFrontmatter = {
				...current.frontmatter,
				title: input.title ?? current.frontmatter.title,
				list: input.list ?? current.frontmatter.list,
				tags: nextTags,
				status: input.status ?? current.frontmatter.status,
				updated_at: this.isoNow(),
			};

			if (next.status === "done" || next.status === "cancelled") {
				delete next.assigned_to_session;
				delete next.assigned_to_run;
			}

			const body = input.body ?? current.body;
			const file: TodoFile = { frontmatter: next, body };
			await writeFile(this.todoPath(id), formatTodoMarkdown(file), "utf8");
			return { path: this.todoPath(id), frontmatter: next, body };
		});
	}

	async append(id: string, input: { markdown: string; who: WhoAmI; force?: boolean }): Promise<TodoRecord> {
		return this.withLock(id, input.who, input.force ?? false, async () => {
			const current = await this.readTodoOrThrow(id);
			const addition = input.markdown;
			const sep = current.body.trim().length === 0 ? "" : current.body.endsWith("\n") ? "\n" : "\n\n";
			const body = current.body + sep + addition;
			const next: TodoFrontmatter = { ...current.frontmatter, updated_at: this.isoNow() };
			const file: TodoFile = { frontmatter: next, body };
			await writeFile(this.todoPath(id), formatTodoMarkdown(file), "utf8");
			return { path: this.todoPath(id), frontmatter: next, body };
		});
	}

	async claim(id: string, input: { who: WhoAmI; force?: boolean }): Promise<TodoRecord> {
		return this.withLock(id, input.who, input.force ?? false, async () => {
			const current = await this.readTodoOrThrow(id);
			const assignedSession = current.frontmatter.assigned_to_session;
			const assignedRun = current.frontmatter.assigned_to_run;

			const isAssignedElsewhere =
				assignedSession &&
				(assignedSession !== input.who.sessionId || (assignedRun && assignedRun !== input.who.runId));

			if (isAssignedElsewhere && !input.force) {
				throw new Error(`Todo ${id} is assigned to another session/run`);
			}

			const next: TodoFrontmatter = {
				...current.frontmatter,
				assigned_to_session: input.who.sessionId,
				assigned_to_run: input.who.runId,
				updated_at: this.isoNow(),
			};

			const file: TodoFile = { frontmatter: next, body: current.body };
			await writeFile(this.todoPath(id), formatTodoMarkdown(file), "utf8");
			return { path: this.todoPath(id), frontmatter: next, body: current.body };
		});
	}

	async release(id: string, input: { who: WhoAmI; force?: boolean }): Promise<TodoRecord> {
		return this.withLock(id, input.who, input.force ?? false, async () => {
			const current = await this.readTodoOrThrow(id);
			const assignedSession = current.frontmatter.assigned_to_session;
			const assignedRun = current.frontmatter.assigned_to_run;

			const isAssignedElsewhere =
				assignedSession &&
				(assignedSession !== input.who.sessionId || (assignedRun && assignedRun !== input.who.runId));

			if (isAssignedElsewhere && !input.force) {
				throw new Error(`Todo ${id} is assigned to another session/run`);
			}

			const next: TodoFrontmatter = { ...current.frontmatter, updated_at: this.isoNow() };
			delete next.assigned_to_session;
			delete next.assigned_to_run;

			const file: TodoFile = { frontmatter: next, body: current.body };
			await writeFile(this.todoPath(id), formatTodoMarkdown(file), "utf8");
			return { path: this.todoPath(id), frontmatter: next, body: current.body };
		});
	}

	async claimNext(
		filters: TodoListFilters | undefined,
		who: WhoAmI,
		force: boolean = false,
	): Promise<TodoRecord | null> {
		const candidates = await this.list({ ...filters, includeClosed: filters?.includeClosed ?? false }, who);
		for (const c of candidates) {
			if (c.frontmatter.assigned_to_session) continue;
			if (c.frontmatter.status !== "open") continue;
			try {
				return await this.claim(c.frontmatter.id, { who, force });
			} catch {}
		}
		return null;
	}

	async delete(id: string, who: WhoAmI, force: boolean = false): Promise<void> {
		await this.withLock(id, who, force, async () => {
			const current = await this.readTodoOrThrow(id);
			if (current.frontmatter.assigned_to_session && !force) {
				throw new Error(`Todo ${id} is assigned; use force to delete`);
			}
			await rm(this.todoPath(id));
		});
	}
}
