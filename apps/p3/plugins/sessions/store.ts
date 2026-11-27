// The sessions store (`SessionsStore`): one row per session (its address, where it works, its state, its model, when
// it was archived) with its named query, one document per session with a conversation moved to a location of its own,
// and every write. Both are keyed by the session's address, so a session's export, import and delete carry them. Who
// may do what is the things plugin's (the session's workspace); this store checks no caller and holds no members, but
// a move needs the agents' Work on the machine (decision 24). Rows older code wrote naming this device as `this-device`
// are rewritten once per Pi to its machine's id, a session's own folder moved from the data directory to the work
// root where one rename can (decision 125).

import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
	and,
	bool,
	type Context,
	type Ctx,
	defineState,
	defineTable,
	eq,
	evolveTable,
	type FacetHost,
	host as hostColumn,
	int,
	invalid,
	json,
	nul,
	obj,
	type P3Principal,
	query,
	type RowOf,
	reportError,
	Session,
	type SetOf,
	str,
	union,
	until,
} from "@earendil-works/p3/v1";
import { ServerRuntime, WorkerRunners } from "@earendil-works/p3/v1/server";
import { checkMachine } from "../environments/contract.server.ts";
import { MACHINE_KIND } from "../environments/contract.ts";
import { OneThing, ThingsStore } from "../things/contract.server.ts";
import { type Caller, callerKeyOf } from "../things/contract.ts";
import { SessionsStore } from "./contract.server.ts";
import { type Location, ModelChoice, SessionDetail, type SessionState, ThinkingLevel } from "./contract.ts";
import { messages } from "./messages.ts";

/**
 * A session's row: its address, where it works (a machine's id and a folder), when it was made, its state, when it was
 * last touched, when it was archived (0: it is not; an index column is never optional) and its model.
 */
const ROW = {
	id: hostColumn(Session),
	machine: str(),
	folder: str(),
	createdAt: int(),
	state: str(),
	lastTouch: int(),
	archivedAt: int(),
	// Version 2: a choice names a login, not a provider; a choice of version 1 reads as none (decisions 71, 124).
	model: json(union([ModelChoice, nul()]), { version: 2, migrate: () => null }),
};

/** A model choice as version 1 of the tables stored it (a provider, not a login): their history's, never read. */
export const ModelChoiceV1 = obj({ provider: str({ max: 200 }), model: str({ max: 200 }), thinking: ThinkingLevel });

/**
 * Every session, one row each; by state for the waker. Version 1, as Pis deployed from 7093618af stored it: the
 * machine named `environment`, a model choice naming a provider.
 */
const RowsV1 = defineTable("sessions.sessions", {
	version: 1,
	columns: {
		id: hostColumn(Session),
		environment: str(),
		folder: str(),
		createdAt: int(),
		state: str(),
		lastTouch: int(),
		archivedAt: int(),
		model: json(union([ModelChoiceV1, nul()]), { version: 1 }),
	},
	key: ["id"],
	indexes: { working: ["state", "archivedAt"] },
});

/** Version 2: the model choice names a login (decision 124); stored data survives the update (decision 125). */
const RowsV2 = evolveTable(RowsV1, (t) => t.json("model", ROW.model));

/** Version 3: the machine column named as decision 24 names it (`ROW`); stored rows keep their values. */
const Rows = evolveTable(RowsV2, (t) => t.rename("environment", "machine"));

/**
 * Where each session's moved conversations work: one document per session with a move, read whole by its Manage and
 * its worker.
 */
const Moved = defineState("sessions.moved", {
	schema: SessionDetail,
	version: 1,
	initial: () => ({ locations: {} }),
	keyed: Session,
	persist: true,
	// A move is rare and the document small: each one is stored whole.
	checkpointWhen: () => true,
});

/**
 * How many conversations of one session may have a location of their own (`moveLocation` refuses more): the bound of
 * its document (a session's conversations are its main one and its subagents').
 */
const MOVED_MAX = 1000;

/**
 * The id a session's location named this device by before the machine was a thing (p3-base's data from 7093618af,
 * decision 125): rewritten once per Pi to the machine's id (`OLD_DEVICE` rows, the `Rewrites` marker).
 */
const OLD_DEVICE = "this-device";

/** Which one-time rewrites of the rows this Pi has run: the old device id's (decision 125). */
const Rewrites = defineState("sessions.rewrites", {
	schema: obj({ thisDevice: bool() }),
	version: 1,
	initial: () => ({ thisDevice: false }),
	persist: true,
	// One small value written once: a checkpoint keeps it a single row.
	checkpointWhen: () => true,
});

