import { AgentDoc, type ConversationId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
	canSend,
	defineFacet,
	followNative,
	forbidden,
	type Location,
	type Subscribable,
	sameLocation,
	signalOf,
} from "@p2/app/v1";
import { durableContext } from "@p2/app/v1/node";
import { conversationEnvironment, harnessOf, workerOf } from "@p2/app/v1/worker";
import { LocationMoveDoc } from "../locations/contract.worker.ts";
import { Workspace, WorkspaceBackend, WorkspaceTransfer, WorkspaceWrites } from "./contract.ts";
import { Workspace as EnvironmentWorkspace } from "./environment.ts";
import { workspacePath, workspaceSearchText } from "./protocol.ts";

export default defineFacet((host) => {
	host.serve(WorkspaceWrites, (_params, self) => {
		const harness = harnessOf(self);
		const writerResource = self.open(
			async () => {
				// One workspace per environment: the session's where it is, or a subagent's own location. A move brings new
				// environments (`at` resolves at each write), so new workspaces. Weak: environments a move closed go with
				// their workspaces.
				const workspaces = new WeakMap<ExecutionEnv, EnvironmentWorkspace>();
				const workspaceAt = async (location: Location) => {
					const at = await harness().environments.at(location);
					let workspace = workspaces.get(at);
					if (!workspace) {
						workspace = new EnvironmentWorkspace(at);
						workspaces.set(at, workspace);
					}
					return workspace;
				};
				return { workspaceAt, tail: Promise.resolve() };
			},
			() => {},
		);
		return {
			write: async ({ location, upload }, ctx) => {
				const writer = writerResource.value;
				const previous = writer.tail;
				let release!: () => void;
				writer.tail = new Promise<void>((resolve) => {
					release = resolve;
				});
				await previous;
				try {
					signalOf(ctx).throwIfAborted();
					await (await writer.workspaceAt(location)).write(upload, durableContext(ctx));
					return null;
				} finally {
					release();
				}
			},
		};
	});
	host.serve(WorkspaceBackend, ({ conversation }, self) => {
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const writes = self.get(WorkspaceWrites, {});
		/** The viewed conversation's workspace where it works now, and the watch reporting its changes to `listeners`. */
		const openWorkspace = async (context: ReturnType<typeof durableContext>, notify: () => void) => {
			const durable = harness().durable;
			const handle = await durable.conversation(conversation as ConversationId, context);
			if (!handle) throw new Error("Unknown conversation");
			// Where the viewed conversation works: a subagent may have its own location (e.g. a git worktree, on another
			// machine than the session now).
			const { location, env } = await conversationEnvironment(harness().environments, handle.id, context);
			const root = await env.canonicalPath(env.cwd, context);
			if (!root.ok) throw new Error("Working directory unavailable");
			const workspace = new EnvironmentWorkspace(env);
			// The workspace answers before its watch is up: walking a large tree (a home folder) takes many seconds. A
			// failed watch leaves the panel without live updates; once one is up, viewers read again (a change made before
			// it would be missed otherwise).
			const watch = workspace.watch(notify, context).then(
				(watcher) => {
					notify();
					return watcher;
				},
				(error: unknown) => {
					if (!context.abortSignal?.aborted)
						console.error("p2 workspace: watching failed:", error instanceof Error ? error.message : error);
					return undefined;
				},
			);
			return { workspace, location, watch };
		};
		type Opened = Awaited<ReturnType<typeof openWorkspace>>;
		const workspaceResource = self.open(
			async (ctx) => {
				const signal = signalOf(ctx);
				const listeners = new Set<(event: null) => void>();
				const events: Subscribable<null> = {
					subscribe: (fn) => {
						listeners.add(fn);
						return () => {
							listeners.delete(fn);
						};
					},
				};
				let pending: ReturnType<typeof setTimeout> | undefined;
				// Counts the workspace's changes (at most one per 100 ms): viewers read again at each.
				let version = 0;
				const notify = (): void => {
					if (pending) return;
					pending = setTimeout(() => {
						pending = undefined;
						version++;
						for (const fn of listeners) fn(null);
					}, 100);
				};
				const location = worker().location;
				const closing = new AbortController();
				// A superseded open is abandoned (a watch still walking its tree stops), and its watch closed.
				const release = (slot: Slot): void => {
					slot.abandon.abort();
					void slot.opened
						.then(({ watch }) => watch)
						.then((watcher) => watcher?.stop(durableContext(new AbortController().signal)))
						.catch(() => {});
				};
				// The workspace of the location's current version. A move makes it older: the next use (or the move's
				// listener) opens it again where the conversation works now and closes the superseded watch. A failed open
				// is not kept: the next use tries again. `moves` counts moves of the conversation's own location (a subagent
				// moved by its main agent or by itself), which the session's location does not see.
				let moves = 0;
				type Slot = {
					readonly version: string;
					readonly opened: Promise<Opened>;
					readonly abandon: AbortController;
				};
				let slot: Slot | undefined;
				const current = (): Promise<Opened> => {
					const version = `${location.version}:${moves}`;
					if (slot?.version === version) return slot.opened;
					const previous = slot;
					const abandon = new AbortController();
					const opened = openWorkspace(durableContext(AbortSignal.any([closing.signal, abandon.signal])), notify);
					const mine = { version, opened, abandon };
					slot = mine;
					opened.catch(() => {
						if (slot === mine) slot = undefined;
					});
					if (previous) release(previous);
					return opened;
				};
				// Subscribed before the first open: a move while it activates is not missed. After a move, viewers are told
				// to read again (the conversation's directory or machine changed).
				const stopSession = location.subscribe(() => void current().then(notify, notify));
				// The conversation's agent changed (an own location's move configures its cwd): open again if it moved.
				const reopenIfMoved = async (): Promise<void> => {
					const opened = await slot?.opened.catch(() => undefined);
					const now = await harness().environments.locate(
						conversation as ConversationId,
						durableContext(closing.signal),
					);
					if (!opened || sameLocation(opened.location, now)) return;
					moves++;
					await current().then(notify, notify);
				};
				const agentCommits = harness().durable.observeCommits({
					advance: (publication) => {
						// The session's move waits, or failed: viewers show it with the workspace's place.
						if (
							publication.changes.some(
								(change) =>
									change.type === "document" &&
									change.record.kind === LocationMoveDoc.definition.kind &&
									change.record.scope.kind === "conversation" &&
									change.record.scope.conversationId === ROOT_CONVERSATION_ID,
							)
						)
							notify();
						if (
							publication.changes.some(
								(change) =>
									change.type === "document" &&
									change.record.kind === AgentDoc.definition.kind &&
									change.record.scope.kind === "conversation" &&
									change.record.scope.conversationId === conversation,
							)
						)
							void reopenIfMoved().catch(() => {});
					},
					// The Session closed or failed: the worker's Harness, and this resource with it, ends.
					end: () => {},
				});
				const stop = (): void => {
					stopSession();
					agentCommits.detach();
				};
				// An abandoned activation aborts its open.
				const abandon = (): void => closing.abort();
				signal.addEventListener("abort", abandon, { once: true });
				try {
					await current();
				} catch (error) {
					stop();
					throw error;
				} finally {
					signal.removeEventListener("abort", abandon);
				}
				return {
					events,
					current,
					get version() {
						return version;
					},
					close: async () => {
						stop();
						closing.abort();
						clearTimeout(pending);
						if (slot) release(slot);
					},
				};
			},
			(value) => value.close(),
		);
		return {
			changes: followNative(
				self,
				(changed) => workspaceResource.value.events.subscribe(changed),
				() => workspaceResource.value.version,
			),
			query: (query, ctx) =>
				worker().liveness.call(async () => {
					if ("path" in query && workspacePath(query.path) === undefined)
						throw new Error("Invalid workspace path");
					if (query.kind === "search" && !workspaceSearchText(query.text)) throw new Error("Invalid search text");
					const { workspace, location } = await workspaceResource.value.current();
					if (query.kind === "place") {
						const move = await harness().durable.snapshot(
							LocationMoveDoc,
							ROOT_CONVERSATION_ID,
							durableContext(ctx),
						);
						return {
							kind: "place",
							location,
							...(move?.pending ? { pending: move.pending } : {}),
							...(move?.failed ? { failed: move.failed } : {}),
						};
					}
					return workspace.query(query, durableContext(ctx));
				}),
			read: ({ path, ...range }, ctx) =>
				worker().liveness.call(async () =>
					(await workspaceResource.value.current()).workspace.read(path, range, durableContext(ctx)),
				),
			write: async (upload, ctx) => {
				await worker().liveness.call(async () =>
					writes.write({ location: (await workspaceResource.value.current()).location, upload }, ctx),
				);
				return null;
			},
		};
	});
	host.serve(Workspace, ({ session, conversation }, principal, self) => {
		if (!canSend(principal, session)) throw forbidden("participants only");
		const backend = self.get(WorkspaceBackend, { conversation });
		return {
			variant: "reader",
			members: { changes: backend.changes, query: (query, ctx) => backend.query(query, ctx) },
		};
	});
	host.serve(WorkspaceTransfer, ({ conversation }, principal, self) => {
		if (principal.kind !== "server") throw forbidden("server only");
		const backend = self.get(WorkspaceBackend, { conversation });
		return {
			variant: "server",
			members: {
				read: (query, ctx) => backend.read(query, ctx),
				write: (upload, ctx) => backend.write(upload, ctx),
			},
		};
	});
});
