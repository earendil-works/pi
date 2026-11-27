// The sessions store (`SessionsStore`): one row per session (its address, where it works, its state, its model, when
// it was archived), one per conversation moved to a location of its own, their named queries, and every write. Both
// are keyed by the session's address, so a session's export, import and delete carry them. Who may do what is the
// things plugin's (the session's workspace); this store checks no caller and holds no members, but a move needs the
// agents' Work on the machine (decision 24).

import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	and,
	type Ctx,
	defineTable,
	eq,
	evolveTable,
	type FacetHost,
	host as hostColumn,
	int,
	invalid,
	json,
	nul,
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

/** Serves `SessionsStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(SessionsStore, (_params, self) => {
		const rows = self.table(Rows);
		const things = self.get(ThingsStore, {});
		// This device's machine: where a session works unless it says otherwise.
		const device = self.get(OneThing, { kind: MACHINE_KIND });
		const runtime = self.registry(ServerRuntime);
		const locations = self.table(Locations);
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
