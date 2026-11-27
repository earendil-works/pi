// The sessions store (`SessionsStore`): one row per session (its address, where it works, its state, its model, when
// it was archived), its named query, and every write. A session's row is keyed by its address, so a session's export,
// import and delete carry it. Who may do what is the things plugin's (the session's workspace); this store checks no
// caller and holds no members. Rows older code wrote naming this device as `this-device` are rewritten once per Pi
// to its machine's id, a session's own folder moved from the data directory to the work root where one rename can
// (decision 125).

import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { MACHINE_KIND } from "../environments/contract.ts";
import { OneThing, ThingsStore } from "../things/contract.server.ts";
import { SessionsStore } from "./contract.server.ts";
import { ModelChoice, type SessionState, ThinkingLevel } from "./contract.ts";
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
	// Version 2: a choice names a login, not a provider; a choice of version 1 reads as none (decisions 71, 124).
	model: json(union([ModelChoice, nul()]), { version: 2, migrate: () => null }),
};

/** A model choice as version 1 of the tables stored it (a provider, not a login): their history's, never read. */
export const ModelChoiceV1 = obj({ provider: str({ max: 200 }), model: str({ max: 200 }), thinking: ThinkingLevel });

/** Every session, one row each; by state for the waker. Version 1, as Pis deployed from 7093618af stored it. */
const RowsV1 = defineTable("sessions.sessions", {
	version: 1,
	columns: { ...ROW, model: json(union([ModelChoiceV1, nul()]), { version: 1 }) },
	key: ["id"],
	indexes: { working: ["state", "archivedAt"] },
});

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

/** Version 2: the model choice names a login (decision 124); stored data survives the update (decision 125). */
const Rows = evolveTable(RowsV1, (t) => t.json("model", ROW.model));

/** Serves `SessionsStore` on `host`. */
export function serveStore(host: FacetHost<P3Principal>): void {
	host.serve(SessionsStore, (_params, self) => {
		const rows = self.table(Rows);
		const rewrites = self.state(Rewrites);
		const things = self.get(ThingsStore, {});
		// This device's machine: where a session works unless it says otherwise.
		const device = self.get(OneThing, { kind: MACHINE_KIND });
		const runtime = self.registry(ServerRuntime);
		// Where this Pi's sessions get their own folders: `<work root>/<Pi's id>`, so Pis on one machine never share one
		// (deck2, p3-base). Pi stays, so its id is read once.
		let pi: Promise<string> | undefined;
		const ownFolders = async (ctx: Ctx<P3Principal>) => {
			pi ??= things.workspaces.children.page({ parent: "" }, 1, ctx).then(({ items }) => items[0]!.workspace);
			return join(runtime.value.workRoot, await pi);
		};
		// Once per Pi, once this device's machine was made: the rows that named this device by its old id name it now,
		// and a session's own folder moves to where new sessions get theirs (one read of every row, no index on
		// `environment`: it runs once, the marker says so after). The folders move outside a transaction: the rows are
		// written once every folder is where it stays.
		self.onLive(async (ctx) => {
			if (rewrites.value.thisDevice) return;
			const machine = await until(device.thing, (id) => id !== "", ctx);
			const old = query(Rows).where((s) => eq(s.environment, OLD_DEVICE));
			const found = await self.tx(async (tx) => {
				const all: { id: RowOf<typeof ROW>["id"]; folder: string }[] = [];
				for await (const row of tx.rows(rows, old)) all.push({ id: row.id, folder: row.folder });
				return all;
			}, ctx);
			const moved: typeof found = [];
			const folders = await ownFolders(ctx);
			for (const { id, folder } of found) {
				const session = id.params.id;
				const own = join(runtime.value.dataDir, "folders", session);
				// A location the person chose stays where it is.
				moved.push({ id, folder: folder === own ? await movedFolder(own, join(folders, session), ctx) : folder });
			}
			await self.tx(async (tx) => {
				for (const { id, folder } of moved) {
					// A session deleted while its folder moved stays deleted.
					if ((await tx.get(rows, { id })) !== undefined) {
						tx.update(rows, { id }, { environment: machine, folder });
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
		return {
			sessions: self.queries(
				rows,
				{ map: shown },
				{
					// The key.
					one: ({ id }: { id: string }) => query(Rows).where((s) => eq(s.id, Session({ id }))),
				},
			),
			insert: async ({ id, location, model }, ctx) => {
				// A session's own folder is outside the data directory (Files never shows that one).
				const where = location ?? {
					environment: await until(device.thing, (machine) => machine !== "", ctx),
					folder: join(await ownFolders(ctx), id),
				};
				if (location === undefined) {
					// An empty folder a failed commit leaves is harmless; a session without its folder is not.
					await mkdir(where.folder, { recursive: true, mode: 0o700 });
				} else {
					// A trust boundary: the make's input comes from a page. A location names a machine thing.
					const found = await things.things.one.page({ thing: location.environment }, 1, ctx);
					if (found.items[0]?.kind !== MACHINE_KIND) {
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
		};
	});
}

/**
 * Moves a session's own folder `from` to `to` with one atomic rename and answers where its files are now: `to` once
 * moved; `from` when `to` is taken or the rename is not possible (another file system, no permission): the folder stays
 * whole where it is and the row keeps its path, never a copy and a removal (Astra, round 6; decision 128), and the
 * failure is reported, since Files does not show the data directory; `to` when only `to` is there (a move a crash cut
 * short after the rename).
 */
async function movedFolder(from: string, to: string, context: Context): Promise<string> {
	const [source, target] = await Promise.all([present(from), present(to)]);
	if (target) return source ? from : to;
	if (!source) return from;
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
