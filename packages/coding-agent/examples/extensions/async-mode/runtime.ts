// Session-owned asynchronous work: immutable request snapshots, executions, and completion events.
import { randomUUID } from "node:crypto";

export interface RequestSnapshot {
	id: string;
	sessionId: string;
	text: string;
	createdAt: string;
}

export interface Task {
	id: string;
	request: RequestSnapshot;
	description: string;
	context: string;
	reason: string;
	createdAt: string;
}

export interface Execution {
	id: string;
	taskId: string;
	startedAt: string;
	state:
		| { status: "running" }
		| { status: "completed" | "failed" | "cancelled" | "interrupted"; finishedAt: string; result: string };
}

export interface TaskRecord {
	task: Task;
	execution: Execution;
}

export interface CompletionEvent {
	id: string;
	type: "task_finished";
	taskId: string;
	executionId: string;
	sessionId: string;
	request: RequestSnapshot;
	description: string;
	context: string;
	startedAt: string;
	finishedAt: string;
	status: Exclude<Execution["state"]["status"], "running">;
	result: string;
}

export type Executor = (task: Task, signal: AbortSignal) => Promise<{ success: boolean; result: string }>;

/** Owns executions independently of the foreground turn; changing mode does not cancel work. */
export class TaskRuntime {
	readonly records = new Map<string, TaskRecord>();
	private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
	private readonly persist: (record: TaskRecord) => void;
	private readonly notify: () => void;
	private closed = false;

	constructor(persist: (record: TaskRecord) => void, notify: () => void) {
		this.persist = persist;
		this.notify = notify;
	}

	/** Restore metadata, never replay interrupted work with possible external side effects. */
	restore(record: TaskRecord): void {
		this.records.set(record.task.id, record);
	}

	/** Convert abandoned executions into explicit recoverable facts after reopening a session. */
	recover(): void {
		for (const record of this.records.values()) {
			if (record.execution.state.status === "running") {
				this.finish(
					record,
					"interrupted",
					"The previous executor stopped. Inspect its work before starting another execution.",
				);
			}
		}
	}

	/** Register work before starting the executor and return without waiting for its result. */
	start(input: Omit<Task, "id" | "createdAt">, executor: Executor): TaskRecord {
		if (this.closed) throw new Error("Task runtime is closed");
		if (this.active.size >= 4) throw new Error("Four background tasks are already running; wait or cancel one.");
		const startedAt = new Date().toISOString();
		const task: Task = { ...input, request: { ...input.request }, id: randomUUID(), createdAt: startedAt };
		const record: TaskRecord = {
			task,
			execution: { id: randomUUID(), taskId: task.id, startedAt, state: { status: "running" } },
		};
		this.persist(record);
		this.records.set(task.id, record);
		const controller = new AbortController();
		const done = Promise.resolve()
			.then(() => {
				controller.signal.throwIfAborted();
				return executor(task, controller.signal);
			})
			.then(
				(result) =>
					this.finish(
						record,
						controller.signal.aborted ? "cancelled" : result.success ? "completed" : "failed",
						result.result,
					),
				(error: unknown) => this.finish(record, controller.signal.aborted ? "cancelled" : "failed", String(error)),
			)
			.finally(() => this.active.delete(task.id));
		this.active.set(task.id, { controller, done });
		return record;
	}

	/** Cancellation belongs to the background task, not the foreground turn's abort signal. */
	cancel(taskId: string): void {
		if (!this.records.has(taskId)) throw new Error("Unknown task ID in this session");
		this.active.get(taskId)?.controller.abort();
	}

	/** Release session-owned processes before Pi invalidates the extension runtime. */
	async close(): Promise<void> {
		this.closed = true;
		for (const execution of this.active.values()) execution.controller.abort();
		await Promise.all([...this.active.values()].map((execution) => execution.done));
	}

	/** Rebuild events from persisted terminal records; a stable ID supports delivery deduplication. */
	events(): CompletionEvent[] {
		return [...this.records.values()].flatMap(({ task, execution }) => {
			if (execution.state.status === "running") return [];
			return [
				{
					id: `finished:${execution.id}`,
					type: "task_finished" as const,
					taskId: task.id,
					executionId: execution.id,
					sessionId: task.request.sessionId,
					request: task.request,
					description: task.description,
					context: task.context,
					startedAt: execution.startedAt,
					...execution.state,
				},
			];
		});
	}

	private finish(record: TaskRecord, status: CompletionEvent["status"], result: string): void {
		record.execution.state = { status, finishedAt: new Date().toISOString(), result };
		this.persist(record);
		if (!this.closed) this.notify();
	}
}
