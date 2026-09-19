import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { Session, TxImpl } from "./session.ts";
import {
	type AnyKind,
	type Checkpoint,
	type Completion,
	type Id,
	type Input,
	InvocationToken,
	type Invoker,
	type JsonValue,
	type Outcome,
	type Runtime,
	type Step,
	type Task,
	TaskContractFault,
} from "./types.ts";

interface Invocation {
	task: Task;
	mode: "run" | "abort";
	controller: AbortController;
	done: Promise<void>;
}

export interface SchedulerDeps {
	session: Session;
	kinds: ReadonlyMap<string, AnyKind>;
	runtime(task: Task, invoker: Extract<Invoker, { type: "task" }>, ctx: Context): Runtime;
	onReport(error: unknown): void;
	ctx: Context;
}

/**
 * The erased-kind adapter: the one place a concrete `Kind<…>` is called through `AnyKind`
 * and its outputs are validated. A handler that throws or returns an invalid shape is a
 * contract fault, recorded as `{ status: "faulted" }` — never a manufactured declared failure.
 */
type Handler = (task: Task, rt: Runtime, ctx: Context) => Promise<Step<Checkpoint, JsonValue, JsonValue>>;
function handlerFor(kind: AnyKind, phase: string | undefined): Handler {
	const h = phase === undefined ? kind.initial : kind.phases[phase];
	if (typeof h !== "function") throw new TaskContractFault(kind.name, `no handler for phase ${phase ?? "initial"}`);
	return h as Handler;
}
function validateStep(kind: AnyKind, step: unknown): Step<Checkpoint, JsonValue, JsonValue> {
	if (typeof step !== "object" || step === null)
		throw new TaskContractFault(kind.name, "handler returned a non-object step");
	if ("done" in step && typeof (step as { done: unknown }).done === "function")
		return step as Step<Checkpoint, JsonValue, JsonValue>;
	if ("next" in step) {
		const n = (step as { next: unknown }).next;
		if (typeof n === "function") return step as Step<Checkpoint, JsonValue, JsonValue>;
		if (typeof n === "object" && n !== null && typeof (n as { phase?: unknown }).phase === "string") {
			if (!((n as { phase: string }).phase in kind.phases))
				throw new TaskContractFault(kind.name, `transition to unknown phase ${(n as { phase: string }).phase}`);
			return step as Step<Checkpoint, JsonValue, JsonValue>;
		}
	}
	throw new TaskContractFault(kind.name, "handler returned an invalid step");
}
function validateCompletion(kind: AnyKind, c: unknown): Completion<JsonValue, JsonValue> {
	if (typeof c === "object" && c !== null) {
		const s = (c as { status?: unknown }).status;
		if (s === "completed" && "result" in c) return c as Completion<JsonValue, JsonValue>;
		if (s === "failed" && "failure" in c) return c as Completion<JsonValue, JsonValue>;
	}
	throw new TaskContractFault(kind.name, "closure returned an invalid completion");
}
function validateCheckpoint(kind: AnyKind, cp: unknown): Checkpoint {
	if (typeof cp !== "object" || cp === null || typeof (cp as { phase?: unknown }).phase !== "string")
		throw new TaskContractFault(kind.name, "invalid checkpoint");
	const phase = (cp as { phase: string }).phase;
	if (!(phase in kind.phases)) throw new TaskContractFault(kind.name, `checkpoint names unknown phase ${phase}`);
	if (kind.inflight?.includes(phase))
		throw new TaskContractFault(
			kind.name,
			`transition into in-flight phase ${phase}; write it with rt.commit before the effect instead`,
		);
	JSON.stringify(cp);
	return cp as Checkpoint;
}

export class Scheduler {
	private readonly deps: SchedulerDeps;
	private enabled = false;
	private holds = 0;
	private dirty = false;
	private draining = false;
	private readonly invocations = new Map<Id, Invocation>();
	private readonly taskWaiters = new Map<Id, Set<(t: Task) => void>>();
	private readonly inputWaiters = new Map<Id, Set<(i: Input) => void>>();
	private readonly idleWaiters = new Set<{ conversationId: Id | undefined; resolve: () => void }>();

