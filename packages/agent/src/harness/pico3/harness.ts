import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { TSchema } from "typebox";
import { createHookRunners, type HookRegistration } from "./hooks.ts";
import { chooseThrough, collapse } from "./kinds/collapse.ts";
import { entries as builtinEntries } from "./kinds/entries.ts";
import { generation } from "./kinds/generation.ts";
import { job } from "./kinds/job.ts";
import { plugin } from "./kinds/plugin.ts";
import { postTools } from "./kinds/post-tools.ts";
import { tool } from "./kinds/tool.ts";
import { Scheduler } from "./scheduler.ts";
import { isCoreKind, Session, type TxImpl } from "./session.ts";
import { type SystemSection, systemSections } from "./system.ts";
import {
	type AnyKind,
	type AnyToolDeclaration,
	type ConfigFacade,
	type ConfigOfKinds,
	type ContextView,
	type Conversation,
	type ConversationSpec,
	type DisjointConfig,
	type DocRef,
	type Entry,
	type EntryKind,
	type EntryScan,
	Forbidden,
	type HooksOf,
	type HostTx,
	type Id,
	type Input,
	type Invoker,
	type JsonObject,
	type JsonValue,
	type Models,
	type Namespace,
	type NamespaceDefaults,
	type NamespaceRegistration,
	type NewEntry,
	type PluginHandler,
	type ProcessHost,
	type RewindableState,
	type Runtime,
	type SendInput,
	type StickyState,
	type Storage,
	type Task,
	type ToolDeclaration,
	type UserInput,
} from "./types.ts";
import { ViewManager, type Watch } from "./view.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface HarnessOptions<Ks extends readonly AnyKind[] = []> {
	models: Models;
	tools?: AnyToolDeclaration[];
	/** Ordinary kinds authored with `defineTask`. Their `config` merges onto `c.config`; keys must be disjoint. */
	taskKinds?: Ks;
	sections?: SystemSection[];
	plugins?: { [name: string]: PluginHandler };
	processHost?: ProcessHost;
	/** Clock for durable kernel timestamps and retry scheduling. */
	now?: () => number;
	root?: { rewindable?: Partial<RewindableState>; sticky?: Partial<StickyState> };
	/** Errors from listeners, hooks, watches, and the scheduler. Never delivered as commit failures. */
	onReport?: (error: unknown) => void;
}

export type BuiltinKinds = readonly [
	typeof generation,
	typeof tool,
	typeof postTools,
	typeof collapse,
	typeof job,
	typeof plugin,
];
export type ConfigFor<Ks extends readonly AnyKind[]> = ConfigOfKinds<[...BuiltinKinds, ...Ks]>;

export interface ConversationHandle<Cfg extends object = ConfigFor<[]>> {
	readonly id: Id;
	readonly config: ConfigFacade<Cfg>;
	send(input: SendInput, ctx: Context): Promise<InputHandle>;
	write(entry: NewEntry, ctx: Context): Promise<Id>;
	commit<T>(fn: (tx: HostTx, ctx: Context) => T | Promise<T>, ctx: Context): Promise<T>;
	rewindable(ctx: Context): Promise<RewindableState>;
	sticky(ctx: Context): Promise<StickyState>;
	context(ctx: Context): Promise<ContextView>;
	fork(at: Id | "start", spec: Omit<ConversationSpec, "parent">, ctx: Context): Promise<ConversationHandle<Cfg>>;
	collapse(instructions: string | undefined, ctx: Context): Promise<Id>;
	reset(handoff: string | undefined, ctx: Context): Promise<void>;
	abort(ctx: Context): Promise<void>;
	waitForIdle(ctx: Context): Promise<void>;
	hooks<T extends JsonObject, K extends AnyKind>(
		namespace: Namespace<T>,
		kind: K,
		handlers: Partial<HooksOf<K>>,
		opts?: { subtree?: boolean },
	): () => void;
	watch(ctx: Context): Promise<Watch>;
}
export interface InputHandle {
	readonly id: Id;
	result(ctx: Context): Promise<Input | undefined>;
	wait(ctx: Context): Promise<Input>;
	abort(ctx: Context): Promise<"aborted" | "already_placed" | "not_found">;
}