/** Serves `SessionsStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(SessionsStore, (_params, self) => {
		const rows = self.table(Rows);
		const rewrites = self.state(Rewrites);
		const things = self.get(ThingsStore, {});
		// This device's machine: where a session works unless it says otherwise.
		const device = self.get(OneThing, { kind: MACHINE_KIND });
		const runtime = self.registry(ServerRuntime);
		const runners = self.registry(WorkerRunners);
		const moved = self.state(Moved);
		// Where this Pi's sessions get their own folders: `<work root>/<Pi's id>`, so Pis on one machine never share one
		// (deck2, p3-base). Pi stays, so its id is read once.
		let pi: Promise<string> | undefined;
		const ownFolders = async (ctx: Ctx<P3Principal>) => {
			pi ??= things.workspaces.children.page({ parent: "" }, 1, ctx).then(({ items }) => items[0]!.workspace);
			return join(runtime.value.workRoot, await pi);
		};
		// Once per Pi, once this device's machine was made: the rows that named this device by its old id name it now,
		// and a session's own folder moves to where new sessions get theirs (one read of every row, no index on
		// `machine`: it runs once, the marker says so after). The folders move outside a transaction, one rename each (a
		// folder one rename cannot move stays where it is, its row keeping it).
		self.onLive(async (ctx) => {
			if (rewrites.value.thisDevice) return;
			const machine = await until(device.thing, (id) => id !== "", ctx);
			const old = query(Rows).where((s) => eq(s.machine, OLD_DEVICE));
			const found = await self.tx(async (tx) => {
				const all: { id: RowOf<typeof ROW>["id"]; folder: string }[] = [];
				for await (const row of tx.rows(rows, old)) all.push({ id: row.id, folder: row.folder });
				return all;
			}, ctx);
			const rewritten: typeof found = [];
			const folders = await ownFolders(ctx);
			for (const { id, folder } of found) {
				const session = id.params.id;
				const own = join(runtime.value.dataDir, "folders", session);
				// A location the person chose stays where it is.
				rewritten.push({
					id,
					folder:
						folder === own
							? await movedFolder(own, join(folders, session), join(runtime.value.workRoot, session), ctx)
							: folder,
				});
			}
			await self.tx(async (tx) => {
				for (const { id, folder } of rewritten) {
					// A session deleted while its folder moved stays deleted.
					if ((await tx.get(rows, { id })) !== undefined) {
						tx.update(rows, { id }, { machine, folder });
					}
				}
				return null;
			}, ctx);
			await rewrites.change((draft) => {
				draft.thisDevice = true;
			}, ctx);
		});
		/** Sets `change` on session `id`'s row: an `update`, so only the reads that depend on those columns run. */
		const update = (id: string, change: SetOf<typeof ROW, readonly ["id"]>, ctx: Ctx<P3Principal>) =>
			self.tx(async (tx) => {
				const key = { id: Session({ id }) };
				if ((await tx.get(rows, key)) === undefined) throw invalid("args", `sessions: no session ${id}`);
				tx.update(rows, key, change);
				return null;
			}, ctx);
		/**
		 * Throws unless session `session`'s agents can work at `location` (decision 24): a full path, on a machine its
		 * workspace gives them Work here on (`checkMachine`, the machine kind's rule: what its harness part asks at each
		 * use).
		 */
		const agentsWorkAt = async (session: string, { machine, folder }: Location, ctx: Ctx<P3Principal>) => {
			fullPath(folder);
			const agents: Caller = { kind: "agent", session };
			const answer = await things.answerOf({ workspace: session, thing: machine, caller: callerKeyOf(agents) }, ctx);
			// Nothing there for them: the machine kind's refusal, as Files and Terminals give it (Astra, round 2); a thing
			// there that is no machine is none.
			if (answer === null) return checkMachine(machine, agents, undefined);
			if (answer.kind !== MACHINE_KIND) throw noMachine(machine);
			checkMachine(machine, agents, answer);
		};
		return {
			sessions: self.queries(
				rows,
				{ map: shown },
				{
					// The key.
					one: ({ id }: { id: string }) => query(Rows).where((s) => eq(s.id, Session({ id }))),
				},
			),
			moved,
			insert: async ({ id, location, model }, ctx) => {
				let where = location;
				if (where === undefined) {
					// A session's own folder is outside the data directory (Files never shows that one).
					const machine = await until(device.thing, (id) => id !== "", ctx);
					where = { machine, folder: join(await ownFolders(ctx), id) };
					// An empty folder a failed commit leaves is harmless; a session without its folder is not.
					await mkdir(where.folder, { recursive: true, mode: 0o700 });
				} else if (where !== null) {
					// A trust boundary: the make's input comes from a page. A location names a machine thing and a full path.
					fullPath(where.folder);
					const found = await things.things.one.page({ thing: where.machine }, 1, ctx);
					if (found.items[0]?.kind !== MACHINE_KIND) throw noMachine(where.machine);
				}
				return self.tx(async (tx) => {
					const now = Date.now();
					const state: SessionState = "settled";
					tx.put(rows, {
						id: Session({ id }),
						// On no machine: empty (a column is never optional where a row is read whole; `shown` says `null`).
						machine: where?.machine ?? "",
						folder: where?.folder ?? "",
						createdAt: now,
						state,
						lastTouch: now,
						archivedAt: 0,
						model,
					});
					return null;
				}, ctx);
			},
			archive: ({ session }, ctx) => update(session, { archivedAt: Date.now() }, ctx),
			restore: ({ session }, ctx) => update(session, { archivedAt: 0 }, ctx),
			setModel: ({ session, model }, ctx) => update(session, { model }, ctx),
			moveLocation: async ({ session, conversation, location }, ctx) => {
				if (location !== null) await agentsWorkAt(session, location, ctx);
				return self.tx(async (tx) => {
					const id = Session({ id: session });
					if ((await tx.get(rows, { id })) === undefined) throw invalid("args", `sessions: no session ${session}`);
					const { locations } = await tx.draft(moved, id);
					if (location === null) {
						delete locations[conversation];
						return null;
					}
					if (locations[conversation] === undefined && Object.keys(locations).length >= MOVED_MAX) {
						throw invalid("args", `sessions: ${session} has ${MOVED_MAX} moved`, {
							message: messages.message("tooManyMoved", MOVED_MAX),
						});
					}
					locations[conversation] = location;
					return null;
				}, ctx);
			},
			report: ({ session, state }, ctx) =>
				self.tx(async (tx) => {
					const key = { id: Session({ id: session }) };
					const found = await tx.get(rows, key);
					if (found === undefined) throw invalid("args", `sessions: no session ${session}`);
					// The worker may see an archive after it decided to work (Astra, round 1): the row never says an
					// archived session works, so the waker leaves it alone.
					if (state === "working" && found.archivedAt !== 0) {
						throw invalid("args", `sessions: ${session} is archived`, { message: messages.message("archived") });
					}
					tx.update(rows, key, { state, lastTouch: Date.now() });
					return null;
				}, ctx),
			remove: async ({ session }, ctx) => {
				await self.tx(async (tx) => {
					const id = Session({ id: session });
					tx.delete(rows, { id });
					await tx.retire(moved, id);
					return null;
				}, ctx);
				// Its worker stopped and what it kept deleted (a failure rejects, so the kind's delete is tried again). No
				// runner now (its plugin reloading): the sweep at the next runner finds the directory.
				await runners.value?.remove(session);
				return null;
			},
			working: (_args, ctx) =>
				self.tx(async (tx) => {
					// Index `working`; every row, no cap: a session left out would never resume.
					const ids: string[] = [];
					for await (const row of tx.rows(
						rows,
						query(Rows).where((s) => and(eq(s.state, "working"), eq(s.archivedAt, 0))),
					)) {
						ids.push(row.id.params.id);
					}
					return ids;
				}, ctx),
		};
	});
}

