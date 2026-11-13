// Locals, registries and natives a session worker host provides to plugins (Chord v2), and the worker's core facet.
import { existsSync } from "node:fs";
import { defineRegistry, local, type Native, type RegistryValue, type Store } from "@earendil-works/chord";
import { copyFiles } from "@earendil-works/chord/app/files";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Watchable, WatchCall, WatchHandle } from "@earendil-works/chord/watch";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type { Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai/models";
import {
	type ConversationId,
	configure,
	type DocumentReader,
	type Conversation as DurableConversation,
	Harness as DurableHarness,
	type HarnessOptions,
	type HarnessSettings,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Connection, LocalExecutionEnv, localDaemon, RemoteExecutionEnv } from "@earendil-works/pi-env";
import {
	type Ctx,
	defineFacet,
	type Facet,
	type FacetHost,
	forbidden,
	keyedRegistry,
	type Self,
	serveKeyed,
} from "./chord.ts";
import { durableContext, durableRegistry, ExtensionSwitches, Extensions } from "./durable.ts";
import { hostFiles, sessionDirectory } from "./host-dirs.ts";
import { isRooted, type Location, type LocationInput, sameLocation } from "./location.ts";
import { topLevelConversations } from "./main-conversation.ts";
import { durableStorage } from "./session-store.ts";
import { type SessionInit, WorkerBoundary } from "./session-worker.ts";

export { ExtensionSwitches, Extensions } from "./durable.ts";
export { type Location, LocationSchema, locationText, sameLocation } from "./location.ts";
export { type SessionInit, WorkerBoundary } from "./session-worker.ts";

/** A worker's start data (JSON, from the server's `start`): `session` from the sessions plugin, more keys from others. */
export type WorkerInit = {
	/** The p2 app directory (`apps/p2`): its sources, docs and vendored files, for facets that start or describe them. */
	readonly app: string;
	readonly dataDir: string;
	readonly fake: boolean;
	/** Whether the worker records telemetry and sends it to the server (settings.json's `telemetry`, read at its start). */
	readonly telemetry: boolean;
	readonly generation: number;
	readonly values: { readonly session: SessionInit } & Readonly<Record<string, JsonValue>>;
};

/**
 * Where the session works now. A worker starts at its spawn location (`SessionInit`) and follows `Sessions.relocate`
 * in place (`Harness.relocate`): plugins read `value` at each use instead of the spawn parameters, and subscribe to
 * reopen what they keep for a location (prompt files, workspace watches). Listeners run once the move is committed:
 * the Harness's environments and the conversations' agent cwds are already at the new location.
 *
 * During a move the Harness's environments switch before the location is committed, so `value` may still name the
 * old location while `Harness.environments` already resolves on the new machine. Decide what depends on the machine
 * from the environment itself (`isLocalEnvironment`), and key what is kept for a location by `version`: it changes
 * when a move is committed, so anything opened before (also during the switch) is older and opened again.
 */
export class SessionLocation {
	#value: Location;
	#version = 0;
	readonly #listeners = new Set<(location: Location) => void>();
	constructor(value: Location) {
		this.#value = value;
	}
	get value(): Location {
		return this.#value;
	}
	/** Counts committed moves. */
	get version(): number {
		return this.#version;
	}
	subscribe(listener: (location: Location) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	/** The next move, or rejects when `signal` aborts first. */
	next(signal: AbortSignal): Promise<Location> {
		return new Promise((resolve, reject) => {
			if (signal.aborted) return reject(signal.reason);
			const done = (): void => {
				stop();
				signal.removeEventListener("abort", abort);
			};
			const abort = (): void => {
				done();
				reject(signal.reason);
			};
			const stop = this.subscribe((location) => {
				done();
				resolve(location);
			});
			signal.addEventListener("abort", abort, { once: true });
		});
	}
	/** Commits a move (the Harness, after switching its environments and the conversations). */
	set(next: Location): void {
		this.#value = next;
		this.#version++;
		for (const listener of [...this.#listeners]) {
			try {
				listener(next);
			} catch (error) {
				console.error("p2 worker: a location listener failed:", error);
			}
		}
	}
}

/**
 * Whether `env` runs on this machine (not an SSH environment; attachments need no copy there). Decided from the
 * environment, not from `SessionLocation.value`, which lags behind the environments during a move.
 */
export const isLocalEnvironment = (env: ExecutionEnv): boolean => !(env instanceof RemoteExecutionEnv);

/** The spawn location of `session`. */
export const spawnLocation = (session: SessionInit): Location => ({ cwd: session.cwd, env: session.env ?? null });

/**
 * Waits before input is submitted to a conversation (all entries, in order). A plugin whose part of the prompt loads
 * asynchronously registers one, so the first message of a fresh worker never runs without it. Example: the prompt
 * plugin waits for its first load of AGENTS.md and skills.
 */
export type InputGate = (ctx: Ctx) => Promise<void>;
export const InputGates = keyedRegistry<InputGate>("p2.input-gates");

/** Plugins synchronize metadata after a browser changes a conversation's agent configuration. */
export const ConversationConfigured =
	keyedRegistry<(conversation: DurableConversation, ctx: Ctx) => Promise<void>>("p2.conversation-configured");

/**
 * Plugins mark conversations read-only for people: a reason refuses `Chat`'s send, dequeue and configure (Stop stays
 * allowed). Example: the subagents plugin's one-shot agents, which belong to the script waiting for their answer.
 */
export const ReadOnlyConversations =
	keyedRegistry<(conversation: number, ctx: Ctx) => Promise<string | undefined>>("p2.read-only-conversations");

/** Model access and run settings for the Harness (the models plugin contributes key "default"). */
export type HarnessConfigEntry = { readonly models: () => Models; readonly settings: () => HarnessSettings };
export const HarnessConfig = keyedRegistry<HarnessConfigEntry>("p2.harness-config");

/**
 * Where the conversations besides the main one work (the subagents plugin, key "subagents"). A conversation either
 * follows the session (subagents spawned without a cwd, one-shot agents) or has its own location, environment and
 * cwd, fixed at spawn (a subagent spawned with a cwd: on the caller's environment). A contributor must not need the
 * Harness (it would wait for itself): it gets the opening Durable Harness, or a reader of its documents, as an
 * argument. Contributed by a facet (no runtime state), so it is there when the Harness opens.
 */
export type ConversationPlacement = {
	/**
	 * Commits what an older version left unplaced (a subagent's own cwd without its environment: the environment it was
	 * spawned on), then lists the conversations that follow the session and the own locations in use. The opening
	 * Harness calls it, and every relocation, and moves the followers whose agent cwd differs to the session's cwd with
	 * the root, in one commit, before it is live: nothing can run or resume in a stale cwd first.
	 */
	place(
		harness: DurableHarness,
		session: Location,
		values: WorkerInit["values"],
		context: Context,
	): Promise<{ readonly followers: readonly ConversationId[]; readonly own: readonly Location[] }>;
	/** A conversation's own location, or undefined: it follows the session. */
	own(read: DocumentReader, id: ConversationId, context: Context): Promise<Location | undefined>;
};
export const ConversationLocations = keyedRegistry<ConversationPlacement>("p2.conversation-locations");

/** One machine's connection: environments at its directories (`at`), and `close` ends the connection. */
export type Machine = { at: (cwd: string) => ExecutionEnv; close: () => void };

/** Execution environments are plugin-provided (key "remote"); a remote location cannot use the local default. */
export type HarnessEnvironmentEntry = {
	/** The machine of the remote environment `env`. Connecting may wait for its first operation. */
	open: (env: string) => Promise<Machine>;
	/** Where environment `env`'s tools run, for the prompt's `cwd` section, e.g. `the SSH host gpu-box`. */
	readonly describe?: (env: string) => Promise<string | undefined>;
	/**
	 * Whether environment `env` is a sandbox, decided by its configuration's type (never its name): conversations
	 * working there cannot leave it. Cheap: read on every confinement check.
	 */
	readonly sandbox: (env: string) => boolean;
};
export const HarnessEnvironments = keyedRegistry<HarnessEnvironmentEntry>("p2.harness-environments");

/**
 * What keeps the worker process alive besides held references (Chord's own count): its Durable tasks, calls under way
 * (`call`), viewers plugins count themselves, conversations whose prompt cache is kept warm, and the relocation fence.
 * A JSON watchable of those counts (`workerMain`'s `busy`): the worker is idle when every count is zero.
 */
export class Liveness implements Watchable<Readonly<Record<string, number>>> {
	#relocating = false;
	#stopping = false;
	#counts: Readonly<Record<string, number>> = { activeCalls: 0, viewers: 0, durableTasks: 0, cacheWarming: 0 };
	readonly #listeners = new Set<() => void>();
	get value(): Readonly<Record<string, number>> {
		return this.#counts;
	}
	/** A watch of the counts (only `workerMain` watches): it gets the newest counts at each change. */
	async watch(): Promise<WatchHandle<Readonly<Record<string, number>>>> {
		let listener:
			| ((call: WatchCall<Readonly<Record<string, number>>>, context: Context) => Promise<void>)
			| undefined;
		const notify = (): void => {
			void listener?.(
				{ kind: "value", value: this.#counts, ops: [["r", this.#counts]], retired: false },
				BACKGROUND_CONTEXT,
			);
		};
		const closed = Promise.withResolvers<{ kind: "ended" }>();
		const counts = this;
		return {
			get value() {
				return counts.#counts;
			},
			start: (fn) => {
				listener = fn;
				this.#listeners.add(notify);
			},
			stop: async () => {
				this.#listeners.delete(notify);
				closed.resolve({ kind: "ended" });
				return { kind: "ended" };
			},
			closed: closed.promise,
		};
	}
	#set(kind: string, count: number): void {
		this.#counts = { ...this.#counts, [kind]: count };
		for (const listener of [...this.#listeners]) listener();
	}
	add(kind: "activeCalls" | "viewers" | "cacheWarming", delta: number): void {
		this.#set(kind, (this.#counts[kind] ?? 0) + delta);
	}
	setDurableTasks(count: number): void {
		if (this.#counts.durableTasks !== count) this.#set("durableTasks", count);
	}
	/**
	 * Whether the worker process is shutting down (set before its host closes). Disposal code tells a stop, after which
	 * Durable resumes interrupted work in the next worker, from a plugin removed by a reload, whose work must end now.
	 */
	get stopping(): boolean {
		return this.#stopping;
	}
	stop(): void {
		this.#stopping = true;
	}
	/** Whether admissions are fenced for a relocation (`WorkerBoundary.prepare` accepted, not yet moved or cancelled). */
	get relocating(): boolean {
		return this.#relocating;
	}
	/**
	 * Fence new admissions before checking Durable state; a failed check releases the fence. The fence counts as an
	 * active call, so the worker cannot stop idle between the server's prepare and its relocate.
	 */
	freeze(): boolean {
		if (this.#relocating || (this.#counts.activeCalls ?? 0) > 0) return false;
		this.#relocating = true;
		this.add("activeCalls", 1);
		return true;
	}
	unfreeze(): void {
		if (!this.#relocating) return;
		this.#relocating = false;
		this.add("activeCalls", -1);
	}
	/** Runs `fn` as one active call. */
	async call<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#relocating) throw new Error("Working directory is changing; wait before sending another message");
		this.add("activeCalls", 1);
		try {
			return await fn();
		} finally {
			this.add("activeCalls", -1);
		}
	}
}

/** The worker process: its start data, liveness counters, and where the session works now (read `location`). */
export type WorkerParts = {
	readonly init: WorkerInit;
	readonly liveness: Liveness;
	readonly location: SessionLocation;
	/**
	 * Runs `fn` in a root of the worker's own (`HOST`) under `context`: for code outside Chord calls (a Durable tool or
	 * section passes its Durable context), or a method acting as the worker (`withoutAbortSignal(ctx)`).
	 */
	readonly root: <T>(fn: (ctx: Ctx) => Promise<T>, context: Context) => Promise<T>;
	/**
	 * Copies this session's files (the kit's `Files`: its index and blobs) into the directory of the new session
	 * `session`, which must not exist yet: a fork, whose worker waits while it copies. The session goes on meanwhile.
	 */
	readonly copyFilesTo: (session: string, context: Context) => Promise<void>;
	/**
	 * The session's Chord store (one writer: this worker), for its backup (`plugins/backup`). Never close it. Absent in
	 * test hosts without a store.
	 */
	readonly store?: Store;
};

/**
 * The worker process's natives, contributed by the core facet from the start: `self.registry(WorkerProcess).value`
 * (`.init.dataDir`, `.liveness.call(…)`, `.location.value`). Read `location`, not `init.values.session`, for the cwd.
 */
export const WorkerProcess = defineRegistry<WorkerParts, WorkerParts | undefined>("p2.worker-process", { version: 1 });

/**
 * Refusals of a move to `to` (from the session's current location), checked under the fence before anything moves. A
 * message refuses. Conversations with their own location never refuse: they stay where they are.
 */
export type RelocationCheck = (
	harness: DurableHarness,
	from: Location,
	to: Location,
	context: Context,
) => Promise<string | undefined>;
export const RelocationChecks = keyedRegistry<RelocationCheck>("p2.relocation-checks");

/** The session's Harness and its environments, opened by the core (`HarnessHost`), read at each use. */
export type HarnessParts = {
	readonly durable: DurableHarness;
	/**
	 * Every conversation's location and environment (also supplied to Durable): the session's for the main
	 * conversation and its followers, a subagent's own (its environment and cwd, e.g. a git worktree) otherwise.
	 * Resolve at each use: a relocation changes the session's.
	 */
	readonly environments: ExecutionEnvironments;
	/**
	 * Moves the session to `location` in place (the server's `WorkerBoundary.relocate`, while admissions are fenced and
	 * nothing runs): opens the destination's environment, switches the session's location, commits the root and its
	 * followers to the new cwd, commits the `SessionLocation` (its listeners reopen what they keep), then retires the
	 * environments nothing uses any more.
	 */
	relocate(location: Location, context: Context): Promise<void>;
	/** The request that produced `response`, for `GenerationTask`'s `afterResponse` hooks; each response is taken once. */
	requestOf(response: AssistantMessage): ModelRequest | undefined;
};

/**
 * One provider request the Harness sent: the model, the messages after Durable's `beforeRequest` chain, and the
 * attempt's options without its `signal`, `telemetry` and `onPayload`. Read-only: the messages are Durable's (frozen)
 * entry messages; never mutate, copy or freeze any of it. Sending it again skips Durable's `beforeProviderRequest`
 * hooks (no p2 extension has one).
 */
export type ModelRequest = {
	readonly model: Model<Api>;
	readonly messages: readonly Message[];
	readonly options: ModelsSimpleStreamOptions;
};

/** The session's Harness (the core's contribution once it is open). */
export const HarnessNative = defineRegistry<HarnessParts, HarnessParts | undefined>("p2.harness", { version: 1 });

/**
 * The core's host-lifetime object that opens the Harness (an exclusive store: one per worker). A factory that needs the
 * Harness at activation declares it: `harnessOf(self)` parks the attempt until the Harness is open.
 */
export const HarnessHost = local("p2.harness-host", { version: 1, params: {}, members: {} });

/** The session's Harness for a factory: declares `HarnessHost` (so the attempt waits for it) and reads it at each use. */
export function harnessOf(self: Self): () => HarnessParts {
	self.get(HarnessHost, {});
	const harness = self.registry(HarnessNative);
	return () => {
		const parts = harness.value;
		if (parts === undefined) throw new Error("The session's Harness is not open");
		return parts;
	};
}

/** The worker process's natives for a factory (the core contributes them before anything activates). */
export function workerOf(self: Self): () => WorkerParts {
	const worker = self.registry(WorkerProcess);
	return () => {
		const parts = worker.value;
		if (parts === undefined) throw new Error("No worker process (the core facet contributes it)");
		return parts;
	};
}

/** Serves the base keyed registries of a worker (the core facet; test hosts without one). */
export function serveWorkerRegistries(host: FacetHost): void {
	for (const registry of [
		Extensions,
		ExtensionSwitches,
		InputGates,
		ConversationConfigured,
		ReadOnlyConversations,
		HarnessConfig,
		HarnessEnvironments,
		RelocationChecks,
		ConversationLocations,
	])
		serveKeyed(host, registry as typeof InputGates);
}

/** The worker's core facet: its registries, its natives, the Harness and the server's lifecycle calls. */
export function workerCore(
	init: WorkerInit,
	liveness: Liveness,
	location: SessionLocation,
	store: Store,
	root: WorkerParts["root"],
	/** The worker host's telemetry adapter, the Harness's too (its `pi.durable.*` and pi-ai's spans); none in tests. */
	telemetry: HarnessOptions["telemetry"],
): Facet {
	return defineFacet((host, self) => {
		serveWorkerRegistries(host);
		host.serve(WorkerProcess, { compose: (table) => table[0]?.value });
		const own = sessionDirectory(init.dataDir, init.values.session.id);
		const copyFilesTo = (session: string, context: Context) =>
			copyFiles({ store, files: hostFiles(own) }, sessionDirectory(init.dataDir, session), context);
		self.contribute(WorkerProcess, { init, liveness, location, root, copyFilesTo, store });
		host.serve(HarnessNative, { compose: (table) => table[0]?.value });
		host.serve(HarnessHost, (_params, self) => {
			self.contribute(HarnessNative, openHarness(self, init, location, store, telemetry));
			return {};
		});
		host.serve(WorkerBoundary, (_params, principal, self) => {
			if (principal.kind !== "server") throw forbidden("server lifecycle only");
			const harness = harnessOf(self);
			const checks = self.registry(RelocationChecks);
			return {
				variant: "server",
				members: {
					prepare: async (input, ctx) => {
						const frozen = liveness.freeze();
						try {
							const inspection = await harness().durable.inspect(ctx);
							const busy = [
								...new Set(
									inspection.tasks
										.filter((task) => !task.record.background)
										.map((task) => task.record.conversationId),
								),
							].sort((a, b) => a - b);
							const tasks = inspection.tasks.length + inspection.submissions.length;
							let refusal: string | undefined;
							// Under the fence: nothing can change what the checks read (no task runs, nothing is admitted).
							if (frozen && tasks === 0 && input !== null)
								for (const check of checks.value.values()) {
									refusal = await check(harness().durable, location.value, input.to, ctx);
									if (refusal !== undefined) break;
								}
							const accepted = frozen && tasks === 0 && refusal === undefined;
							if (!accepted && frozen) liveness.unfreeze();
							return { accepted, tasks, busy, ...(refusal === undefined ? {} : { refusal }) };
						} catch (error) {
							if (frozen) liveness.unfreeze();
							throw error;
						}
					},
					cancel: async () => {
						liveness.unfreeze();
						return null;
					},
					relocate: async (next, ctx) => {
						if (!liveness.relocating) throw new Error("Relocation was not prepared");
						await harness().relocate(next, ctx);
						liveness.unfreeze();
						return null;
					},
				},
			};
		});
	});
}

/**
 * This machine: `LocalExecutionEnv` where pi-env ships a daemon for it, so the file index lists through it
 * (`listFiles`), else `NodeExecutionEnv`. The daemon starts at the first listing; `close` stops it.
 */
function localMachine(): Machine {
	let daemon: string | undefined;
	try {
		daemon = localDaemon();
	} catch {
		// No daemon for this system.
	}
	if (daemon === undefined || !existsSync(daemon))
		return { at: (cwd) => new NodeExecutionEnv({ cwd, shellPath: process.env.SHELL }), close: () => {} };
	const connection = new Connection({ command: [daemon] });
	return {
		at: (cwd) => new LocalExecutionEnv({ cwd, shellPath: process.env.SHELL, connection }),
		close: () => connection.close(),
	};
}

/** The execution environments of a session's conversations, each at its conversation's location. */
export type ExecutionEnvironments = {
	/** Where the session works now: its main conversation and the conversations following it. */
	readonly session: Location;
	/**
	 * Where conversation `id` works: its own location (a subagent spawned with a cwd), else the session's. `read` reads
	 * its documents (a tool's or a prompt section's reader; default: the Harness).
	 */
	locate(id: ConversationId, context: Context, read?: DocumentReader): Promise<Location>;
	/** The environment at `location`: one per directory, on one connection per machine, opened at its first use. */
	at(location: Location): Promise<ExecutionEnv>;
	/** `env` itself when it is a sandbox (see `HarnessEnvironmentEntry.sandbox`), else undefined; this device never is. */
	sandbox(env: string | null): Promise<string | undefined>;
};

/**
 * The sandbox conversation `id` is confined to: the environment it works in, when that is a sandbox. Decided from its
 * current location at each call, so it holds per conversation (a subagent placed in a sandbox is confined, its main
 * agent elsewhere is not) and follows moves.
 */
export async function conversationConfinement(
	environments: ExecutionEnvironments,
	id: ConversationId,
	context: Context,
	read?: DocumentReader,
): Promise<{ sandbox: string } | undefined> {
	const sandbox = await environments.sandbox((await environments.locate(id, context, read)).env);
	return sandbox === undefined ? undefined : { sandbox };
}

/** Where conversation `id` works and its environment there. */
export async function conversationEnvironment(
	environments: ExecutionEnvironments,
	id: ConversationId,
	context: Context,
	read?: DocumentReader,
): Promise<{ location: Location; env: ExecutionEnv }> {
	const location = await environments.locate(id, context, read);
	return { location, env: await environments.at(location) };
}

/**
 * The session's execution environments: one machine (connection) per environment name, opened lazily and shared by
 * every conversation working there, with one environment per directory. A relocation `switch`es the session's location
 * (the conversations following it locate there from then on), then `retire`s what nothing uses any more: the old cwd's
 * environment, the old machine unless a conversation with its own location works on it. Conversations with their own
 * location keep their environments.
 */
class Execution implements ExecutionEnvironments {
	#session: Location;
	readonly #open: (env: string | null, signal: AbortSignal) => Promise<Machine>;
	readonly #sandbox: (env: string, signal: AbortSignal) => Promise<boolean>;
	readonly #own: (
		read: DocumentReader | undefined,
		id: ConversationId,
		context: Context,
	) => Promise<Location | undefined>;
	/** Machines by environment name ("" for this machine: names are never empty), with their environments by cwd. */
	readonly #machines = new Map<
		string,
		{ readonly machine: Promise<Machine>; readonly envs: Map<string, ExecutionEnv> }
	>();
	readonly #closing = new AbortController();
	constructor(
		session: Location,
		open: (env: string | null, signal: AbortSignal) => Promise<Machine>,
		sandbox: (env: string, signal: AbortSignal) => Promise<boolean>,
		own: (read: DocumentReader | undefined, id: ConversationId, context: Context) => Promise<Location | undefined>,
	) {
		this.#session = session;
		this.#open = open;
		this.#sandbox = sandbox;
		this.#own = own;
	}
	async sandbox(env: string | null): Promise<string | undefined> {
		if (env === null) return undefined;
		return (await this.#sandbox(env, this.#closing.signal)) ? env : undefined;
	}
	get session(): Location {
		return this.#session;
	}
	async locate(id: ConversationId, context: Context, read?: DocumentReader): Promise<Location> {
		if (id === ROOT_CONVERSATION_ID) return this.#session;
		return (await this.#own(read, id, context)) ?? this.#session;
	}
	async at(location: Location): Promise<ExecutionEnv> {
		if (this.#closing.signal.aborted) throw new Error("The session's environments are closed");
		const key = location.env ?? "";
		let entry = this.#machines.get(key);
		if (!entry) {
			const created = {
				machine: this.#open(location.env, this.#closing.signal),
				envs: new Map<string, ExecutionEnv>(),
			};
			entry = created;
			this.#machines.set(key, created);
			// A failed open is not kept: the next use tries again.
			created.machine.catch(() => {
				if (this.#machines.get(key) === created) this.#machines.delete(key);
			});
		}
		const machine = await entry.machine;
		// Retired while opening: open it again (or refuse, once closed).
		if (this.#machines.get(key) !== entry) return this.at(location);
		let env = entry.envs.get(location.cwd);
		if (!env) {
			env = machine.at(location.cwd);
			entry.envs.set(location.cwd, env);
		}
		return env;
	}
	/** The session moves to `next`; the old environments stay until `retire`. */
	switch(next: Location): void {
		this.#session = next;
	}
	/**
	 * Ends the environments outside `used` (their running commands killed) and closes the machines left without any.
	 * Nothing runs meanwhile: the worker is fenced.
	 */
	async retire(used: readonly Location[]): Promise<void> {
		const ending: ExecutionEnv[] = [];
		const closing: Promise<Machine>[] = [];
		for (const [key, entry] of this.#machines) {
			const kept = used.filter((location) => (location.env ?? "") === key);
			for (const [cwd, env] of entry.envs)
				if (!kept.some((location) => location.cwd === cwd)) {
					entry.envs.delete(cwd);
					ending.push(env);
				}
			if (!kept.length) {
				this.#machines.delete(key);
				closing.push(entry.machine);
			}
		}
		const context = durableContext(new AbortController().signal);
		await Promise.all(ending.map((env) => env.cleanup(context).catch(() => {})));
		for (const machine of await Promise.allSettled(closing))
			if (machine.status === "fulfilled") machine.value.close();
	}
	close(): Promise<void> {
		this.#closing.abort(new Error("The session's environments are closed"));
		return this.retire([]);
	}
}

/**
 * Moves the top-level conversations (the root and its `/tree` branches) and the conversations following the session to
 * `session.cwd` in one commit (those already there stay untouched), after the placement provider committed what an older
 * version left unplaced. Children copied the session's
 * cwd when created, so a move leaves them behind; this runs at every start (sessions moved before subagents tracked
 * their own cwd still hold the old path) and at every in-place relocation. Nothing resolves against this process's cwd.
 * Returns the own locations of the other conversations.
 */
async function followSession(
	place:
		| ((
				harness: DurableHarness,
				session: Location,
				context: Context,
		  ) => Promise<{ readonly followers: readonly ConversationId[]; readonly own: readonly Location[] }>)
		| undefined,
	harness: DurableHarness,
	session: Location,
	context: Context,
): Promise<readonly Location[]> {
	const placed = place ? await place(harness, session, context) : { followers: [], own: [] };
	const stale: ConversationId[] = [];
	for (const id of [...(await topLevelConversations(harness, context)), ...placed.followers]) {
		const current = (await (await harness.conversation(id, context))?.agent(context))?.cwd;
		if (current !== undefined && current !== session.cwd && !stale.includes(id)) stale.push(id);
	}
	if (stale.length)
		await harness.commit(async (tx) => {
			for (const id of stale) await configure(tx, id, { cwd: session.cwd });
		}, context);
	return placed.own;
}

/**
 * Opens the session's Harness in the `HarnessHost` object: the execution environments first (the session's machine
 * opens now: a start fails visibly where it cannot), then Durable once the models plugin contributed its configuration,
 * with the root conversation created from the session's model and cwd. Scheduling starts with `resume()` once the
 * worker's plugins are loaded (the worker entry). Returns the contribution: the natives, read at each use.
 */
function openHarness(
	self: Self,
	init: WorkerInit,
	location: SessionLocation,
	store: Store,
	telemetry: HarnessOptions["telemetry"],
): HarnessParts {
	const { values } = init;
	const session = values.session;
	const config = self.registry(HarnessConfig);
	const environments = self.registry(HarnessEnvironments);
	const placements = self.registry(ConversationLocations);
	const extensions = self.registry(Extensions);
	const switches = self.registry(ExtensionSwitches);
	const configured = (): HarnessConfigEntry => {
		const entry = config.value.get("default");
		if (entry === undefined) throw new Error("No model configuration installed (models plugin)");
		return entry;
	};
	// Model access is looked up at each use: the models plugin may reload or replace its configuration. Every generation
	// request passes through `streamSimple` here, after Durable and the Harness's identity wrapper completed it.
	const requests = new WeakMap<AssistantMessage, ModelRequest>();
	const models = new Proxy({} as Models, {
		get: (_target, key) => {
			const current = configured().models();
			if (key === "streamSimple") return remembering(current, requests);
			const value: unknown = Reflect.get(current, key, current);
			return typeof value === "function" ? value.bind(current) : value;
		},
	});
	const settings = new Proxy({} as HarnessSettings, {
		get: (_target, key) => {
			const entry = config.value.get("default");
			return entry === undefined ? undefined : Reflect.get(entry.settings(), key);
		},
	});
	/** A machine: this one, or a remote environment's from the plugin providing them. */
	const open = async (env: string | null, signal: AbortSignal): Promise<Machine> => {
		if (env === null) return localMachine();
		const remote = await whenPresent(environments, "remote", signal);
		return remote.open(env);
	};
	/** Whether a remote environment is a sandbox, once the plugin providing them is there. */
	const sandbox = async (env: string, signal: AbortSignal): Promise<boolean> =>
		(await whenPresent(environments, "remote", signal)).sandbox(env);
	const place = async (harness: DurableHarness, at: Location, context: Context) =>
		(await placements.value.get("subagents")?.place(harness, at, values, context)) ?? { followers: [], own: [] };
	let reader: DocumentReader | undefined;
	const execution: Native<Execution> = self.open(
		async () => {
			const created = new Execution(location.value, open, sandbox, async (read, id, context) => {
				const documents = read ?? reader;
				if (!documents) throw new Error("The session's Harness is not open");
				return placements.value.get("subagents")?.own(documents, id, context);
			});
			try {
				await created.at(location.value);
			} catch (error) {
				await created.close();
				throw error;
			}
			return created;
		},
		(created) => created.close(),
	);
	const observing = new AbortController();
	const durable: Native<DurableHarness> = self.open(
		async (ctx) => {
			// Generation needs model access: open once the models plugin has contributed it.
			await whenPresent(config, "default", ctx.abortSignal ?? new AbortController().signal);
			// Durable's records in the session's store, beside the kit's `Files`.
			const storage = await durableStorage(store, ctx);
			const harness = await DurableHarness.open(
				storage,
				{
					models,
					...(telemetry === undefined ? {} : { telemetry }),
					registry: durableRegistry(extensions, switches, durableContext(observing.signal)),
					settings,
					// The conversation's location, not its agent cwd alone: a subagent's own may be on another machine.
					env: async (target, context) =>
						execution.value.at(await execution.value.locate(target.conversationId, context, target.read)),
					onReport: (report) => console.error(`durable: ${report.kind}:`, report.error),
				},
				ctx,
			);
			reader = harness;
			const { cwd } = location.value;
			const root = await harness.root(ctx, {
				agent: { model: session.model, cwd, thinkingLevel: session.thinkingLevel },
			});
			const agent = await root.agent(ctx);
			// Before the Harness is live: nothing can run or resume in a stale cwd first.
			try {
				await followSession(place, harness, location.value, ctx);
			} catch (error) {
				await harness.close(ctx).catch(() => {});
				throw error;
			}
			// As Pi Mobile: a root model no longer in the configuration fails the start visibly (the session's worker
			// error, with Retry), not on the first turn.
			if (!agent.model || !models.getModel(agent.model.provider, agent.model.modelId)) {
				await harness.close(ctx).catch(() => {});
				throw new Error("Unknown model");
			}
			return harness;
		},
		async (harness) => {
			observing.abort();
			await harness.close(BACKGROUND_CONTEXT).catch(() => {});
		},
	);
	return {
		get durable() {
			return durable.value;
		},
		get environments() {
			return execution.value;
		},
		relocate: async (next, context) => {
			if (sameLocation(next, location.value)) return;
			const harness = durable.value;
			const environments = execution.value;
			// The destination first: a machine that cannot be opened refuses before anything moves. Then the session's
			// location, the agent cwds and the `SessionLocation` (its listeners reopen on the new environments); what
			// nothing uses any more goes last. A failure leaves the worker fenced: the server restarts it from the
			// catalog.
			await environments.at(next);
			environments.switch(next);
			const own = await followSession(place, harness, next, context);
			location.set(next);
			await environments
				.retire([next, ...own])
				.catch((error: unknown) => console.error("p2 worker: closing old environments:", error));
		},
		requestOf: (response) => {
			const request = requests.get(response);
			requests.delete(response);
			return request;
		},
	};
}

/** `models.streamSimple` that remembers each request by its terminal message, for `HarnessParts.requestOf`. */
function remembering(models: Models, requests: WeakMap<AssistantMessage, ModelRequest>): Models["streamSimple"] {
	return (model, context, options) => {
		const stream = models.streamSimple(model, context, options);
		// Registered before the caller awaits result(): the entry exists when Durable's afterResponse hooks run.
		// result() never rejects; pi-ai encodes failures as `stopReason: "error"`.
		void stream.result().then((message) => {
			const { signal: _signal, telemetry: _telemetry, onPayload: _onPayload, ...kept } = options ?? {};
			requests.set(message, { model, messages: context.messages, options: kept });
		});
		return stream;
	};
}

/** Resolves with the entry `key` of a keyed registry once it is there; rejects when `signal` aborts first. */
async function whenPresent<V>(
	registry: RegistryValue<ReadonlyMap<string, V>>,
	key: string,
	signal: AbortSignal,
): Promise<V> {
	const present = registry.value.get(key);
	if (present !== undefined) return present;
	const watch = await registry.watch(durableContext(signal));
	try {
		return await new Promise<V>((resolve, reject) => {
			const now = watch.value.get(key);
			if (now !== undefined) return resolve(now);
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			watch.start(async (call) => {
				const entry = call.kind === "value" ? call.value.get(key) : undefined;
				if (entry !== undefined) resolve(entry);
			});
		});
	} finally {
		await watch.stop();
	}
}

/**
 * Where conversation `id` works (`ExecutionEnvironments.locate`), for code running inside the Harness (a prompt section,
 * a tool) that reads the Harness registry it declared.
 */
export function locateConversation(
	harness: RegistryValue<HarnessParts | undefined>,
	id: ConversationId,
	context: Context,
	read?: DocumentReader,
): Promise<Location> {
	const parts = harness.value;
	if (parts === undefined) throw new Error("The session's Harness is not open");
	return parts.environments.locate(id, context, read);
}

/**
 * `target` as a location of an existing directory, or why it is not one: on the caller's environment its path is
 * relative to `from.cwd`, on another one relative to that environment's home (`~` expands on both). Resolved through
 * the worker's environments, so another machine is opened (and kept until nothing uses it).
 */
export async function resolveDirectory(
	environments: ExecutionEnvironments,
	target: LocationInput,
	from: Location,
	context: Context,
): Promise<Location | { error: string }> {
	const same = target.env === from.env;
	const typed = target.path.trim();
	const path = !typed ? (same ? from.cwd : "~") : same || isRooted(typed) ? typed : `~/${typed}`;
	try {
		const env = await environments.at({ env: target.env, cwd: same ? from.cwd : "/" });
		const absolute = await env.absolutePath(path, context);
		const canonical = absolute.ok ? await env.canonicalPath(absolute.value, context) : undefined;
		const info = canonical?.ok ? await env.fileInfo(canonical.value, context) : undefined;
		if (!absolute.ok || !info?.ok || info.value.kind !== "directory") return { error: "not an existing directory" };
		return { env: target.env, cwd: absolute.value };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
