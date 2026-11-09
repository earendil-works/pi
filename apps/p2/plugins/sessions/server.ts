// The session catalog and its views (server): the sidebar's rows, creating and renaming sessions, and the lifecycle
// operations (relocate, clone, fork, archive), each a method that answers once its visible effect committed and a job
// for its long part, shown in `Sessions.operations` while it runs and when it failed. Creating is `SessionOperations`'
// too, so the owner's `Sessions.create` and the conversations tool share it.
import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { arr, bool, nul, obj, str, union, unknown } from "@earendil-works/pi-schema";
import {
	type AcceptsTable,
	type Context,
	type Ctx,
	defineFacet,
	defineJob,
	defineState,
	deriveTyped,
	forbidden,
	isGuest,
	isOwner,
	isWorker,
	type JobError,
	type Location,
	literal,
	nativeOf,
	type Ref,
	type SessionInit,
	serveKeyed,
	type Tx,
	until,
	WorkerBoundary,
	withAbortSignal,
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
	type Operation,
	OperationSchema,
	type Session,
	SessionArchived,
	SessionCopied,
	SessionMoves,
	SessionOperations,
	Sessions,
	SessionTransfer,
} from "./contract.ts";
import { copySessionDirectory, removeSessionCopy } from "./copy.ts";
import { serveLocks } from "./locks.ts";

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

/** Older arguments of `create`, `clone` and `fork` are a subset of the current ones (no chosen IDs). */
const SAME_ARGS = { args: <T>(old: T) => old };

/**
 * Older `Sessions` consumers (a page or TUI loaded before a deploy, a worker not restarted yet) read rows mapped
 * back; v4's `treeSelf` labels are text, which the current version takes as it is. None of them sees `operations`.
 */
const SESSIONS_ACCEPTS: AcceptsTable<typeof Sessions> = {
	3: {
		state: {
			owner: { sessions: (rows) => rows.map(sessionV3) },
			guest: { sessions: (rows) => rows.map(sessionV3) },
			worker: { session: (row) => (row === null ? null : sessionV3(row)) },
		},
		methods: {
			create: { ...SAME_ARGS, result: sessionV3 },
			clone: { ...SAME_ARGS, result: sessionV3 },
			fork: { ...SAME_ARGS, result: sessionV3 },
		},
	},
	4: {
		state: {
			owner: { sessions: (rows) => rows.map(sessionV4) },
			guest: { sessions: (rows) => rows.map(sessionV4) },
			worker: { session: (row) => (row === null ? null : sessionV4(row)) },
		},
		methods: {
			create: { ...SAME_ARGS, result: sessionV4 },
			clone: { ...SAME_ARGS, result: sessionV4 },
			fork: { ...SAME_ARGS, result: sessionV4 },
			treeSelf: SAME_ARGS,
		},
	},
	5: { methods: { create: SAME_ARGS, clone: SAME_ARGS, fork: SAME_ARGS } },
};

const cleanTitle = (title: string): string => title.replace(/\s+/g, " ").trim();

/** `~` and `~/…` on this machine. */
const expandHome = (cwd: string): string =>
	cwd === "~" ? homedir() : cwd.startsWith("~/") ? resolve(homedir(), cwd.slice(2)) : cwd;

/**
 * Fences the session's running worker for `doing` ("changing directory"): undefined once fenced, else why it refused
 * (it has work, or `to` is a move its `RelocationChecks` refuse; nothing fenced). `ctx` acts as the server (a local
 * object's job or method): the worker's `WorkerBoundary` answers only the server.
 */