	constructor(deps: SchedulerDeps) {
		this.deps = deps;
		deps.session.listeners.add((r) => {
			for (const t of r.changes.tasks) {
				const inv = this.invocations.get(t.id);
				if (t.abort === true && inv?.mode === "run") inv.controller.abort();
			}
			for (const task of r.changes.tasks)
				if (task.status === "terminal")
					this.taskWaiters.get(task.id)?.forEach((waiter) => {
						waiter(task);
					});
			for (const input of r.changes.inputs)
				if (input.status === "done" || input.status === "unanswered")
					this.inputWaiters.get(input.id)?.forEach((waiter) => {
						waiter(input);
					});
			if (r.changes.tasks.length > 0) this.kick();
			this.checkIdle();
		});
	}

	resume() {
		this.enabled = true;
		this.kick();
	}
	stop() {
		this.enabled = false;
	}
	hold(): () => void {
		this.holds++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.holds--;
			if (this.holds === 0) this.kick();
		};
	}
	kick() {
		if (!this.enabled) return;
		this.dirty = true;
		if (this.holds === 0 && !this.draining) this.drain().catch((e) => this.deps.onReport(e));
	}

	private async drain() {
		this.draining = true;
		try {
			while (this.dirty && this.enabled && this.holds === 0) {
				this.dirty = false;
				const reserved = await this.reserveEligible();
				if (!this.enabled || this.holds > 0) {
					this.dirty = true;
					break;
				}
				for (const { task, mode } of reserved) this.dispatch(task, mode);
			}
		} finally {
			this.draining = false;
			this.checkIdle();
		}
	}

	/** On the line: reserve every eligible task. */
	private async reserveEligible(): Promise<{ task: Task; mode: "run" | "abort" }[]> {
		const { session } = this.deps;
		const out: { task: Task; mode: "run" | "abort" }[] = [];
		await session.commit(
			{ type: "kernel" },
			async (tx) => {
				for (const task of [...session.liveTasks.values()]) {
					if (!this.deps.kinds.has(task.kind)) continue;
					const inv = this.invocations.get(task.id);
					if (task.abort === true) {
						if (inv?.mode === "abort") continue;
						if (inv?.mode === "run") continue; // winding down; dispatched after it returns
						const running: Task = task.status === "pending" ? { ...task, status: "running" } : task;
						if (running !== task) tx.setTask(running);
						out.push({ task: running, mode: "abort" });
						continue;
					}
					if (inv !== undefined) continue;
					if (task.status === "pending") {
						let ready = true;
						for (const dep of task.after) {
							const d = await tx.task(dep);
							if (d === undefined || d.status !== "terminal") {
								ready = false;
								break;
							}
						}
						if (!ready) continue;
						const running: Task = { ...task, status: "running" };
						tx.setTask(running);
						out.push({ task: running, mode: "run" });
					} else if (task.status === "running") {
						out.push({ task, mode: "run" }); // found at open: dispatch into its current phase
					}
				}
			},
			this.deps.ctx,
		);
		return out;
	}

	private dispatch(task: Task, mode: "run" | "abort") {
		const { session } = this.deps;
		const kind = this.deps.kinds.get(task.kind);
		if (kind === undefined) {
			this.deps.onReport(new Error(`unknown kind ${task.kind} for task ${task.id}`));
			return;
		}
		const controller = new AbortController();
		const ctx = withAbortSignal(controller.signal, this.deps.ctx);
		const done = (async () => {
			try {
				if (mode === "run") {
					const closure = await this.runPhases(task, kind, ctx);
					if (closure === undefined || controller.signal.aborted) return;
					const lease = this.lease(task, kind, mode, ctx);
					try {
						await session.commit(
							lease.invoker,
							async (tx, lineCtx, control) => {
								const current = session.liveTasks.get(task.id);
								if (current === undefined || current.abort === true) return;
								const completion = validateCompletion(
									kind,
									await (closure as (tx: TxImpl, task: Task, ctx: Context) => unknown)(tx, current, lineCtx),
								);
								const patched = (await tx.task(task.id)) ?? current;
								control.setTask({ ...patched, status: "terminal", outcome: completion });
							},
							ctx,
							{ closing: true },
						);
					} finally {
						lease.token.revoke();
					}
				} else {
					const handlerLease = this.lease(task, kind, mode, ctx);
					let closure: (tx: TxImpl, task: Task, ctx: Context) => unknown;
					try {
						closure = await (
							kind.abort as (
								task: Task,
								runtime: Runtime,
								ctx: Context,
							) => Promise<(tx: TxImpl, task: Task, ctx: Context) => unknown>
						)(task, handlerLease.runtime, ctx);
					} finally {
						handlerLease.token.revoke();
					}
					const closureLease = this.lease(task, kind, mode, ctx);
					try {
						await session.commit(
							closureLease.invoker,
							async (tx, lineCtx, control) => {
								const current = session.liveTasks.get(task.id);
								if (current === undefined) return;
								const result = (await closure(tx, current, lineCtx)) as JsonValue;
								JSON.stringify(result);
								const patched = (await tx.task(task.id)) ?? current;
								control.setTask({ ...patched, status: "terminal", outcome: { status: "aborted", result } });
							},
							ctx,
							{ closing: true },
						);
					} finally {
						closureLease.token.revoke();
					}
				}
			} catch (error) {
				if (controller.signal.aborted) return;
				// Contract fault or unexpected throw: the task ends `faulted`, never as a declared failure.
				this.deps.onReport(error);
				await session
					.commit(
						{ type: "kernel" },
						async (tx) => {
							const current = session.liveTasks.get(task.id);
							if (current === undefined) return;
							const outcome: Outcome = {
								status: "faulted",
								error: error instanceof TaskContractFault ? error.message : `${kind.name}: ${String(error)}`,
							};
							tx.setTask({ ...current, status: "terminal", outcome });
							// A faulted turn task: its inputs would otherwise stay placed forever; the turn state is stale.
							if (kind.turn) {
								const inputs = (current.input as { inputs?: unknown }).inputs;
								if (Array.isArray(inputs))
									await tx.resolveInputs(
										inputs.filter((i): i is Id => typeof i === "number"),
										{ status: "unanswered", reason: "failed", detail: outcome.error },
									);
								tx.sticky(current.conversationId).turn = { tools: [] };
							}
						},
						this.deps.ctx,
						{ docs: [{ doc: "sticky", conversationId: task.conversationId }] },
					)
					.catch((e) => this.deps.onReport(e));
			} finally {
				this.invocations.delete(task.id);
				const now = session.liveTasks.get(task.id);
				if (now === undefined) await session.retire(task, this.deps.ctx).catch((e) => this.deps.onReport(e));
				this.kick();
			}
		})();
		this.invocations.set(task.id, { task, mode, controller, done });
	}

	private lease(task: Task, kind: AnyKind, mode: "run" | "abort", ctx: Context) {
		const token = new InvocationToken(task.id, mode);
		const invoker: Extract<Invoker, { type: "task" }> = {
			type: "task",
			token,
			id: task.id,
			conversationId: task.conversationId,
			kind,
			core:
				task.kind.startsWith("pi.") &&
				["pi.generation", "pi.tool", "pi.post_tools", "pi.collapse"].includes(task.kind),
			mode,
		};
		return { token, invoker, runtime: this.deps.runtime(task, invoker, ctx) };
	}

	/** The phase loop. Each handler gets a capability lease revoked when that handler's promise returns. */
	private async runPhases(task: Task, kind: AnyKind, ctx: Context): Promise<unknown> {
		const { session } = this.deps;
		let current = task;
		for (;;) {
			const cp = current.checkpoint;
			const handler = handlerFor(kind, cp?.phase);
			const handlerLease = this.lease(task, kind, "run", ctx);
			let step: Step<Checkpoint, JsonValue, JsonValue>;
			try {
				step = validateStep(kind, await handler(current, handlerLease.runtime, ctx));
			} finally {
				handlerLease.token.revoke();
			}
			if ("done" in step) return step.done;
			if (ctx.abortSignal?.aborted) return undefined;
			const transitionLease = this.lease(task, kind, "run", ctx);
			let outcome: { value: "discard" | "retry" | "terminal" | "advanced" };
			try {
				outcome = await session.commit(
					transitionLease.invoker,
					async (tx, lineCtx, control) => {
						const live = session.liveTasks.get(task.id);
						if (live === undefined || live.abort === true) return "discard" as const;
						const next = typeof step.next === "function" ? await step.next(tx, live, lineCtx) : step.next;
						if (next === "retry") return "retry" as const;
						if (typeof next === "object" && next !== null && "status" in next) {
							const patched = (await tx.task(task.id)) ?? live;
							control.setTask({ ...patched, status: "terminal", outcome: validateCompletion(kind, next) });
							return "terminal" as const;
						}
						const checkpoint = validateCheckpoint(kind, next);
						tx.checkpoint(checkpoint);
						current = { ...live, checkpoint };
						return "advanced" as const;
					},
					ctx,
				);
			} finally {
				transitionLease.token.revoke();
			}
			if (outcome.value === "retry") {
				current = session.liveTasks.get(task.id) ?? current;
				continue;
			}
			if (outcome.value !== "advanced") return undefined;
		}
	}

	/** Mark, revoke, signal, join. The scheduler then reserves the fresh abort on its next drain. */
	async abortTask(id: Id, ctx: Context): Promise<"marked" | "terminal"> {
		const { session } = this.deps;
		const r = await session.commit(
			{ type: "kernel" },
			async (tx) => {
				const task = await tx.task(id);
				if (task === undefined) throw new Error(`task ${id} not found`);
				if (task.status === "terminal") return "terminal" as const;
				if (task.abort !== true) tx.setTask({ ...task, abort: true });
				return "marked" as const;
			},
			ctx,
		);
		if (r.value === "terminal") return "terminal";
		const inv = this.invocations.get(id);
		if (inv?.mode === "run") {
			inv.controller.abort();
			await inv.done;
		}
		this.kick();
		return "marked";
	}

	// --- waiters: registered on the line, atomically with the state read -------------------

	waitForTask(id: Id, ctx: Context): Promise<Task> {
		return this.waiter(ctx, this.taskWaiters, id, (lineCtx) => {
			const live = this.deps.session.liveTasks.get(id);
			return live === undefined ? this.deps.session.storage.task(id, lineCtx) : Promise.resolve(undefined);
		});
	}
	waitForInput(id: Id, ctx: Context): Promise<Input> {
		return this.waiter(ctx, this.inputWaiters, id, async (lineCtx) => {
			const i = await this.deps.session.storage.input(id, lineCtx);
			return i !== undefined && (i.status === "done" || i.status === "unanswered") ? i : undefined;
		});
	}
	/** Read state and install the waiter in one line operation; the wait itself happens off-line. */
	private async waiter<T>(
		ctx: Context,
		table: Map<Id, Set<(v: T) => void>>,
		id: Id,
		terminal: (ctx: Context) => Promise<T | undefined>,
	): Promise<T> {
		ctx.abortSignal?.throwIfAborted();
		const r = await this.deps.session.onLine(async (lineCtx): Promise<{ now: T } | { pending: Promise<T> }> => {
			const now = await terminal(lineCtx);
			if (now !== undefined) return { now };
			return {
				pending: new Promise<T>((resolve, reject) => {
					const set = table.get(id) ?? table.set(id, new Set()).get(id)!;
					const w = (v: T) => {
						set.delete(w);
						ctx.abortSignal?.removeEventListener("abort", onAbort);
						resolve(v);
					};
					const onAbort = () => {
						set.delete(w);
						reject(ctx.abortSignal?.reason ?? new Error("aborted"));
					};
					set.add(w);
					ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
				}),
			};
		}, ctx);
		return "now" in r ? r.now : r.pending;
	}
	async waitForIdle(conversationId: Id | undefined, ctx: Context): Promise<void> {
		ctx.abortSignal?.throwIfAborted();
		const r = await this.deps.session.onLine((): { pending?: Promise<void> } => {
			if (this.isIdle(conversationId)) return {};
			return {
				pending: new Promise<void>((resolve, reject) => {
					const w = {
						conversationId,
						resolve: () => {
							this.idleWaiters.delete(w);
							ctx.abortSignal?.removeEventListener("abort", onAbort);
							resolve();
						},
					};
					const onAbort = () => {
						this.idleWaiters.delete(w);
						reject(ctx.abortSignal?.reason ?? new Error("aborted"));
					};
					this.idleWaiters.add(w);
					ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
				}),
			};
		}, ctx);
		return r.pending;
	}
	private isIdle(conversationId: Id | undefined): boolean {
		for (const t of this.deps.session.liveTasks.values())
			if ((conversationId === undefined || t.conversationId === conversationId) && !t.background) return false;
		return true;
	}
	private checkIdle() {
		for (const w of [...this.idleWaiters]) if (this.isIdle(w.conversationId) && !this.draining) w.resolve();
	}

	/** Signal every invocation and wait for them; nothing is written. */
	async joinAll() {
		this.enabled = false;
		for (const inv of this.invocations.values()) inv.controller.abort();
		await Promise.allSettled([...this.invocations.values()].map((invocation) => invocation.done));
	}
	quiescent(): boolean {
		return this.invocations.size === 0;
	}
	get liveInvocations() {
		return this.invocations.size;
	}
}
