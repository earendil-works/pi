import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import {
	type AcceptsTable,
	type Ctx,
	contribute,
	defineFacet,
	deriveTyped,
	forbidden,
	isGuest,
	isOwner,
	isWorker,
	type Location,
	nativeOf,
	type Ref,
	type SessionInit,
	serveKeyed,
	WorkerBoundary,
} from "@p2/app/v1";
import { Server, serverOf, WorkerInitValues } from "@p2/app/v1/server";
import { EnvManagers, EnvService } from "../envs/contract.ts";
import { ModelConfig, ModelResources } from "../models/contract.ts";
import { ChildStore } from "../subagents/contract.ts";
import { CatalogDb } from "./catalog.ts";
import {
	ArchivedStarts,
	Catalog,
	isThinkingLevel,
	MAX_TITLE,
	type Session,
	SessionArchived,
	SessionMoves,
	Sessions,
	SessionTransfer,
} from "./contract.ts";
import { copySessionDirectories, copySessionStore, removeSessionCopy } from "./copy.ts";

/** A row as `Sessions` v4 and `Catalog` v3 consumers read it: a null branch label is the session title. */
function sessionV4(row: Session) {
	return {
		...row,
		branches: row.branches.map(({ conversation, label }) => ({ conversation, label: label ?? row.title })),
	};
}

/** A row as `Sessions` v3 and `Catalog` v2 consumers read it: before `/tree`, without `main` and `branches`. */
function sessionV3({ main: _main, branches: _branches, ...row }: Session) {
	return row;
}

/** Catalog consumers built before its current version (a server plugin not reloaded yet) read rows mapped back. */
const CATALOG_ACCEPTS: AcceptsTable<typeof Catalog> = {
	2: {
		state: { sessions: (rows) => rows.map(sessionV3) },
		methods: {
			get: { result: sessionV3 },
			create: { result: sessionV3 },
			// Older arguments are a subset of the current ones.
			update: { args: (old) => old, result: sessionV3 },
		},
	},
	3: {
		state: { sessions: (rows) => rows.map(sessionV4) },
		methods: {
			get: { result: sessionV4 },
			create: { result: sessionV4 },
			update: { args: (old) => old, result: sessionV4 },
		},
	},
};

/**
 * Older `Sessions` consumers (a page or TUI loaded before a deploy, a worker not restarted yet) read rows mapped
 * back; v4's `treeSelf` labels are text, which the current version takes as it is.
 */
const SESSIONS_ACCEPTS: AcceptsTable<typeof Sessions> = {
	3: {
		state: {
			owner: { sessions: (rows) => rows.map(sessionV3) },
			guest: { sessions: (rows) => rows.map(sessionV3) },
			worker: { session: (row) => (row === null ? null : sessionV3(row)) },
		},
		methods: { create: { result: sessionV3 }, clone: { result: sessionV3 }, fork: { result: sessionV3 } },
	},
	4: {
		state: {
			owner: { sessions: (rows) => rows.map(sessionV4) },
			guest: { sessions: (rows) => rows.map(sessionV4) },
			worker: { session: (row) => (row === null ? null : sessionV4(row)) },
		},
		methods: {
			create: { result: sessionV4 },
			clone: { result: sessionV4 },
			fork: { result: sessionV4 },
			treeSelf: { args: (old) => old },
		},
	},
};

/** Contributes each worker's session parameters; refuses archived and unknown sessions. */

const cleanTitle = (title: string): string => title.replace(/\s+/g, " ").trim();

/**
 * Fences the session's running worker for `doing` ("changing directory"): undefined once fenced, else why it refused
 * (it has work, or `to` is a move its `RelocationChecks` refuse; nothing fenced). Runs in `root`, a root of the
 * server's own (see `lifecycle`).
 */
async function fenceWorker(
	catalog: Ref<typeof Catalog>,
	children: Ref<typeof ChildStore>,
	id: string,
	doing: string,
	root: Ctx,
	to?: Location,
): Promise<string | undefined> {
	const boundary = await root.get(WorkerBoundary, { session: id });
	const result = await boundary.prepare(to ? { to } : null, root);
	if (result.accepted) return undefined;
	if (result.refusal !== undefined) return result.refusal;
	const row = await catalog.get({ id }, root);
	// A `/tree` branch left while running goes on in the background (docs/tree.md); conversation 1 is top-level before
	// the worker first reports `branches`.
	const branchOf = (conversation: number) => row.branches.find((branch) => branch.conversation === conversation);
	const topLevel = (conversation: number) => conversation === 1 || branchOf(conversation) !== undefined;
	const branches = result.busy
		.filter((conversation) => topLevel(conversation) && conversation !== row.main)
		.map((conversation) => `"${branchOf(conversation)?.label ?? row.title}"`);
	const agents = result.busy
		.filter((conversation) => !topLevel(conversation))
		.map(
			(conversation) =>
				children.children.value[id]?.find((child) => child.conversationId === conversation)?.name ??
				`#${conversation}`,
		);
	return result.busy.includes(row.main)
		? `Stop the current run before ${doing}`
		: branches.length
			? `Branch ${branches.join(", ")} is still running: switch to it and stop it before ${doing}`
			: agents.length
				? `Subagent ${agents.join(", ")} is still running: stop it before ${doing}`
				: `Background work is still running (for example a message waiting for a subagent's answer): wait for it or stop the subagent before ${doing}`;
}

