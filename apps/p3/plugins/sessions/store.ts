// The sessions store (`SessionsStore`): one row per session (its address, where it works, its state, its model, when
// it was archived), one per conversation moved to a location of its own, their named queries, and every write. Both
// are keyed by the session's address, so a session's export, import and delete carry them. Who may do what is the
// things plugin's (the session's workspace); this store checks no caller and holds no members, but a move needs the
// agents' Work on the machine (decision 24). Rows older code wrote naming this device as `this-device` are rewritten
// once per Pi to its machine's id, a session's own folder moved from the data directory to the work root (decision
// 125).

import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
	and,
	bool,
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
	Session,
	type SetOf,
	str,
	union,
	until,
} from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { MACHINE_KIND } from "../environments/contract.ts";
import { OneThing, ThingsStore } from "../things/contract.server.ts";
import { MOVED_MAX, SessionsStore } from "./contract.server.ts";
import { type Location, ModelChoice, type SessionState } from "./contract.ts";
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
	model: json(union([ModelChoice, nul()]), { version: 1 }),
};

/**
 * Every session, one row each; by state for the waker. Version 1, as p3-base stored it: the machine named
 * `environment`.
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
		model: json(union([ModelChoice, nul()]), { version: 1 }),
	},
	key: ["id"],
	indexes: { working: ["state", "archivedAt"] },
});

/** Version 2: the machine column named as decision 24 names it (`ROW`); stored rows keep their values. */
const Rows = evolveTable(RowsV1, (t) => t.rename("environment", "machine"));

/** The conversations moved to a location of their own: one row per session and conversation (Durable's id as text). */
const Locations = defineTable("sessions.locations", {
	version: 1,
	columns: { session: hostColumn(Session), conversation: str(), machine: str(), folder: str() },
	key: ["session", "conversation"],
});

