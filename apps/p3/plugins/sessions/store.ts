// The sessions store (`SessionsStore`): one row per session (its address, where it works, its state, its model, when
// it was archived) and one per session defaults thing whose settings were set; their named queries, and every write.
// A session's row is keyed by its address, so a session's export, import and delete carry it. Who may do what is the
// things plugin's (the session's workspace); this store checks no caller and holds no members.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	and,
	type Ctx,
	defineTable,
	eq,
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
} from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { EnvironmentsStore } from "../environments/contract.server.ts";
import { THIS_DEVICE } from "../environments/contract.ts";
import { SessionsStore } from "./contract.server.ts";
import { ModelChoice, SessionDefaults, type SessionState } from "./contract.ts";
import { messages } from "./messages.ts";

/**
 * A session's row: its address, where it works (a machine's id and a folder), when it was made, its state, when it was
 * last touched, when it was archived (0: it is not; an index column is never optional) and its model.
 */
const ROW = {
	id: hostColumn(Session),
	environment: str(),
	folder: str(),
	createdAt: int(),
	state: str(),
	lastTouch: int(),
	archivedAt: int(),
	model: json(union([ModelChoice, nul()]), { version: 1 }),
};

/** Every session, one row each; by state for the waker. */
const Rows = defineTable("sessions.sessions", {
	version: 1,
	columns: ROW,
	key: ["id"],
	indexes: { working: ["state", "archivedAt"] },
});

/** Each session defaults thing's settings, by thing (none set: `defaults.ts`'s own). */
const Defaults = defineTable("sessions.defaults", {
	version: 1,
	columns: { thing: str(), defaults: json(SessionDefaults, { version: 1 }) },
	key: ["thing"],
});

/** Serves `SessionsStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(SessionsStore, (_params, self) => {
		const rows = self.table(Rows);
		const defaults = self.table(Defaults);
		const environments = self.get(EnvironmentsStore, {});
		const runtime = self.registry(ServerRuntime);
		/** Sets `change` on session `id`'s row: an `update`, so only the reads that depend on those columns run. */
		const update = (id: string, change: SetOf<typeof ROW, readonly ["id"]>, ctx: Ctx<P3Principal>) =>
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
					// The key.
					one: ({ id }: { id: string }) => query(Rows).where((s) => eq(s.id, Session({ id }))),
				},
			),
			defaults: self.queries(
				defaults,
				{ map: ({ thing, defaults: set }) => ({ thing, defaults: set as SessionDefaults }) },
				{
					// The key.
					one: ({ thing }: { thing: string }) => query(Defaults).where((d) => eq(d.thing, thing)),
				},
			),
			insert: async ({ id, location, model }, ctx) => {
				const where = location ?? { environment: THIS_DEVICE, folder: join(runtime.value.dataDir, "folders", id) };
				if (location === undefined) {
					// An empty folder a failed commit leaves is harmless; a session without its folder is not.
					await mkdir(where.folder, { recursive: true, mode: 0o700 });
				} else {
					// A trust boundary: the make's input comes from a page.
					const found = await environments.environments.one.page({ id: location.environment }, 1, ctx);
					if (found.items.length === 0) {
						throw invalid("args", `sessions: no machine ${location.environment}`, {
							message: messages.message("noMachine", location.environment),
						});
					}
				}
				return self.tx(async (tx) => {
					const now = Date.now();
					const state: SessionState = "settled";
					tx.put(rows, {
						id: Session({ id }),
						environment: where.environment,
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
			report: ({ session, state }, ctx) => update(session, { state, lastTouch: Date.now() }, ctx),
			remove: ({ session }, ctx) =>
				self.tx(async (tx) => {
					tx.delete(rows, { id: Session({ id: session }) });
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
			setDefaults: ({ thing, defaults: set }, ctx) =>
				self.tx(async (tx) => {
					tx.put(defaults, { thing, defaults: set });
					return null;
				}, ctx),
			removeDefaults: ({ thing }, ctx) =>
				self.tx(async (tx) => {
					tx.delete(defaults, { thing });
					return null;
				}, ctx),
		};
	});
}

/** A table row as the store's queries answer it. */
function shown({ id, environment, folder, state, archivedAt, model, ...row }: RowOf<typeof ROW>) {
	return {
		id: id.params.id,
		...row,
		location: { environment, folder },
		// `state` and `model` hold only what this plugin wrote: a `SessionState`, a `ModelChoice` or null.
		state: state as SessionState,
		archivedAt: archivedAt === 0 ? null : archivedAt,
		model: model as ModelChoice | null,
	};
}
