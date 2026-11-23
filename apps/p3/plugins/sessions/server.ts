// The sessions plugin on the server. Every session is one row of a table keyed by its address, so a session's export,
// import and delete carry it. One local store (`SessionsStore`, `contract.server.ts`) owns the table, writes it and
// offers its rows as named queries; the owner's `Sessions` and `SessionsList`, each worker's `SessionFacts` (its row,
// and its report of what its agent does) and the route's `SessionRoute` read them. The waker starts the workers of
// every `working` session once the server is up (a restart cut their runs off; Durable resumes them there): it holds
// each one's `SessionStart` until the worker is live, then lets go. A worker keeps itself alive while it works.

import {
	and,
	type Ctx,
	contribute,
	defineFacet,
	defineTable,
	eq,
	forbidden,
	forward,
	gt,
	host as hostColumn,
	int,
	invalid,
	json,
	query,
	type RowOf,
	Session,
	str,
} from "@earendil-works/p3/v1";
import { ServerRuntime, SessionRoute } from "@earendil-works/p3/v1/server";
import { SessionsStore } from "./contract.server.ts";
import {
	CODING,
	Creator,
	SessionFacts,
	type SessionRow,
	SessionStart,
	type SessionState,
	Sessions,
	SessionsList,
} from "./contract.ts";

/**
 * A session's row: its address, title, app, creator, when it was made, its state, when it was last touched, and when
 * it was archived. `archivedAt` is 0 while it is not archived: both lists need it in their index, and index and order
 * columns are never optional.
 */
const ROW = {
	id: hostColumn(Session),
	title: str(),
	app: str(),
	creator: json(Creator, { version: 1 }),
	createdAt: int(),
	state: str(),
	lastTouch: int(),
	archivedAt: int(),
};

/** A row of `Rows`. */
type Row = RowOf<typeof ROW>;

/**
 * Every session, one row each, by its address. One index per list: a list's whole order (its column, then the key)
 * must be its index's after the columns its condition fixes, or SQLite sorts every page it reads.
 */
const Rows = defineTable("sessions.rows", {
	version: 1,
	columns: ROW,
	key: ["id"],
	indexes: { active: ["app", "archivedAt", "lastTouch"], archived: ["app", "archivedAt"], state: ["state"] },
});

/** How many sessions a page of a list holds. */
const PAGE = 50;

export default defineFacet((host) => {
	host.serve(SessionsStore, (_params, self) => {
		const rows = self.table(Rows);
		/** Sets `change` on session `id`'s row: an `update`, so only the reads that depend on those columns run. */
		const update = (id: string, change: Partial<Row>, ctx: Ctx) =>
			self.tx(async (tx) => {
				const key = { id: Session({ id }) };
				if ((await tx.get(rows, key)) === undefined) throw invalid("args", `sessions: no session ${id}`);
				tx.update(rows, key, change);
				return null;
			}, ctx);
		return {
			sessions: self.queries(
				rows,
				{ map: shown },
				{
					// Index `active`: `app` and `archivedAt` fixed, in the order of `lastTouch`, then the key.
					active: ({ app }: { app: string }) =>
						query(Rows)
							.where((s) => and(eq(s.app, app), eq(s.archivedAt, 0)))
							.orderBy((s) => s.lastTouch, "desc"),
					// Index `archived`: `app` fixed, a range of `archivedAt` in its order, then the key.
					archived: ({ app }: { app: string }) =>
						query(Rows)
							.where((s) => and(eq(s.app, app), gt(s.archivedAt, 0)))
							.orderBy((s) => s.archivedAt, "desc"),
					// The key.
					one: ({ id }: { id: string }) => query(Rows).where((s) => eq(s.id, Session({ id }))),
				},
			),
			create: async ({ title, creator }, ctx) => {
				const id = crypto.randomUUID();
				const now = Date.now();
				const state: SessionState = "settled";
				const row = { id: Session({ id }), title, app: CODING, creator, state };
				await self.tx(async (tx) => tx.put(rows, { ...row, createdAt: now, lastTouch: now, archivedAt: 0 }), ctx);
				return id;
			},
			rename: ({ id, title }, ctx) => update(id, { title }, ctx),
			archive: ({ id }, ctx) => update(id, { archivedAt: Date.now() }, ctx),
			restore: ({ id }, ctx) => update(id, { archivedAt: 0 }, ctx),
			report: ({ id, state }, ctx) => update(id, { state, lastTouch: Date.now() }, ctx),
			working: (_args, ctx) =>
				self.tx(async (tx) => {
					// Index `state`; every row, no cap: a session left out would never resume.
					const ids: string[] = [];
					for await (const row of tx.rows(
						rows,
						query(Rows).where((s) => eq(s.state, "working")),
					)) {
						ids.push(row.id.params.id);
					}
					return ids;
				}, ctx),
		};
	});

	host.serve(Sessions, (_params, principal, self) => {
		if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
		const store = self.get(SessionsStore, {});
		return forward(store, Sessions, "owner", {
			create: ({ title }, ctx) => store.create({ title: title ?? "", creator: { kind: "owner" } }, ctx),
		});
	});

	host.serve(SessionsList, ({ app, set }, principal, self) => {
		if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
		const list = self.list("sessions", [[self.get(SessionsStore, {}).sessions[set], { app }]], { first: PAGE });
		return { variant: "owner", members: { list: list.value, more: (ctx) => list.more(ctx) } };
	});

	host.serve(SessionFacts, (_params, principal, self) => {
		if (principal.kind !== "worker") throw forbidden("sessions: a session's worker only");
		const store = self.get(SessionsStore, {});
		const found = self.liveQuery(store.sessions.one, { id: principal.session }, { first: 1 });
		return {
			variant: "worker",
			members: {
				session: self.derive([found], ([{ rows }]) => rows[0] ?? null),
				report: ({ state }, ctx) => store.report({ id: principal.session, state }, ctx),
			},
		};
	});

	contribute(host, "sessions.waker", (self) => {
		const store = self.get(SessionsStore, {});
		const runtime = self.registry(ServerRuntime);
		self.onLive(async (ctx) => {
			const { host: server } = runtime.value;
			const starts = (await store.working({}, ctx)).map((session) =>
				// Held until the worker serves it (it is live then), released when `root` returns.
				server
					.root(async (root) => void (await root.get(SessionStart, { session })), ctx)
					.catch((error: unknown) => {
						console.error(`p3 sessions: ${session}: could not start its worker:`, error);
					}),
			);
			await Promise.all(starts);
		});
	});

	host.serve(SessionRoute, ({ session }, self) => {
		const found = self.liveQuery(self.get(SessionsStore, {}).sessions.one, { id: session }, { first: 1 });
		return { exists: self.derive([found], ([{ rows }]) => rows.length === 1) };
	});
});

/** A table row as lists and a session's worker see it. */
function shown({ id, state, archivedAt, ...row }: Row): SessionRow {
	// `state` holds only what this plugin wrote: a `SessionState`.
	return { id: id.params.id, ...row, state: state as SessionState, archivedAt: archivedAt === 0 ? null : archivedAt };
}