/** Throws unless `folder` is a full path: a relative one would be read from wherever the machine's process runs. */
function fullPath(folder: string): void {
	if (isAbsolute(folder)) return;
	throw invalid("args", `sessions: ${folder} is no full path`, { message: messages.message("notFullPath") });
}

/** The refusal of a location on `machine`, which is no machine here. */
function noMachine(machine: string): Error {
	return invalid("args", `sessions: no machine ${machine}`, { message: messages.message("noMachine", machine) });
}

/**
 * Moves a session's own folder `from` to `to` with one atomic rename and answers where its files are now, never a
 * folder that is not there: `to` once moved, or when only `to` is there (a move a crash cut short after the rename);
 * `earlier` when only it is there (00e4bc5e8 moved it there and stopped before its row was written, Astra, round 7);
 * `from` when `to` is taken or the rename is not possible (another file system, no permission): the folder stays whole
 * where it is and the row keeps its path, never a copy and a removal (Astra, round 6; decision 128). A folder that
 * stays out of Files' sight, or that is nowhere, is reported.
 */
async function movedFolder(from: string, to: string, earlier: string, context: Context): Promise<string> {
	const [source, target, before] = await Promise.all([present(from), present(to), present(earlier)]);
	if (target) return source ? from : to;
	if (!source) {
		if (before) return earlier;
		reportError(`sessions: ${from} is not there, nor at ${to} or ${earlier}`, "the row keeps it", context);
		return from;
	}
	try {
		await mkdir(dirname(to), { recursive: true, mode: 0o700 });
		await rename(from, to);
		return to;
	} catch (error) {
		reportError(`sessions: ${from} stays where it is (Files does not show it): not moved to ${to}`, error, context);
		return from;
	}
}

/** Whether `path` is there. */
const present = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

/** A table row as the store's queries answer it. */
function shown({ id, machine, folder, state, archivedAt, model, ...row }: RowOf<typeof ROW>) {
	return {
		id: id.params.id,
		...row,
		// On no machine (R41): both empty.
		location: machine === "" ? null : { machine, folder },
		// `state` and `model` hold only what this plugin wrote: a `SessionState`, a `ModelChoice` or null.
		state: state as SessionState,
		archivedAt: archivedAt === 0 ? null : archivedAt,
		model: model as ModelChoice | null,
	};
}
