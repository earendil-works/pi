// The sessions plugin on the server. Every session is one row of a table (listed, queried) and one document of facts
// keyed by its address (what its worker, and later admissions, pin): both belong to the session's host, so its export,
// import and delete carry them, and both are written in one transaction. One local store owns them; the owner's
// `Sessions` and each worker's `SessionFacts` are views of it.

import {
	arr,
	type Ctx,
	defineFacet,
	defineState,
	defineTable,
	forbidden,
	type HandleOf,
	host as hostColumn,
	int,
	invalid,
	json,
	keyed,
	local,
	mapShared,
	method,
	obj,
	opt,
	query,
	type RowOf,
	Session,
	str,
	type Tx,
} from "@p3/app/v1";
import {
	Creator,
	Facts,
	SessionFacts,
	type SessionInfo,
	type SessionRow,
	SessionRow as SessionRowSchema,
	Sessions,
} from "./contract.ts";

/** A session's row: its address, title, app, creator, when it was made, and when it was archived (absent: not). */
const ROW = {
	id: hostColumn(Session),
	title: str(),
	app: str(),
	creator: json(Creator, { version: 1 }),
	createdAt: int(),
	archivedAt: opt(int()),
};

/** A row of `Rows`. */
type Row = RowOf<typeof ROW>;

/** Every session, one row each, by its address. */
const Rows = defineTable("sessions.rows", {
	version: 1,
	columns: ROW,
	key: ["id"],
	indexes: { created: ["createdAt"] },
});

/** A session's facts by its address; a session the server does not know has `{ session: null }`. */
const FactsDocs = defineState("sessions.facts-of", {
	schema: Facts,
	version: 1,
	initial: () => ({ session: null }),
	keyed: Session,
	persist: true,
	checkpointWhen: () => true,
});

/** A row as lists show it, the same object for a row that did not change (`mapShared`: the list's diff stays small). */
const shown = mapShared(rowOf);

/** How many sessions the owner's list holds: the newest. */
const LIST = 200;

/** The newest sessions first (the key breaks ties of one millisecond). */
const NEWEST = query(Rows).orderBy((row) => row.createdAt, "desc");

/** The sessions and their facts, once per server. */
const SessionsStore = local("sessions.store", {
	version: 1,
	params: {},
	members: {
		list: arr(SessionRowSchema),
		facts: keyed(Facts, Session),
		create: method(obj({ title: str(), creator: Creator }), str()),
		rename: method(obj({ id: str(), title: str() })),
		archive: method(obj({ id: str() })),
		restore: method(obj({ id: str() })),
	},
});

export default defineFacet((host) => {
	host.serve(SessionsStore, (_params, self) => {
		const rows = self.table(Rows);
		const facts = self.state(FactsDocs);
		const newest = self.query(rows, NEWEST, LIST);
		/** Replaces session `id`'s row by `change(row)` and writes its facts from the new row, in one transaction. */
		const update = (id: string, change: (row: Row) => Row, ctx: Ctx) =>
			self.tx(async (tx) => {
				const old = await tx.get(rows, { id: Session({ id }) });
				if (old === undefined) throw invalid("args", `sessions: no session ${id}`);
				const row = change(old);
				tx.put(rows, row);
				await writeFacts(tx, facts, row);
			}, ctx);
		return {
			list: self.derive([newest], ([found]) => shown(found)),
			facts,
			create: async ({ title, creator }, ctx) => {
				const id = crypto.randomUUID();
				const row: Row = { id: Session({ id }), title, app: "coding", creator, createdAt: Date.now() };
				await self.tx(async (tx) => {
					tx.put(rows, row);
					await writeFacts(tx, facts, row);
				}, ctx);
				return id;
			},
			rename: async ({ id, title }, ctx) => {
				await update(id, (row) => ({ ...row, title }), ctx);
				return null;
			},
			archive: async ({ id }, ctx) => {
				await update(id, (row) => ({ ...row, archivedAt: Date.now() }), ctx);
				return null;
			},
			restore: async ({ id }, ctx) => {
				await update(id, ({ archivedAt: _, ...row }) => row, ctx);
				return null;
			},
		};
	});

	host.serve(Sessions, (_params, principal, self) => {
		if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
		const store = self.get(SessionsStore, {});
		return {
			variant: "owner",
			members: {
				list: store.list,
				create: ({ title }, ctx) => store.create({ title: title ?? "", creator: { kind: "owner" } }, ctx),
				rename: (args, ctx) => store.rename(args, ctx),
				archive: (args, ctx) => store.archive(args, ctx),
				restore: (args, ctx) => store.restore(args, ctx),
			},
		};
	});

	host.serve(SessionFacts, (_params, principal, self) => {
		if (principal.kind !== "worker") throw forbidden("sessions: a session's worker only");
		const store = self.get(SessionsStore, {});
		return { variant: "worker", members: { facts: store.facts.at(Session({ id: principal.session })) } };
	});
});

/** A table row as lists show it. */
function rowOf(row: Row): SessionRow {
	return { id: row.id.params.id, ...infoOf(row) };
}

/** What a table row says of its session besides its id. */
function infoOf({ title, app, creator, createdAt, archivedAt }: Row): SessionInfo {
	return { title, app, creator, createdAt, archivedAt: archivedAt ?? null };
}

/** Writes the facts of `row`'s session from it, inside `tx`. */
async function writeFacts(tx: Tx, facts: HandleOf<typeof FactsDocs>, row: Row): Promise<void> {
	const draft = await tx.draft(facts, row.id);
	draft.session = infoOf(row);
}