const KERNEL: Invoker = { type: "kernel" };

export class Harness<Ks extends readonly AnyKind[] = []> {
	private readonly session: Session;
	private readonly scheduler: Scheduler;
	private readonly views: ViewManager;
	private readonly kinds: Map<string, AnyKind>;
	private readonly namespaces = new Map<string, NamespaceRegistration>();
	private readonly tools = new Map<string, AnyToolDeclaration>();
	private readonly sectionMap = new Map<string, SystemSection>();
	private readonly entryKinds = new Map<string, EntryKind>();
	private readonly revisions = { sections: 0, tools: 0 };
	private readonly plugins: Map<string, PluginHandler>;
	private readonly hookRegistrations: HookRegistration[] = [];
	private readonly conversationListeners = new Set<(conversation: ConversationHandle<ConfigFor<Ks>>) => void>();
	private readonly onReport: (error: unknown) => void;
	private readonly now: () => number;
	private readonly ctx: Context;
	private readonly options: HarnessOptions<Ks>;
	private resumed = false;
	private suspended = false;

	static async open<Ks extends readonly AnyKind[] = []>(
		storage: Storage,
		options: HarnessOptions<Ks> &
			(DisjointConfig<[...BuiltinKinds, ...Ks]> extends true
				? unknown
				: { readonly __error: "config keys collide across kinds" }),
		ctx: Context,
	): Promise<Harness<Ks>> {
		const h = new Harness<Ks>(storage, options, ctx);
		await h.init();
		return h;
	}