/** The machine kind's tick that lets the agents work on a machine (Work here). */
const WORK = "work";

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
		const locations = self.table(Locations);
		// Once per Pi, once this device's machine was made: the rows that named this device by its old id name it now,
		// and a session's own folder moves to where new sessions get theirs (one read of every row, no index on
		// `machine`: it runs once, the marker says so after). The folders move outside a transaction: a copy may take
		// long.
		self.onLive(async (ctx) => {
			if (rewrites.value.thisDevice) return;
			const machine = await until(device.thing, (id) => id !== "", ctx);
			const old = query(Rows).where((s) => eq(s.machine, OLD_DEVICE));
			const found = await self.tx(async (tx) => {
				const all: { id: RowOf<typeof ROW>["id"]; folder: string }[] = [];
				for await (const row of tx.rows(rows, old)) all.push({ id: row.id, folder: row.folder });
				return all;
			}, ctx);
			const moved: typeof found = [];
			for (const { id, folder } of found) {
				const session = id.params.id;
				const own = join(runtime.value.dataDir, "folders", session);
				// A location the person chose stays where it is.
				moved.push({
					id,
					folder: folder === own ? await movedFolder(own, join(runtime.value.workRoot, session)) : folder,
				});
			}
			await self.tx(async (tx) => {
				for (const { id, folder } of moved) {
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
		 * workspace gives them Work here on, which is what the machine's harness part asks at each use.
		 */
		const agentsWorkAt = async (session: string, { machine, folder }: Location, ctx: Ctx<P3Principal>) => {
			if (!isAbsolute(folder)) {
				throw invalid("args", `sessions: ${folder} is no full path`, { message: messages.message("notFullPath") });
			}
			const answer = await things.answerOf({ workspace: session, thing: machine, caller: `worker:${session}` }, ctx);
			if (answer?.kind !== MACHINE_KIND) throw noMachine(machine);
			if (!answer.ticks.includes(WORK)) {
				throw invalid("args", `sessions: the agents of ${session} have no Work on ${machine}`, {
					message: messages.message("noWork", machine),
				});
			}
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
			locations: self.queries(
				locations,
				{ map: ({ conversation, machine, folder }) => ({ conversation, location: { machine, folder } }) },
				{
					// The key's prefix, in key order (by conversation).
					ofSession: ({ session }: { session: string }) =>
						query(Locations).where((l) => eq(l.session, Session({ id: session }))),
				},
			),
			insert: async ({ id, location, model }, ctx) => {
				// A session's own folder is outside the data directory (Files never shows that one).
				const where = location ?? {
					machine: await until(device.thing, (machine) => machine !== "", ctx),
					folder: join(runtime.value.workRoot, id),
				};
				if (location === undefined) {
					// An empty folder a failed commit leaves is harmless; a session without its folder is not.
					await mkdir(where.folder, { recursive: true, mode: 0o700 });
				} else {
					// A trust boundary: the make's input comes from a page. A location names a machine thing.
					const found = await things.things.one.page({ thing: location.machine }, 1, ctx);
					if (found.items[0]?.kind !== MACHINE_KIND) throw noMachine(location.machine);
				}
				return self.tx(async (tx) => {
					const now = Date.now();
					const state: SessionState = "settled";
					tx.put(rows, {
						id: Session({ id }),
						machine: where.machine,
						folder: where.folder,
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
				await agentsWorkAt(session, location, ctx);
				return self.tx(async (tx) => {
					const id = Session({ id: session });
					if ((await tx.get(rows, { id })) === undefined) throw invalid("args", `sessions: no session ${session}`);
					const key = { session: id, conversation };
					if ((await tx.get(locations, key)) === undefined) {
						// Index: the key's prefix. Bounded by the writes, so the worker's read of them is whole.
						const moved = await tx.page(
							locations,
							query(Locations).where((l) => eq(l.session, id)),
							MOVED_MAX,
						);
						if (moved.items.length >= MOVED_MAX)
							throw invalid("args", `sessions: ${session} has ${MOVED_MAX} moved`);
					}
					tx.put(locations, { ...key, machine: location.machine, folder: location.folder });
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
			remove: ({ session }, ctx) =>
				self.tx(async (tx) => {
					const id = Session({ id: session });
					tx.delete(rows, { id });
					// The key's prefix: a session's moved conversations, few (`MOVED_MAX`).
					for await (const { conversation } of tx.rows(
						locations,
						query(Locations).where((l) => eq(l.session, id)),
					)) {
						tx.delete(locations, { session: id, conversation });
					}
					return null;
				}, ctx),
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

/** The refusal of a location on `machine`, which is no machine here. */
function noMachine(machine: string): Error {
	return invalid("args", `sessions: no machine ${machine}`, { message: messages.message("noMachine", machine) });
}

/**
 * Moves a session's own folder `from` to `to` and answers where its files are now: `to` once moved; `from` when `to`
 * is taken or the move failed (nothing is lost, nothing overwritten); `to` when only `to` is there (a move a crash cut
 * short after the rename).
 */
async function movedFolder(from: string, to: string): Promise<string> {
	const [source, target] = await Promise.all([present(from), present(to)]);
	if (target) return source ? from : to;
	if (!source) return from;
	try {
		await mkdir(dirname(to), { recursive: true, mode: 0o700 });
		await rename(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") return from;
		// Another file system: a copy beside the target, renamed into place once whole, so `to` is never a part.
		const part = `${to}.moving`;
		try {
			await rm(part, { recursive: true, force: true });
			await cp(from, part, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
			await rename(part, to);
		} catch {
			await rm(part, { recursive: true, force: true });
			return from;
		}
		await rm(from, { recursive: true, force: true });
	}
	return to;
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
		location: { machine, folder },
		// `state` and `model` hold only what this plugin wrote: a `SessionState`, a `ModelChoice` or null.
		state: state as SessionState,
		archivedAt: archivedAt === 0 ? null : archivedAt,
		model: model as ModelChoice | null,
	};
}