export default defineFacet((host) => {
	serveKeyed(host, SessionArchived);
	host.serve(
		Catalog,
		(_params, self) => {
			const server = self.get(Server, {});
			const archived = self.registry(SessionArchived);
			// The catalog's sessions, read from the database when it opens and after every change.
			const sessions = self.writable<Session[]>([]);
			const db = self.open(
				async () => {
					const opened = new CatalogDb(server.info.value.dataDir);
					sessions.set(opened.all());
					return opened;
				},
				(opened) => opened.close(),
			);
			return {
				sessions: deriveTyped(self, [sessions], ([value]) => value),
				get: async ({ id }) => db.value.get(id),
				create: async (input) => {
					const session = db.value.create(input);
					sessions.set(db.value.all());
					return session;
				},
				activity: async ({ id, timestamp, firstUserText }) => {
					db.value.activity(id, timestamp, firstUserText);
					sessions.set(db.value.all());
					return null;
				},
				update: async ({ id, ...change }, ctx) => {
					const session = db.value.update(id, change);
					sessions.set(db.value.all());
					if (change.archived === true) for (const close of archived.value.values()) await close(id, ctx);
					return session;
				},
			};
		},
		{ accepts: CATALOG_ACCEPTS },
	);

	host.serve(ArchivedStarts, (_params, self) => {
		const allowed = self.writable<string[]>([]);
		return {
			allowed: self.derive([allowed], ([value]) => value),
			allow: async ({ session }) => {
				if (!allowed.value.includes(session)) allowed.set([...allowed.value, session]);
				return null;
			},
			end: async ({ session }) => {
				allowed.set(allowed.value.filter((id) => id !== session));
				return null;
			},
		};
	});

	contribute(host, "p2.sessions-init", (self) => {
		const catalog = self.get(Catalog, {});
		const envs = self.get(EnvService, {});
		const archivedStarts = self.get(ArchivedStarts, {});
		self.contribute(WorkerInitValues, {
			session: async (id, ctx): Promise<SessionInit> => {
				const session = await catalog.get({ id }, ctx);
				// An archived session starts only to rebuild its index, and then without resuming its work.
				const indexing = session.archivedAt !== null && archivedStarts.allowed.value.includes(id);
				if (session.archivedAt !== null && !indexing) throw forbidden("Session is archived");
				if (session.env !== null && session.env !== undefined && !Object.hasOwn(envs.configs.value, session.env))
					throw new Error(`Environment "${session.env}" is not configured; refusing local execution`);
				return {
					id: session.id,
					cwd: session.cwd,
					env: session.env ?? null,
					model: session.model,
					thinkingLevel: session.thinkingLevel as SessionInit["thinkingLevel"],
					...(indexing ? { resume: false } : {}),
				};
			},
		});
	});

	host.serve(SessionMoves, (_params, self) => {
		const catalog = self.get(Catalog, {});
		const server = serverOf(self);
		self.get(EnvService, {});
		const envs = nativeOf(self, EnvManagers, "The SSH manager");
		const children = self.get(ChildStore, {});
		return {
			relocate: async ({ id, cwd, env }, ctx) => {
				const session = await catalog.get({ id }, ctx);
				if (session.archivedAt !== null) throw new Error("Session is archived");
				// The main conversation and the conversations following it move; subagents with their own location stay
				// where they are (on another machine too). A destination that is not configured refuses here.
				if (env) cwd = await envs().manager.workingDirectory(env, cwd, false);
				else {
					cwd = resolve(cwd === "~" ? homedir() : cwd.startsWith("~/") ? resolve(homedir(), cwd.slice(2)) : cwd);
					if (!(await stat(cwd)).isDirectory()) throw new Error("Working directory is not a directory");
				}
				const location = { cwd, env: env ?? null };
				let refused: string | null = null;
				try {
					// In a root of the server's own: a caller giving up must not cut a fenced worker off between its steps.
					await server().root((root) => {
						// Only a running worker is asked (a hold would start a stopped one); it follows the move in place.
						const boundary = () => root.get(WorkerBoundary, { session: id });
						return server().workers.relocate(id, {
							prepare: async () => {
								const refusal = await fenceWorker(catalog, children, id, "changing directory", root, location);
								refused = refusal ?? null;
								return refusal;
							},
							update: async () => {
								await catalog.update({ id, ...location }, root);
							},
							move: async () => {
								await (await boundary()).relocate(location, root);
							},
							cancel: async () => {
								await (await boundary()).cancel(root);
							},
						});
					});
				} catch (error) {
					// A busy worker (or one starting or stopping): nothing moved.
					if (refused !== null) return { refused };
					if (error instanceof Error && error.message.startsWith("Background work is still running"))
						return { refused: error.message };
					throw error;
				}
				return { refused: null };
			},
		};
	});

	host.serve(
		Sessions,
		(_params, principal, self) => {
			const catalog = self.get(Catalog, {});
			if (isWorker(principal)) {
				const id = principal.session;
				const sessionView = deriveTyped(
					self,
					[catalog.sessions],
					([sessions]) => sessions.find((s) => s.id === id) ?? null,
				);
				return {
					variant: "worker",
					members: {
						session: sessionView,
						renameSelf: async ({ title }, ctx) => {
							const previous = (await catalog.get({ id }, ctx)).title;
							await catalog.update({ id, title: cleanTitle(title) }, ctx);
							return { previous };
						},
						// Either field alone updates the entry; the other keeps its value (Pi Mobile's configure).
						configureSelf: async ({ model, thinkingLevel }, ctx) => {
							await catalog.update(
								{ id, ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) },
								ctx,
							);
							return null;
						},
						treeSelf: async ({ main, branches }, ctx) => {
							const current = await catalog.get({ id }, ctx);
							if (current.main !== main || JSON.stringify(current.branches) !== JSON.stringify(branches))
								await catalog.update({ id, main, branches }, ctx);
							return null;
						},
					},
				};
			}
			if (isGuest(principal)) {
				const shared = principal.sessions;
				const sessionsView = deriveTyped(self, [catalog.sessions], ([sessions]) =>
					sessions.filter((s) => Object.hasOwn(shared, s.id) && s.archivedAt === null),
				);
				return { variant: "guest", members: { sessions: sessionsView } };
			}
			if (!isOwner(principal)) throw forbidden("sessions are owner-only");
			const lifecycleOf = serverOf(self);
			const models = self.get(ModelConfig, {});
			const resources = nativeOf(self, ModelResources, "The model configuration");
			self.get(EnvService, {});
			const envs = nativeOf(self, EnvManagers, "The SSH manager");
			const children = self.get(ChildStore, {});
			const server = self.get(Server, {});
			const moves = self.get(SessionMoves, {});
			const fence = (id: string, doing: string, root: Ctx, to?: Location) =>
				fenceWorker(catalog, children, id, doing, root, to);
			/**
			 * Runs a lifecycle operation's steps in a root of the server's own, not the caller's: a caller giving up (an
			 * aborted call, a closed tab) must not cut a fenced worker off between its steps.
			 */
			const lifecycle = <T>(fn: (root: Ctx) => Promise<T>): Promise<T> => lifecycleOf().root(fn);
			/** A copy's catalog entry: the source's place, model and level under a marked title. */
			const copyOf = (source: Session, id: string, mark: string, ctx: Ctx) =>
				catalog.create(
					{
						id,
						cwd: source.cwd,
						env: source.env ?? null,
						title: cleanTitle(`${source.title} (${mark})`).slice(0, MAX_TITLE),
						titleEdited: true,
						model: source.model,
						thinkingLevel: source.thinkingLevel,
					},
					ctx,
				);
			const defaultCwd = deriveTyped(
				self,
				[catalog.sessions],
				([sessions]) => sessions.find((session) => session.archivedAt === null)?.cwd ?? homedir(),
			);
			const defaultEnv = deriveTyped(
				self,
				[catalog.sessions],
				([sessions]) => sessions.find((session) => session.archivedAt === null)?.env ?? null,
			);
			const defaultModel = deriveTyped(self, [models.summary], ([summary]) => summary.defaultModel);
			return {
				variant: "owner",
				members: {
					sessions: catalog.sessions,
					defaultCwd,
					defaultEnv,
					create: async ({ env, cwd, createDirectory, title, model, thinkingLevel }, ctx) => {
						if (env) cwd = await envs().manager.workingDirectory(env, cwd, createDirectory);
						else {
							cwd = cwd === "~" ? homedir() : cwd.startsWith("~/") ? resolve(homedir(), cwd.slice(2)) : cwd;
							if (!isAbsolute(cwd)) throw new Error("The working directory must be an absolute path");
							if (createDirectory) await mkdir(cwd, { recursive: true });
							if (!(await stat(cwd)).isDirectory()) throw new Error("Working directory is not a directory");
						}
						const fallback = defaultModel.value;
						const chosen = model ?? fallback;
						if (!chosen) throw new Error("Select a model or configure P2_PROVIDER and P2_MODEL");
						// As Pi Mobile and setDefault: a model the configuration does not know never reaches a worker.
						if (!resources().resources.models.getModel(chosen.provider, chosen.modelId))
							throw new Error("Unknown model");
						const level = thinkingLevel ?? fallback?.thinkingLevel;
						return catalog.create(
							{
								cwd,
								env: env ?? null,
								title: cleanTitle(title ?? "").slice(0, 100) || "New session",
								titleEdited: Boolean(cleanTitle(title ?? "")),
								model: { provider: chosen.provider, modelId: chosen.modelId },
								thinkingLevel: isThinkingLevel(level) ? level : "high",
							},
							ctx,
						);
					},
					relocate: async (target, ctx) => {
						const { refused } = await moves.relocate(target, ctx);
						if (refused !== null) throw new Error(refused);
						return null;
					},
					clone: async ({ id }, ctx) => {
						if ((await catalog.get({ id }, ctx)).archivedAt !== null) throw new Error("Session is archived");
						const dataDir = server.info.value.dataDir;
						const copy = randomUUID();
						try {
							// The store is copied while the worker is stopped: SQLite's file and WAL belong together then.
							await lifecycle((root) =>
								lifecycleOf().workers.pause(
									id,
									() => fence(id, "cloning", root),
									async () => {
										await copySessionStore(dataDir, id, copy);
										await copySessionDirectories(dataDir, id, copy);
									},
									"cloning",
								),
							);
							// Read after the copy: a move or rename while waiting for the pause belongs to the copy too.
							return await copyOf(await catalog.get({ id }, ctx), copy, "copy", ctx);
						} catch (error) {
							await removeSessionCopy(dataDir, copy);
							throw error;
						}
					},
					fork: async ({ id, conversation, before }, ctx) => {
						const source = await catalog.get({ id }, ctx);
						if (source.archivedAt !== null) throw new Error("Session is archived");
						// SessionTransfer is the server's: reached in a root of its own (a method's `ctx.get` acts as the caller).
						const { entries } = await lifecycle(async (root) =>
							(await root.get(SessionTransfer, { session: id })).history({ conversation, before }, root),
						);
						const dataDir = server.info.value.dataDir;
						const copy = randomUUID();
						let created: Session | undefined;
						try {
							await copySessionDirectories(dataDir, id, copy);
							created = await copyOf(source, copy, "fork", ctx);
							// Before anyone knows the new ID, its worker writes the history into its main conversation.
							await lifecycle(async (root) =>
								(await root.get(SessionTransfer, { session: copy })).seed({ entries }, root),
							);
							return created;
						} catch (error) {
							if (created) {
								await catalog.update({ id: copy, archived: true }, ctx).catch(() => {});
								await lifecycleOf()
									.workers.suspend(copy)
									.catch(() => {});
							} else await removeSessionCopy(dataDir, copy);
							throw error;
						}
					},
					rename: async ({ id, title }, ctx) => {
						const clean = cleanTitle(title);
						if (!clean || clean.length > MAX_TITLE)
							throw new Error(`The title must be 1–${MAX_TITLE} characters`);
						await catalog.update({ id, title: clean }, ctx);
						return null;
					},
					pin: async ({ id, pinned }, ctx) => {
						await catalog.update({ id, pinned }, ctx);
						return null;
					},
					archive: async ({ id }) => {
						await lifecycle(async (root) => {
							await catalog.update({ id, archived: true }, root);
							// Archive stops the worker whatever it is doing; its storage and history stay. Its holders (a page's
							// lingering conversation) wait for a restore rather than start a worker the archive refuses.
							await lifecycleOf().workers.suspend(id);
						});
						return null;
					},
					restore: async ({ id }, ctx) => {
						await catalog.update({ id, archived: false }, ctx);
						// A start refused while archived left the worker failed: the next hold starts it again.
						await lifecycleOf().workers.retry(id);
						return null;
					},
				},
			};
		},
		{ accepts: SESSIONS_ACCEPTS },
	);
});