	private constructor(storage: Storage, options: HarnessOptions<Ks>, ctx: Context) {
		this.ctx = ctx;
		this.options = options;
		this.now = options.now ?? Date.now;
		this.onReport = (error) => {
			try {
				options.onReport?.(error);
			} catch {}
		};
		// Fixed core, installed internally. User kinds may not replace or shadow a built-in.
		const builtins: AnyKind[] = [generation, tool, postTools, collapse, job, plugin];
		this.kinds = new Map(builtins.map((k) => [k.name, k]));
		for (const k of options.taskKinds ?? []) {
			if (k.name.startsWith("pi."))
				throw new Error(`task kind "${k.name}": names beginning with "pi." are reserved`);
			if (this.kinds.has(k.name)) throw new Error(`task kind "${k.name}" registered twice`);
			this.kinds.set(k.name, k);
		}
		for (const t of options.tools ?? []) this.registerTool(t, "open");
		for (const s of Object.values(systemSections)) this.sectionMap.set(s.key, s as SystemSection);
		for (const s of options.sections ?? []) this.registerSection(s, "open");
		for (const e of Object.values(builtinEntries)) this.entryKinds.set(e.kind, e as EntryKind);
		this.plugins = new Map(Object.entries(options.plugins ?? {}));
		this.session = new Session(storage, this.kinds, this.namespaces, this.now); // throws if the Storage already has an owner; validates config disjointness
		this.session.onReport = this.onReport;
		this.views = new ViewManager(this.session, this.onReport);
		this.session.lineListeners.add((result) => this.views.update(result));
		this.session.listeners.add((result) => {
			this.views.deliver();
			for (const conversation of result.changes.conversations) this.notifyConversation(conversation);
		});
		const self = this;
		const hooksFor = createHookRunners(
			() => this.hookRegistrations,
			(c) => this.session.index.ancestors(c),
			this.onReport,
		);
		this.scheduler = new Scheduler({
			session: this.session,
			kinds: this.kinds,
			onReport: this.onReport,
			ctx,
			runtime(task, invoker, _ictx): Runtime {
				return {
					taskId: task.id,
					conversationId: task.conversationId,
					kind: invoker.kind,
					commit: (fn, c) => {
						const owns = self.session.liveTasks.get(task.id)?.owns ?? [];
						const docs = owns.flatMap((id): DocRef[] => [
							{ doc: "rewindable", conversationId: id },
							{ doc: "sticky", conversationId: id },
						]);
						return self.session
							.commit(invoker, (tx, lineCtx) => fn(tx, self.session.liveTasks.get(task.id)!, lineCtx), c, {
								docs,
							})
							.then((r) => r.value);
					},
					hooks: hooksFor(invoker.kind, { taskId: task.id, conversationId: task.conversationId }),
					models: options.models,
					tools: self.tools,
					registries: {
						sections: {
							map: self.sectionMap,
							get revision() {
								return self.revisions.sections;
							},
						},
						tools: {
							map: self.tools,
							get revision() {
								return self.revisions.tools;
							},
						},
					},
					kinds: self.kinds,
					processHost: options.processHost,
					plugins: self.plugins,
					now: self.now,
					sleep: (untilMs, c) =>
						new Promise((resolve, reject) => {
							const ms = Math.max(0, untilMs - Date.now());
							const t = setTimeout(() => {
								c.abortSignal?.removeEventListener("abort", onAbort);
								resolve();
							}, ms);
							const onAbort = () => {
								clearTimeout(t);
								reject(c.abortSignal?.reason ?? new Error("aborted"));
							};
							c.abortSignal?.addEventListener("abort", onAbort, { once: true });
						}),
					waitForInput: (id, c) => self.scheduler.waitForInput(id, c),
					waitForTask: (id, c) => self.scheduler.waitForTask(id, c),
					abortTask: async (id, c) => {
						await self.session.onLine(async (lineCtx) => {
							self.assertInvocation(invoker);
							const target = self.session.liveTasks.get(id) ?? (await self.session.storage.task(id, lineCtx));
							if (target === undefined) throw new Error(`task ${id} not found`);
							self.assertTaskConversationScope(task.id, target.conversationId);
						}, c);
						return self.scheduler.abortTask(id, c);
					},
					abortConversation: async (id, c) => {
						await self.session.onLine(() => {
							self.assertInvocation(invoker);
							self.assertOwnedConversation(task.id, id);
						}, c);
						const h = await self.conversation(id, c);
						if (h) await h.abort(c);
					},
					createOwnedConversation: (spec, c) =>
						self.session
							.commit(
								KERNEL,
								(tx) => {
									self.assertInvocation(invoker);
									return tx.createOwnedConversation(task.id, task.conversationId, spec);
								},
								c,
							)
							.then((result) => result.value),
					sendOwned: (id, input, c) =>
						self.session
							.commit(
								KERNEL,
								(tx) => {
									self.assertInvocation(invoker);
									self.assertOwnedConversation(task.id, id);
									return tx.send(id, input);
								},
								c,
								{
									docs: [
										{ doc: "rewindable", conversationId: id },
										{ doc: "sticky", conversationId: id },
									],
								},
							)
							.then((r) => r.value),
					context: (c, at, cx) => self.session.commit(invoker, (tx) => tx.context(c, at), cx).then((r) => r.value),
					newestEntry: (c, opts, cx) =>
						self.session.commit(invoker, (tx) => tx.newestEntry(c, opts), cx).then((r) => r.value),
					rewindable: (c, cx) =>
						self.session
							.commit(invoker, (tx) => tx.snapshot({ doc: "rewindable", conversationId: c }), cx, {
								docs: [{ doc: "rewindable", conversationId: c }],
							})
							.then((r) => r.value),
					sticky: (c, cx) =>
						self.session
							.commit(invoker, (tx) => tx.snapshot({ doc: "sticky", conversationId: c }), cx, {
								docs: [{ doc: "sticky", conversationId: c }],
							})
							.then((r) => r.value),
					rewindableAsOf: (c, at, cx) =>
						self.session.commit(invoker, (tx) => tx.rewindableAsOf(c, at), cx).then((r) => r.value),
				};
			},
		});
	}

	private notifyConversation(conversation: Conversation): void {
		if (this.conversationListeners.size === 0) return;
		const handle = this.handle(conversation);
		for (const listener of [...this.conversationListeners]) {
			try {
				listener(handle);
			} catch (error) {
				this.onReport(error);
			}
		}
	}