async function fenceWorker(
	catalog: Ref<typeof Catalog>,
	children: Ref<typeof ChildStore>,
	id: string,
	doing: string,
	ctx: Ctx,
	to?: Location,
): Promise<string | undefined> {
	const boundary = await ctx.get(WorkerBoundary, { session: id });
	const result = await boundary.prepare(to ? { to } : null, ctx);
	if (result.accepted) return undefined;
	if (result.refusal !== undefined) return result.refusal;
	const row = await catalog.get({ id }, ctx);
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

/** Lifecycle jobs persist and run again after a crash: each run is idempotent (a copy starts over, a move repeats). */
const RERUN = { resume: "rerun" } as const;

const RelocateJob = defineJob("p2.sessions.relocate", {
	version: 1,
	args: obj({
		id: str(),
		cwd: str(),
		env: union([str(), nul()]),
		/** The owner's move (a refusal is a failed operation) or the agent's (`SessionMoves`: its tool reports it). */
		by: union([literal("owner"), literal("agent")]),
	}),
	result: obj({ refused: union([str(), nul()]) }),
	persist: RERUN,
});

const CloneJob = defineJob("p2.sessions.clone", {
	version: 1,
	args: obj({ id: str(), copy: str() }),
	/** Why a busy worker refused the copy (rolled back: a failed operation), else null. */
	result: obj({ refused: union([str(), nul()]) }),
	persist: RERUN,
});

/** A fork's progress: copying its files (its worker waits), then seeding its history (through its worker). */
const ForkProgress = defineState("p2.sessions.fork.progress", {
	schema: obj({ copying: bool() }),
	version: 1,
	initial: () => ({ copying: true }),
	persist: true,
	checkpointWhen: () => true,
});

const ForkJob = defineJob("p2.sessions.fork", {
	version: 1,
	/** `entries`: the history the fork holds, read from the source when the fork was asked for. */
	args: obj({ id: str(), copy: str(), entries: arr(unknown()) }),
	result: nul(),
	state: ForkProgress,
	persist: RERUN,
});

const ArchiveJob = defineJob("p2.sessions.archive", {
	version: 1,
	args: obj({ id: str() }),
	result: nul(),
	persist: RERUN,
});

/** Failed operations, until dismissed (the latest `MAX_FAILED`). */
const Failed = defineState("p2.sessions.failed", {
	schema: obj({ list: arr(OperationSchema) }),
	version: 1,
	initial: () => ({ list: [] }),
});
const MAX_FAILED = 20;

/** Why a job failed, in words. */
function failureText(error: JobError): string {
	if (error.kind === "threw") return error.error.message;
	if (error.kind === "aborted") return "The operation was interrupted";
	return `The operation was stopped after ${error.restarts} restarts`;
}

/** How long a worker start waits for its session's row (a client-chosen ID held before `create` answered). */
const ROW_WAIT_MS = 10_000;

export default defineFacet((host) => {
	serveLocks(host);
	serveKeyed(host, SessionArchived);
	serveKeyed(host, SessionCopied);
	host.serve(
		Catalog,
		(_params, self) => {
			const server = self.get(Server, {});
			// The catalog's sessions: its database is this object's native, and every write sets the rows in the same
			// method, before it answers.
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
				update: async ({ id, ...change }) => {
					const session = db.value.update(id, change);
					sessions.set(db.value.all());
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

	host.serve(SessionOperations, (_params, self) => {
		const catalog = self.get(Catalog, {});
		const server = self.get(Server, {});
		const natives = serverOf(self);
		const envService = self.get(EnvService, {});
		const envs = nativeOf(self, EnvManagers, "The SSH manager");
		const models = self.get(ModelConfig, {});
		const resources = nativeOf(self, ModelResources, "The model configuration");
		const children = self.get(ChildStore, {});
		const archivedStarts = self.get(ArchivedStarts, {});
		const archived = self.registry(SessionArchived);
		const copied = self.registry(SessionCopied);
		const failed = self.state(Failed);
		/** Copies whose row is being made: their worker waits like one whose files are being copied. */
		const preparing = self.writable<readonly string[]>([]);

		/** A finished run that failed (a refused owner's move too) stays in `operations` until dismissed. */
		const recordFailure = async (tx: Tx, operation: Omit<Extract<Operation, { phase: "failed" }>, "phase">) => {
			const list = (await tx.draft(failed)).list;
			list.push({ phase: "failed", ...operation });
			if (list.length > MAX_FAILED) list.splice(0, list.length - MAX_FAILED);
		};

		/** A failed copy: its row archived first (so its worker cannot start), its worker stopped, its files gone. */
		const failCopy = async (copy: string, ctx: Ctx) => {
			if (catalog.sessions.value.some((session) => session.id === copy))
				await catalog.update({ id: copy, archived: true }, ctx);
			await natives().workers.suspend(copy);
			await removeSessionCopy(server.info.value.dataDir, copy);
		};

		/**
		 * Moves session `id` to `location`: a stopped worker only gets the catalog update; a running one is fenced, the
		 * catalog moves and the worker follows in place (restarted from the catalog when it cannot). Returns why a busy
		 * worker refused (nothing moved), else null.
		 */
		const relocate = async (id: string, location: Location, ctx: Ctx): Promise<string | null> => {
			let refused: string | null = null;
			const boundary = () => ctx.get(WorkerBoundary, { session: id });
			try {
				await natives().workers.relocate(id, {
					prepare: async () => {
						const refusal = await fenceWorker(catalog, children, id, "changing directory", ctx, location);
						refused = refusal ?? null;
						return refusal;
					},
					update: async () => {
						await catalog.update({ id, ...location }, ctx);
					},
					move: async () => {
						await (await boundary()).relocate(location, ctx);
					},
					cancel: async () => {
						await (await boundary()).cancel(ctx);
					},
				});
			} catch (error) {
				// A busy worker (or one starting or stopping): nothing moved.
				if (refused !== null) return refused;
				if (error instanceof Error && error.message.startsWith("Background work is still running"))
					return error.message;
				throw error;
			}
			return null;
		};

		const relocations = self.job(RelocateJob, {
			run: async ({ id, cwd, env }, ctx) => ({ refused: await relocate(id, { cwd, env }, ctx) }),
			finish: async (outcome, tx) => {
				const error =
					outcome.kind === "failed"
						? failureText(outcome.error)
						: outcome.args.by === "owner"
							? outcome.result.refused
							: null;
				if (error !== null)
					await recordFailure(tx, {
						id: outcome.id,
						kind: "relocate",
						session: outcome.args.id,
						target: null,
						error,
					});
			},
		});

		const clones = self.job(CloneJob, {
			run: async ({ id, copy }, ctx) => {
				const dataDir = server.info.value.dataDir;
				let refused: string | null = null;
				try {
					// The store is copied while the worker is stopped: SQLite's file and WAL belong together then.
					await natives().workers.pause(
						id,
						async () => {
							const refusal = await fenceWorker(catalog, children, id, "cloning", ctx);
							refused = refusal ?? null;
							return refusal;
						},
						async () => {
							await removeSessionCopy(dataDir, copy);
							await copySessionDirectory(dataDir, id, copy);
						},
						"cloning",
					);
					// A move while the clone waited for the pause belongs to the copy too.
					const [source, row] = await Promise.all([catalog.get({ id }, ctx), catalog.get({ id: copy }, ctx)]);
					if (source.cwd !== row.cwd || (source.env ?? null) !== (row.env ?? null))
						await catalog.update({ id: copy, cwd: source.cwd, env: source.env ?? null }, ctx);
					return { refused: null };
				} catch (error) {
					await failCopy(copy, ctx);
					// A busy worker (or one starting or stopping) is an answer, not a failure of the job.
					if (refused !== null) return { refused };
					if (error instanceof Error && error.message.startsWith("Background work is still running"))
						return { refused: error.message };
					throw error;
				}
			},
			finish: async (outcome, tx) => {
				const error = outcome.kind === "failed" ? failureText(outcome.error) : outcome.result.refused;
				if (error !== null)
					await recordFailure(tx, {
						id: outcome.id,
						kind: "clone",
						session: outcome.args.id,
						target: outcome.args.copy,
						error,
					});
			},
		});

		const forks = self.job(ForkJob, {
			run: async ({ id, copy, entries }, ctx) => {
				const dataDir = server.info.value.dataDir;
				try {
					if (ctx.state.value.copying) {
						await removeSessionCopy(dataDir, copy);
						// The source's files, copied by its worker (its store is open there; it goes on meanwhile).
						await (await ctx.get(SessionTransfer, { session: id })).copyFiles({ to: copy }, ctx);
						await ctx.state.change((progress) => {
							progress.copying = false;
						}, ctx);
					}
					// The copy's worker starts now (this hold, or a page that navigated to it) and writes the history.
					await (await ctx.get(SessionTransfer, { session: copy })).seed({ entries }, ctx);
				} catch (error) {
					await failCopy(copy, ctx);
					throw error;
				}
				return null;
			},
			finish: async (outcome, tx) => {
				if (outcome.kind === "failed")
					await recordFailure(tx, {
						id: outcome.id,
						kind: "fork",
						session: outcome.args.id,
						target: outcome.args.copy,
						error: failureText(outcome.error),
					});
			},
		});

		const archives = self.job(ArchiveJob, {
			run: async ({ id }, ctx) => {
				// Archive stops the worker whatever it is doing; its storage and history stay. Its holders (a page's
				// lingering conversation) wait for a restore rather than start a worker the archive refuses.
				for (const close of archived.value.values()) await close(id, ctx);
				await natives().workers.suspend(id);
				return null;
			},
			finish: async (outcome, tx) => {
				if (outcome.kind === "failed")
					await recordFailure(tx, {
						id: outcome.id,
						kind: "archive",
						session: outcome.args.id,
						target: null,
						error: failureText(outcome.error),
					});
			},
		});

		const operations = deriveTyped(
			self,
			[relocations.running, clones.running, forks.running, archives.running, failed],
			([moving, cloning, forking, archiving, { list }]): Operation[] => [
				...moving.flatMap((run) =>
					run.phase === "blocked" || run.args.by === "agent"
						? []
						: [running(run.id, "relocate", run.args.id, null, false)],
				),
				...cloning.flatMap((run) =>
					run.phase === "blocked" ? [] : [running(run.id, "clone", run.args.id, run.args.copy, true)],
				),
				...forking.flatMap((run) =>
					run.phase === "blocked" ? [] : [running(run.id, "fork", run.args.id, run.args.copy, run.state.copying)],
				),
				...archiving.flatMap((run) =>
					run.phase === "blocked" ? [] : [running(run.id, "archive", run.args.id, null, false)],
				),
				...list,
			],
		);
		/** Sessions whose worker must not start yet: a copy's row being made, or its files being copied. */
		const copying = deriveTyped(self, [preparing, operations], ([made, list]) => [
			...made,
			...list.flatMap((operation) =>
				operation.phase === "running" && operation.copying && operation.target !== null ? [operation.target] : [],
			),
		]);

		/** A destination as the move stores it: `~` expanded and checked to be a directory (on its environment). */
		const destination = async ({ cwd, env }: Location): Promise<Location> => {
			if (env) return { cwd: await envs().manager.workingDirectory(env, cwd, false), env };
			const local = resolve(expandHome(cwd));
			if (!(await stat(local)).isDirectory()) throw new Error("Working directory is not a directory");
			return { cwd: local, env: null };
		};
		const liveSession = async (id: string, ctx: Ctx): Promise<Session> => {
			const session = await catalog.get({ id }, ctx);
			if (session.archivedAt !== null) throw new Error("Session is archived");
			return session;
		};
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
		/**
		 * Makes a copy's row and starts the job filling it, its worker held back meanwhile. A copy that exists already is
		 * a retry of the same request: its row is the answer.
		 */
		const startCopy = async (
			source: Session,
			copy: string,
			mark: string,
			start: () => Promise<unknown>,
			ctx: Ctx,
		) => {
			const existing = catalog.sessions.value.find((session) => session.id === copy);
			if (existing) return existing;
			preparing.set([...preparing.value, copy]);
			try {
				const row = await copyOf(source, copy, mark, ctx);
				for (const take of copied.value.values()) await take(source.id, copy, ctx);
				await start();
				return row;
			} catch (error) {
				await failCopy(copy, ctx);
				throw error;
			} finally {
				preparing.set(preparing.value.filter((id) => id !== copy));
			}
		};

		// The start data of a session's worker; refuses archived and unknown sessions. A copy's worker waits until its
		// files are there; a client-chosen ID held before its row exists waits for the row.
		self.contribute(WorkerInitValues, {
			session: async (id, context): Promise<SessionInit> => {
				const waiting = withAbortSignal(AbortSignal.timeout(ROW_WAIT_MS), context);
				await until(catalog.sessions, (rows) => rows.some((row) => row.id === id), waiting).catch(() => {});
				await until(copying, (ids) => !ids.includes(id), context);
				return startData(id, context);
			},
		});
		const startData = async (id: string, context: Context): Promise<SessionInit> => {
			const session = await catalog.get({ id }, context);
			// An archived session starts only to rebuild its index, and then without resuming its work.
			const indexing = session.archivedAt !== null && archivedStarts.allowed.value.includes(id);
			if (session.archivedAt !== null && !indexing) throw forbidden("Session is archived");
			if (session.env !== null && session.env !== undefined && !Object.hasOwn(envService.configs.value, session.env))
				throw new Error(`Environment "${session.env}" is not configured; refusing local execution`);
			return {
				id: session.id,
				cwd: session.cwd,
				env: session.env ?? null,
				model: session.model,
				thinkingLevel: session.thinkingLevel as SessionInit["thinkingLevel"],
				...(indexing ? { resume: false } : {}),
			};
		};
		return {
			operations,
			create: async ({ id, env, cwd, createDirectory, title, model, thinkingLevel }, ctx) => {
				// A chosen ID already in the catalog is a retry of the same request (its answer was lost).
				const existing = id === undefined ? undefined : catalog.sessions.value.find((row) => row.id === id);
				if (existing) return existing;
				if (env) cwd = await envs().manager.workingDirectory(env, cwd, createDirectory);
				else {
					cwd = expandHome(cwd);
					if (!isAbsolute(cwd)) throw new Error("The working directory must be an absolute path");
					if (createDirectory) await mkdir(cwd, { recursive: true });
					if (!(await stat(cwd)).isDirectory()) throw new Error("Working directory is not a directory");
				}
				const fallback = models.summary.value.defaultModel;
				const chosen = model ?? fallback;
				if (!chosen) throw new Error("Select a model or configure P2_PROVIDER and P2_MODEL");
				// As Pi Mobile and setDefault: a model the configuration does not know never reaches a worker.
				if (!resources().resources.models.getModel(chosen.provider, chosen.modelId))
					throw new Error("Unknown model");
				const level = thinkingLevel ?? fallback?.thinkingLevel;
				return catalog.create(
					{
						...(id === undefined ? {} : { id }),
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
			move: async ({ id, ...target }, ctx) => {
				await liveSession(id, ctx);
				const location = await destination(target);
				const run = await relocations.start({ id, ...location, by: "agent" }, ctx);
				const outcome = await run.outcome(ctx);
				if (outcome.kind === "failed") throw new Error(failureText(outcome.error));
				return outcome.result;
			},
			relocate: async ({ id, ...target }, ctx) => {
				await liveSession(id, ctx);
				const location = await destination(target);
				await relocations.start({ id, ...location, by: "owner" }, ctx);
				return null;
			},
			clone: async ({ id, copy }, ctx) => {
				const source = await liveSession(id, ctx);
				return startCopy(source, copy, "copy", () => clones.start({ id, copy }, ctx, { key: copy }), ctx);
			},
			fork: async ({ id, copy, conversation, before }, ctx) => {
				const source = await liveSession(id, ctx);
				// Read now, so a fork of a subagent or of an unknown message is refused before anything is made. This local
				// object's `ctx.get` acts as the server, whom `SessionTransfer` serves.
				const { entries } = await (await ctx.get(SessionTransfer, { session: id })).history(
					{ conversation, before },
					ctx,
				);
				return startCopy(source, copy, "fork", () => forks.start({ id, copy, entries }, ctx, { key: copy }), ctx);
			},
			archive: async ({ id }, ctx) => {
				await catalog.update({ id, archived: true }, ctx);
				await archives.start({ id }, ctx, { key: id });
				return null;
			},
			restore: async ({ id }, ctx) => {
				// After a running archive of it: its worker stop must not land after the restore.
				const archiving = archives.running.value.find((run) => run.phase !== "blocked" && run.key === id);
				if (archiving) await archives.outcome(archiving.id, ctx).catch(() => {});
				await catalog.update({ id, archived: false }, ctx);
				// A start refused while archived left the worker failed or suspended: its holders start it again.
				await natives().workers.resume(id);
				return null;
			},
			dismiss: async ({ operation }, ctx) => {
				await failed.change((draft) => {
					draft.list = draft.list.filter((each) => each.id !== operation);
				}, ctx);
				return null;
			},
		};
	});

	host.serve(SessionMoves, (_params, self) => {
		const operations = self.get(SessionOperations, {});
		return { relocate: (target, ctx) => operations.move(target, ctx) };
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
			const lifecycle = self.get(SessionOperations, {});
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
			return {
				variant: "owner",
				members: {
					sessions: catalog.sessions,
					defaultCwd,
					defaultEnv,
					operations: lifecycle.operations,
					create: (args, ctx) => lifecycle.create(args, ctx),
					relocate: (target, ctx) => lifecycle.relocate(target, ctx),
					clone: ({ id, copy }, ctx) => lifecycle.clone({ id, copy: copy ?? randomUUID() }, ctx),
					fork: ({ copy, ...from }, ctx) => lifecycle.fork({ ...from, copy: copy ?? randomUUID() }, ctx),
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
					archive: (args, ctx) => lifecycle.archive(args, ctx),
					restore: (args, ctx) => lifecycle.restore(args, ctx),
					dismissOperation: (args, ctx) => lifecycle.dismiss(args, ctx),
				},
			};
		},
		{ accepts: SESSIONS_ACCEPTS },
	);
});

/** A running operation's entry. */
function running(
	id: string,
	kind: Operation["kind"],
	session: string,
	target: string | null,
	copying: boolean,
): Operation {
	return { phase: "running", id, kind, session, target, copying };
}