	private assertInvocation(invoker: Extract<Invoker, { type: "task" }>): void {
		if (!invoker.token.alive) throw new Forbidden("operation from a finished invocation");
		const live = this.session.liveTasks.get(invoker.id);
		if (live === undefined) throw new Forbidden("operation from a task that is not live");
		if (invoker.mode === "run" && live.abort === true) throw new Forbidden("operation from a marked run invocation");
	}

	private assertTaskConversationScope(taskId: Id, conversationId: Id): void {
		const task = this.session.liveTasks.get(taskId);
		if (task?.conversationId === conversationId) return;
		if (task?.owns.some((root) => this.session.index.subtree(root).has(conversationId))) return;
		throw new Forbidden(`conversation ${conversationId} is outside task ${taskId}'s subtree`);
	}

	private assertOwnedConversation(taskId: Id, conversationId: Id): void {
		const task = this.session.liveTasks.get(taskId);
		if (task === undefined || !task.owns.some((root) => this.session.index.subtree(root).has(conversationId))) {
			throw new Forbidden(`conversation ${conversationId} is not owned by task ${taskId}`);
		}
	}

	private async init() {
		const { session } = this;
		const convs = await session.read((s, ctx) => s.conversations(ctx), this.ctx);
		for (const c of convs) session.conversationRecords.set(c.id, c);
		const live = await session.read((s, ctx) => s.scanTasks({ status: ["pending", "running"] }, ctx), this.ctx);
		for (const task of live) session.liveTasks.set(task.id, task);
		// Owner tasks that are terminal but still own existing conversations: needed for ancestry.
		const owners = new Set(convs.map((c) => c.owner).filter((o): o is Id => o !== undefined));
		for (const id of owners)
			if (!session.liveTasks.has(id)) {
				const t = await session.read((s, ctx) => s.task(id, ctx), this.ctx);
				if (t) session.ownerTaskCache.set(id, t);
			}
		if (convs.length === 0) {
			await session.commit(
				KERNEL,
				(tx) =>
					tx.createConversation({ rewindable: this.options.root?.rewindable, sticky: this.options.root?.sticky }),
				this.ctx,
			);
		}
	}

	resume() {
		if (this.suspended) throw new Error("cannot resume a suspended harness; reopen storage with a new harness");
		if (this.resumed) return;
		this.resumed = true;
		void this.reconcileOrphans()
			.then(() => {
				if (!this.suspended) this.scheduler.resume();
			})
			.catch((error) => this.onReport(error));
	}
	private async reconcileOrphans(): Promise<void> {
		const orphaned = [...this.session.liveTasks.values()].filter((task) => !this.kinds.has(task.kind));
		if (orphaned.length === 0) return;
		const docs = [...new Set(orphaned.map((task) => task.conversationId))].map(
			(conversationId): DocRef => ({ doc: "sticky", conversationId }),
		);
		await this.session.commit(
			KERNEL,
			(tx) => {
				for (const task of orphaned) tx.setTask({ ...task, status: "terminal", outcome: { status: "orphaned" } });
			},
			this.ctx,
			{ docs },
		);
	}
	quiescent(): boolean {
		return this.scheduler.quiescent();
	}
	hold(): () => void {
		if (!this.scheduler.quiescent()) throw new Error("cannot hold a non-quiescent harness; suspend it instead");
		return this.scheduler.hold();
	}
	/** Cancel and join in-process invocations, clear transient waits, then close without terminalizing tasks. */
	async suspend(ctx: Context): Promise<void> {
		if (this.suspended) return;
		this.suspended = true;
		await this.scheduler.joinAll();
		const tools = [...this.session.liveTasks.values()].filter((task) => task.kind === "pi.tool");
		if (tools.length > 0) {
			const docs = [...new Set(tools.map((task) => task.conversationId))].map(
				(conversationId): DocRef => ({ doc: "sticky", conversationId }),
			);
			await this.session.commit(
				KERNEL,
				(tx) => {
					for (const task of tools) {
						const index = (task.input as { index: number }).index;
						const slot = tx.sticky(task.conversationId).turn.tools[index];
						if (slot?.waitingOn !== undefined) delete slot.waitingOn;
					}
				},
				ctx,
				{ docs },
			);
		}
		this.views.close();
		await this.session.close(ctx);
	}

	// --- registries --------------------------------------------------------------

	registerTaskKind<K extends AnyKind>(kind: K): () => void {
		if (kind.name.startsWith("pi."))
			throw new Error(`task kind "${kind.name}": names beginning with "pi." are reserved`);
		if (this.kinds.has(kind.name)) throw new Error(`task kind "${kind.name}" already registered`);
		this.session.defaults.register(kind);
		this.kinds.set(kind.name, kind);
		this.scheduler.kick();
		return () => {
			if (this.kinds.get(kind.name) !== kind) return;
			this.kinds.delete(kind.name);
			this.session.defaults.unregister(kind);
		};
	}

	namespace<T extends JsonObject>(
		id: string,
		defaults: NamespaceDefaults<T>,
		opts: { view?: (slice: Readonly<T>) => JsonValue } = {},
	): Namespace<T> {
		if (!/^[a-z][a-z0-9_.-]*$/i.test(id) || id.startsWith("pi.")) throw new Error(`invalid namespace "${id}"`);
		if (this.namespaces.has(id)) throw new Error(`namespace "${id}" already registered`);
		const stored = JSON.parse(JSON.stringify(defaults)) as {
			rewindable?: JsonObject;
			sticky?: JsonObject;
			session?: JsonObject;
		};
		const routes = new Map<string, "rewindable" | "sticky" | "session">();
		for (const doc of ["rewindable", "sticky", "session"] as const) {
			for (const key of Object.keys(stored[doc] ?? {})) {
				if (routes.has(key))
					throw new Error(`namespace "${id}" key "${key}" is declared in more than one document`);
				routes.set(key, doc);
			}
		}
		let token!: Namespace<T>;
		token = {
			id,
			unregister: () => {
				if (this.namespaces.get(id)?.token !== token) return;
				this.namespaces.delete(id);
				for (let index = this.hookRegistrations.length - 1; index >= 0; index--) {
					if ((this.hookRegistrations[index]!.namespace as object) === token)
						this.hookRegistrations.splice(index, 1);
				}
			},
		};
		const registration: NamespaceRegistration = {
			token,
			defaults: {
				rewindable: stored.rewindable ?? {},
				sticky: stored.sticky ?? {},
				session: stored.session ?? {},
			},
			routes,
			project: opts.view === undefined ? undefined : (slice) => opts.view!(slice as Readonly<T>),
		};
		this.namespaces.set(id, registration);
		return token;
	}

	/** Register a tool. A duplicate name rejects. Unregister removes only this exact declaration; idempotent. */
	registerTool(tool: AnyToolDeclaration, at: "open" | "runtime" = "runtime"): () => void {
		if (this.tools.has(tool.name)) throw new Error(`tool "${tool.name}" already registered`);
		this.tools.set(tool.name, tool);
		this.revisions.tools++;
		void at;
		return () => {
			if (this.tools.get(tool.name) === tool) {
				this.tools.delete(tool.name);
				this.revisions.tools++;
			}
		};
	}
	registerSection(section: SystemSection, at: "open" | "runtime" = "runtime"): () => void {
		if (this.sectionMap.has(section.key)) throw new Error(`section "${section.key}" already registered`);
		this.sectionMap.set(section.key, section);
		this.revisions.sections++;
		void at;
		return () => {
			if (this.sectionMap.get(section.key) === section) {
				this.sectionMap.delete(section.key);
				this.revisions.sections++;
			}
		};
	}
	registerEntryKind(kind: EntryKind): () => void {
		if (kind.kind.startsWith("pi."))
			throw new Error(`entry kind "${kind.kind}": names beginning with "pi." are reserved`);
		if (this.entryKinds.has(kind.kind)) throw new Error(`entry kind "${kind.kind}" already registered`);
		this.entryKinds.set(kind.kind, kind);
		return () => {
			if (this.entryKinds.get(kind.kind) === kind) this.entryKinds.delete(kind.kind);
		};
	}
	/** Register namespace-bound handlers for one kind's hook points, harness-wide. Both tokens must be current. */
	hooks<T extends JsonObject, K extends AnyKind>(
		namespace: Namespace<T>,
		kind: K,
		handlers: Partial<HooksOf<K>>,
		_opts?: Readonly<Record<string, never>>,
	): () => void {
		return this.addHooks({ namespace: this.checkNamespace(namespace), kind: this.checkKind(kind), handlers });
	}
	private checkKind(kind: AnyKind): AnyKind {
		if (this.kinds.get(kind.name) !== kind) throw new Error(`kind "${kind.name}" is not the registered token`);
		return kind;
	}
	private checkNamespace<T extends JsonObject>(namespace: Namespace<T>): Namespace<JsonObject> {
		if (this.namespaces.get(namespace.id)?.token !== namespace)
			throw new Forbidden(`namespace "${namespace.id}" is stale`);
		return namespace as unknown as Namespace<JsonObject>;
	}
	private addHooks(reg: HookRegistration): () => void {
		this.hookRegistrations.push(reg);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			const index = this.hookRegistrations.indexOf(reg);
			if (index >= 0) this.hookRegistrations.splice(index, 1);
		};
	}

	// --- conversations -------------------------------------------------------------

	async root(ctx: Context): Promise<ConversationHandle<ConfigFor<Ks>>> {
		return this.conversation(1, ctx).then((c) => c!);
	}
	onConversation(listener: (conversation: ConversationHandle<ConfigFor<Ks>>) => void): () => void {
		this.conversationListeners.add(listener);
		for (const conversation of this.session.conversationRecords.values()) {
			try {
				listener(this.handle(conversation));
			} catch (error) {
				this.onReport(error);
			}
		}
		return () => this.conversationListeners.delete(listener);
	}
	async conversation(id: Id, ctx: Context): Promise<ConversationHandle<ConfigFor<Ks>> | undefined> {
		const c = await this.session.read((s, lineCtx) => s.conversation(id, lineCtx), ctx);
		return c === undefined ? undefined : this.handle(c);
	}
	async createConversation(
		spec: ConversationSpec & { input?: UserInput },
		ctx: Context,
	): Promise<ConversationHandle<ConfigFor<Ks>>> {
		const { input, ...rest } = spec;
		const id = await this.session
			.commit(
				KERNEL,
				async (tx) => {
					const id = tx.createConversation(rest);
					if (input !== undefined) await tx.send(id, { content: input });
					return id;
				},
				ctx,
			)
			.then((r) => r.value);
		return (await this.conversation(id, ctx))!;
	}
	entries(scan: EntryScan, ctx: Context): Promise<Entry[]> {
		return this.session.read((s, lineCtx) => s.scanEntries(scan, lineCtx), ctx);
	}
	getTask(id: Id, ctx: Context): Promise<Task | undefined> {
		return this.session.read((s, lineCtx) => s.task(id, lineCtx), ctx);
	}
	async abortInput(id: Id, ctx: Context, conversationId?: Id): Promise<"aborted" | "already_placed" | "not_found"> {
		if (conversationId !== undefined) {
			const input = await this.session.read((storage, lineCtx) => storage.input(id, lineCtx), ctx);
			if (input !== undefined && input.conversationId !== conversationId)
				throw new Forbidden(`input ${id} is outside conversation ${conversationId}`);
		}
		return this.inputHandle(id).abort(ctx);
	}
	abortTask(id: Id, ctx: Context): Promise<"marked" | "terminal"> {
		return this.scheduler.abortTask(id, ctx);
	}
	/** Durably mark a task for abort without signalling its invocation; the scheduler aborts it when it next drains. */
	markTask(id: Id, ctx: Context): Promise<"marked" | "terminal"> {
		return this.session
			.commit(
				KERNEL,
				async (tx) => {
					const t = await tx.task(id);
					if (t === undefined) throw new Error(`task ${id} not found`);
					if (t.status === "terminal") return "terminal" as const;
					tx.markTask(id);
					return "marked" as const;
				},
				ctx,
			)
			.then((r) => r.value);
	}
	waitForIdle(ctx: Context): Promise<void> {
		return this.scheduler.waitForIdle(undefined, ctx);
	}
	waitForTask(id: Id, ctx: Context): Promise<Task> {
		return this.scheduler.waitForTask(id, ctx);
	}

	/** Signals every invocation, waits for them, closes storage. Writes nothing. */
	async close(ctx: Context) {
		await this.suspend(ctx);
	}

	private handle(c: Conversation): ConversationHandle<ConfigFor<Ks>> {
		const self = this;
		const docs: DocRef[] = [
			{ doc: "rewindable", conversationId: c.id },
			{ doc: "sticky", conversationId: c.id },
		];
		const hostInvoker: Invoker = { type: "host", conversationId: c.id };
		const kernelInvoker: Invoker = { type: "kernel", conversationId: c.id };
		const host = <T>(fn: (tx: HostTx, ctx: Context) => T | Promise<T>, ctx: Context) =>
			self.session.commit(hostInvoker, (tx, lineCtx) => fn(tx, lineCtx), ctx, { docs }).then((r) => r.value);
		const kernel = <T>(fn: (tx: TxImpl, ctx: Context) => T | Promise<T>, ctx: Context) =>
			self.session.commit(kernelInvoker, fn, ctx, { docs }).then((r) => r.value);
		const config: ConfigFacade<ConfigFor<Ks>> = {
			get: (ctx) =>
				host((tx) => {
					const cfg = tx.config(c.id);
					const out: { [k: string]: JsonValue | undefined } = {};
					for (const key of self.session.defaults.route.keys()) out[key] = cfg.get(key);
					return out as ConfigFor<Ks>;
				}, ctx),
			set: (patch, ctx) =>
				host((tx) => {
					const cfg = tx.config(c.id);
					for (const [key, value] of Object.entries(patch)) {
						if (value === undefined) throw new Error(`config.set(${key}): use config.reset()`);
						cfg.set(key, value as JsonValue);
					}
				}, ctx),
			reset: (keys, ctx) =>
				host((tx) => {
					const cfg = tx.config(c.id);
					for (const key of keys) cfg.reset(String(key));
				}, ctx),
		};
		return {
			id: c.id,
			config,
			async send(input, ctx) {
				const id = await kernel((tx) => tx.send(c.id, input), ctx);
				return self.inputHandle(id);
			},
			write: (entry, ctx) => host((tx) => tx.write(c.id, entry), ctx),
			commit: host,
			rewindable: (ctx) => host((tx) => tx.snapshot({ doc: "rewindable", conversationId: c.id }), ctx),
			sticky: (ctx) => host((tx) => tx.snapshot({ doc: "sticky", conversationId: c.id }), ctx),
			context: (ctx) => host((tx) => tx.context(c.id), ctx),
			async fork(at, spec, ctx) {
				const id = await self.session.fork(c.id, at, spec, ctx);
				return (await self.conversation(id, ctx))!;
			},
			collapse: (instructions, ctx) =>
				kernel(async (tx) => {
					const { entries } = await tx.context(c.id);
					const state = tx.rewindable(c.id);
					const through = chooseThrough(entries, state.keepRecent);
					if (through === undefined) throw new Error("nothing to collapse");
					return tx.createTask({
						kind: "pi.collapse",
						conversationId: c.id,
						background: true,
						input: { reason: "manual", through, ...(instructions === undefined ? {} : { instructions }) },
					});
				}, ctx),
			reset: async (handoff, ctx) => {
				await kernel(
					(tx) =>
						tx.write(
							c.id,
							handoff === undefined
								? { kind: "pi.reset", head: "self" }
								: {
										kind: "pi.handoff",
										head: "self",
										model: [{ role: "user", content: handoff, timestamp: self.now() }],
									},
						),
					ctx,
				);
			},
			async abort(ctx) {
				const owned: Id[] = [];
				const marked = await kernel(async (tx) => {
					const s = tx.sticky(c.id);
					const withdrawn = s.inbox.filter((q) => q.mode !== "write").map((q) => q.id);
					for (let i = s.inbox.length - 1; i >= 0; i--) if (s.inbox[i]!.mode !== "write") s.inbox.splice(i, 1);
					await tx.resolveInputs(withdrawn, { status: "unanswered", reason: "aborted" });
					for (const input of withdrawn) tx.emit({ type: "input.aborted", input });
					const ids: Id[] = [];
					for (const t of [...self.session.liveTasks.values()]) {
						if (t.conversationId !== c.id || t.background) continue;
						for (const o of t.owns) owned.push(o);
						if (t.abort !== true) tx.markTask(t.id);
						ids.push(t.id);
					}
					return ids;
				}, ctx);
				for (const id of marked) await self.scheduler.abortTask(id, ctx);
				await self.scheduler.waitForIdle(c.id, ctx);
				await Promise.all(owned.map((o) => self.scheduler.waitForIdle(o, ctx)));
			},
			waitForIdle: (ctx) => self.scheduler.waitForIdle(c.id, ctx),
			hooks: (namespace, kind, handlers, opts) =>
				self.addHooks({
					namespace: self.checkNamespace(namespace),
					kind: self.checkKind(kind),
					handlers,
					conversationId: c.id,
					subtree: opts?.subtree,
				}),
			watch: (ctx) => self.watch(c, ctx),
		};
	}

	/** Capture and subscribe in one line operation. */
	private async watch(conversation: Conversation, ctx: Context): Promise<Watch> {
		return this.session
			.commit(
				{ type: "host", conversationId: conversation.id },
				async (tx) => {
					const entries = await captureActiveTranscript((scan) => tx.scanEntries(scan), conversation.id);
					return this.views.watch(conversation, entries);
				},
				ctx,
				{
					docs: [
						{ doc: "rewindable", conversationId: conversation.id },
						{ doc: "sticky", conversationId: conversation.id },
					],
				},
			)
			.then((result) => result.value);
	}

	private inputHandle(id: Id): InputHandle {
		return {
			id,
			result: (ctx) => this.session.read((s, lineCtx) => s.input(id, lineCtx), ctx),
			wait: (ctx) => this.scheduler.waitForInput(id, ctx),
			abort: (ctx) =>
				this.session.commit(KERNEL, (tx) => tx.withdrawInput(id), ctx, { docs: [] }).then((r) => r.value),
		};
	}
}

/**
 * §9: H = newest fork-visible entry with a head. Active transcript = H plus every fork-visible entry
 * with id ≥ H.head, chronological, nothing dropped inside the range; the whole transcript if no head.
 */
export async function captureActiveTranscript(
	scan: (s: EntryScan) => Promise<Entry[]>,
	conversationId: Id,
): Promise<Entry[]> {
	const [h] = await scan({ conversationId, withHead: true, limit: 1 });
	const from = h?.head;
	const out: Entry[] = [];
	let before: Id | undefined;
	for (;;) {
		const page = await scan({ conversationId, ...(before === undefined ? {} : { before }), limit: 256 });
		let done = page.length < 256;
		for (const e of page) {
			if (from !== undefined && e.id < from) {
				done = true;
				break;
			}
			out.push(e);
		}
		if (done) break;
		before = page[page.length - 1]!.id;
	}
	return out.reverse();
}

export { withAbortSignal, isCoreKind };
export type { ConversationView, Envelope, ViewEvent } from "./types.ts";
export type { Watch } from "./view.ts";
export { applyEnvelope, WATCH_CAPACITY } from "./view.ts";
/** The built-in kinds, as typed witnesses for `api.task`, `waitForTask`, and `hooks(kind, …)`. */
export const kinds = { generation, tool, postTools, collapse, job, plugin } as const;
export const entries = builtinEntries;
export type { ToolDeclaration, TSchema };
