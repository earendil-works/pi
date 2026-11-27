// The backup plugin on the server (plugin tier; restart and reload are in `e2e.test.ts`).
// - The owner sets the default and each session's own choice, and a session's worker sees the result; a worker's
//   reported state is stored only when it changes; the owner sees the counts by state and the sessions in one state;
//   only the owner may use `Backups` and `BackupsList`, and only a session's worker `SessionBackup`.
// - A store version 1 wrote (596540d43) opened by this version (decision 125): the choices stay, a session has no
//   state until it reports one, a state reported now is there after the next start. A two-version restart is not
//   possible in-tree: a stand-in of the older plugin writes the old rows.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	BACKGROUND_CONTEXT as context,
	createHost,
	defineFacet,
	defineTable,
	host as hostColumn,
	isChordError,
	local,
	method,
	obj,
	openStore,
	type P3Principal,
	type Reference,
	Server,
	Session,
	sqliteBackend,
	str,
} from "@earendil-works/p3/v1";
import {
	type ServerRuntime,
	ServerRuntime as ServerRuntimeRegistry,
	WorkerRunners,
} from "@earendil-works/p3/v1/server";
import { testPlugin } from "@earendil-works/p3/v1/testing";
import environmentsServer from "../../environments/server.ts";
import { SessionKind } from "../../sessions/kind.ts";
import sessionsServer from "../../sessions/server.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import { make } from "../../things/kind-server.ts";
import thingsServer from "../../things/server.ts";
import { world } from "../../things/test/world.ts";
import {
	type BackupStatus,
	Backups,
	BackupsList,
	type Counts,
	SessionBackup,
	type SessionBackupRow,
} from "../contract.ts";
import backupServer from "../server.ts";
import { BackupStore } from "../store.ts";

/** The plugin's directory. */
const PLUGIN = fileURLToPath(new URL("../", import.meta.url));

/** A session's worker. */
const WORKER: P3Principal = { kind: "worker", session: "s1" };

/**
 * The plugin's server facet, with the things plugin (who the owner is; which sessions exist: session workspaces), the
 * sessions plugin and the environments plugin (where a new session works); `test` gets the owner
 * and the ids of two new sessions.
 */
async function withServerFacet(
	test: (t: Awaited<ReturnType<typeof testPlugin>>, owner: P3Principal, sessions: [string, string]) => Promise<void>,
): Promise<void> {
	const stubs = [
		{ name: "@earendil-works/p3-things", facet: thingsServer },
		{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
		{ name: "@earendil-works/p3-environments", facet: environmentsServer },
	];
	const t = await testPlugin(PLUGIN, { kind: "server", stubs }, context);
	try {
		const [person] = await t.root(
			async (ctx) => (await (await ctx.get(ThingsStore, {})).persons.owners.page({}, 1, ctx)).items,
			context,
		);
		// Sessions are workspaces in Pi, made as server code does (no Make tick checked).
		const create = (title: string) =>
			t.root(async (ctx) => {
				const things = await ctx.get(ThingsStore, {});
				const [pi] = (await things.workspaces.children.page({ parent: "" }, 1, ctx)).items;
				const by = { kind: "plugin", plugin: "test" } as const;
				return make(SessionKind, { name: title, workspace: pi!.workspace, by, input: {} }, ctx);
			}, context);
		const sessions: [string, string] = [await create("one"), await create("two")];
		await test(t, { kind: "person", id: person!.person, name: person!.name }, sessions);
	} finally {
		await t.close(context);
	}
}

describe("the default", () => {
	it("starts off; once the owner turns it on, a session's worker sees it", async () => {
		await withServerFacet(async (t, owner) => {
			const before = await t.root(async (ctx) => (await ctx.get(SessionBackup, {})).enabled.value, context, {
				principal: WORKER,
			});
			assert.equal(before, false);
			await t.root(
				async (ctx) => {
					const backups = await ctx.get(Backups, {});
					assert.equal(backups.defaultEnabled.value, false);
					await backups.setDefault(true, ctx);
					assert.equal(backups.defaultEnabled.value, true);
				},
				context,
				{ principal: owner },
			);
			const after = await t.root(async (ctx) => (await ctx.get(SessionBackup, {})).enabled.value, context, {
				principal: WORKER,
			});
			assert.equal(after, true);
		});
	});
});

/** Whether session `session`'s worker is told to back up its store. */
async function enabledFor(t: Awaited<ReturnType<typeof testPlugin>>, session: string): Promise<boolean> {
	return t.root(async (ctx) => (await ctx.get(SessionBackup, {})).enabled.value, context, {
		principal: { kind: "worker", session },
	});
}

describe("a session's own choice", () => {
	it("wins over the default, and stays when the default is turned off and on again", async () => {
		await withServerFacet(async (t, owner, [s1, s2]) => {
			await t.root(
				async (ctx) => {
					const backups = await ctx.get(Backups, {});
					await backups.setDefault(true, ctx);
					await backups.setSession({ session: s1, enabled: false }, ctx);
				},
				context,
				{ principal: owner },
			);
			assert.equal(await enabledFor(t, s1), false);
			assert.equal(await enabledFor(t, s2), true);
			await t.root(
				async (ctx) => {
					const backups = await ctx.get(Backups, {});
					await backups.setDefault(false, ctx);
					await backups.setDefault(true, ctx);
				},
				context,
				{ principal: owner },
			);
			assert.equal(await enabledFor(t, s1), false);
			assert.equal(await enabledFor(t, s2), true);
		});
	});

	it("backs up only the sessions turned on while the default is off, until they follow it again", async () => {
		await withServerFacet(async (t, owner, [s1, s2]) => {
			const setSession = (session: string, enabled: boolean | null) =>
				t.root(async (ctx) => (await ctx.get(Backups, {})).setSession({ session, enabled }, ctx), context, {
					principal: owner,
				});
			await setSession(s2, true);
			assert.equal(await enabledFor(t, s1), false);
			assert.equal(await enabledFor(t, s2), true);
			await setSession(s2, null);
			assert.equal(await enabledFor(t, s2), false);
		});
	});

	it("refuses a choice for a session that does not exist", async () => {
		await withServerFacet(async (t, owner) => {
			await assert.rejects(
				t.root(
					async (ctx) => (await ctx.get(Backups, {})).setSession({ session: "nope", enabled: true }, ctx),
					context,
					{ principal: owner },
				),
				(error) => isChordError(error, "invalid"),
			);
		});
	});
});

/** What session `session`'s worker reports. */
async function report(t: Awaited<ReturnType<typeof testPlugin>>, session: string, status: BackupStatus): Promise<void> {
	await t.root(async (ctx) => (await ctx.get(SessionBackup, {})).report({ status }, ctx), context, {
		principal: { kind: "worker", session },
	});
}

/** Session `session`'s stored state, if it reported one. */
async function stateOf(
	t: Awaited<ReturnType<typeof testPlugin>>,
	session: string,
): Promise<SessionBackupRow | undefined> {
	const { items } = await t.root(
		async (ctx) => (await ctx.get(BackupStore, {})).states.one.page({ session }, 1, ctx),
		context,
	);
	return items[0];
}

describe("a session's reported state", () => {
	it("is stored when it changes, and not when only the upload moves on", async () => {
		await withServerFacet(async (t, _owner, [s1]) => {
			assert.equal(await stateOf(t, s1), undefined);
			await report(t, s1, { state: { kind: "uploading" }, at: 1 });
			// `uploading` is never stored.
			assert.equal(await stateOf(t, s1), undefined);
			await report(t, s1, { state: { kind: "synced" }, syncedHead: 3, at: 2 });
			assert.deepEqual(await stateOf(t, s1), { session: s1, state: { kind: "synced" }, since: 2 });
			// The same state again: `since` stays, nothing is written.
			await report(t, s1, { state: { kind: "synced" }, syncedHead: 7, at: 5 });
			assert.deepEqual(await stateOf(t, s1), { session: s1, state: { kind: "synced" }, since: 2 });
			await report(t, s1, { state: { kind: "stopped", reason: "diverged", error: "head moved" }, at: 9 });
			assert.deepEqual(await stateOf(t, s1), {
				session: s1,
				state: { kind: "stopped", reason: "diverged", error: "head moved" },
				since: 9,
			});
		});
	});

	it("and the session's own choice share a row: setting one keeps the other", async () => {
		await withServerFacet(async (t, owner, [s1]) => {
			const setSession = (enabled: boolean | null) =>
				t.root(async (ctx) => (await ctx.get(Backups, {})).setSession({ session: s1, enabled }, ctx), context, {
					principal: owner,
				});
			await setSession(true);
			await report(t, s1, { state: { kind: "retrying", error: "offline" }, at: 4 });
			assert.equal(await enabledFor(t, s1), true);
			await setSession(null);
			assert.deepEqual(await stateOf(t, s1), {
				session: s1,
				state: { kind: "retrying", error: "offline" },
				since: 4,
			});
			assert.equal(await enabledFor(t, s1), false);
		});
	});
});

/** What the owner sees: how many sessions are in each state, and the sessions in state `state`, in order. */
async function ownerSees(
	t: Awaited<ReturnType<typeof testPlugin>>,
	owner: P3Principal,
	state: "synced" | "retrying" | "paused" | "stopped",
): Promise<{ counts: Counts; sessions: string[] }> {
	return t.root(
		async (ctx) => {
			const counts = (await ctx.get(Backups, {})).counts.value;
			const { rows } = (await ctx.get(BackupsList, { view: "test", state })).list.value;
			return { counts, sessions: rows.map((row) => row.session) };
		},
		context,
		{ principal: owner },
	);
}

describe("the owner's overview", () => {
	it("counts the sessions in each state, moving a session when its state changes", async () => {
		await withServerFacet(async (t, owner, [s1, s2]) => {
			await report(t, s1, { state: { kind: "synced" }, at: 1 });
			await report(t, s2, { state: { kind: "retrying", error: "offline" }, at: 2 });
			assert.deepEqual((await ownerSees(t, owner, "synced")).counts, {
				synced: 1,
				retrying: 1,
				paused: 0,
				stopped: 0,
			});
			await report(t, s1, { state: { kind: "stopped", reason: "diverged", error: "head moved" }, at: 3 });
			// The same state with another reason: the counts stay.
			await report(t, s1, { state: { kind: "stopped", reason: "refused", error: "too large" }, at: 4 });
			assert.deepEqual((await ownerSees(t, owner, "synced")).counts, {
				synced: 0,
				retrying: 1,
				paused: 0,
				stopped: 1,
			});
		});
	});

	it("lists the sessions in one state, the longest in it first", async () => {
		await withServerFacet(async (t, owner, [s1, s2]) => {
			await report(t, s1, { state: { kind: "retrying", error: "offline" }, at: 5 });
			await report(t, s2, { state: { kind: "retrying", error: "offline" }, at: 3 });
			assert.deepEqual((await ownerSees(t, owner, "retrying")).sessions, [s2, s1]);
			assert.deepEqual((await ownerSees(t, owner, "synced")).sessions, []);
			await report(t, s2, { state: { kind: "synced" }, at: 6 });
			assert.deepEqual((await ownerSees(t, owner, "retrying")).sessions, [s1]);
			assert.deepEqual((await ownerSees(t, owner, "synced")).sessions, [s2]);
		});
	});
});

describe("who may use what", () => {
	it("gives Backups and BackupsList to the owner only", async () => {
		await withServerFacet(async (t) => {
			for (const principal of [{ kind: "person", id: "p", name: "P" }, WORKER] satisfies P3Principal[]) {
				await assert.rejects(
					t.root(async (ctx) => ctx.get(Backups, {}, { readyTimeout: 500 }), context, { principal }),
					(error) => isChordError(error, "forbidden"),
				);
				await assert.rejects(
					t.root(
						async (ctx) => ctx.get(BackupsList, { view: "test", state: "synced" }, { readyTimeout: 500 }),
						context,
						{ principal },
					),
					(error) => isChordError(error, "forbidden"),
				);
			}
		});
	});

	it("gives SessionBackup to a session's worker only", async () => {
		await withServerFacet(async (t, owner) => {
			await assert.rejects(
				t.root(async (ctx) => ctx.get(SessionBackup, {}, { readyTimeout: 500 }), context, { principal: owner }),
				(error) => isChordError(error, "forbidden"),
			);
		});
	});
});

/** The sessions' table as version 1 defined it (596540d43): a session's own choice, `on` or `off`. */
const SessionsV1 = defineTable("backup.sessions", {
	version: 1,
	columns: { session: hostColumn(Session), choice: str() },
	key: ["session"],
});

/** The stand-in of version 1's store: one write of a session's own choice. */
const StoreV1 = local("backup.store", {
	version: 1,
	params: {},
	members: { setSession: method(obj({ session: str(), choice: str() })) },
});

describe("a store version 1 wrote (decision 125)", () => {
	// A store of 596540d43 was refused: version 1 had been edited in place (p3-base, 2026-11-27).
	it("opens: the choices stay, no state until a report; a state reported now is there after the next start", async () => {
		const dir = await mkdtemp(join(tmpdir(), "p3-backup-v1-"));
		try {
			const path = join(dir, "v1.sqlite");
			const old = await openStore(sqliteBackend(await openNodeSqliteDatabase(path)), context);
			const host = createHost<P3Principal>({
				address: Server(),
				principal: { kind: "server" },
				store: old,
				onError: (error) => assert.fail(error.kind),
			});
			const v1 = defineFacet((facetHost) =>
				facetHost.serve(StoreV1, (_params, self) => {
					const rows = self.table(SessionsV1);
					return {
						setSession: ({ session, choice }, ctx) =>
							self.tx(async (tx) => {
								tx.put(rows, { session: Session({ id: session }), choice });
								return null;
							}, ctx),
					};
				}),
			);
			await host.load([{ name: "@earendil-works/p3-backup", facet: v1 }], context);
			const store = await host.get(StoreV1, {}, context);
			await store.setSession({ session: "s1", choice: "on" }, context);
			await store.setSession({ session: "s2", choice: "off" }, context);
			await host.close(context);
			await old.close(context);
			const retrying = { session: "s1", state: { kind: "retrying", error: "offline" }, since: 4 } as const;
			for (let start = 0; start < 2; start++) {
				await opened(dir, path, async (backup) => {
					const choice = async (session: string) =>
						(await backup.choices.one.page({ session }, 1, context)).items[0]?.choice;
					assert.deepEqual([await choice("s1"), await choice("s2")], ["on", "off"]);
					const state = (await backup.states.one.page({ session: "s1" }, 1, context)).items[0];
					if (start === 0) {
						assert.equal(state, undefined);
						await backup.report({ session: "s1", status: { state: retrying.state, at: 4 } }, context);
					} else assert.deepEqual(state, retrying);
					const inState = await backup.states.inState.page({ state: "retrying" }, 10, context);
					assert.deepEqual(inState.items, [retrying]);
				});
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

/** Runs `fn` on this version's backup store over the store file at `path` (`dir` its data dir), nothing reported. */
async function opened(
	dir: string,
	path: string,
	fn: (backup: Reference<typeof BackupStore>) => Promise<void>,
): Promise<void> {
	const runtime = { dataDir: dir, workRoot: join(dir, "work"), machine: { user: "test", hostname: "test" } };
	const now = await world(
		context,
		[
			{
				name: "p3.server",
				facet: defineFacet((facetHost) => {
					// The sessions plugin reads its data dir, work root and machine only.
					facetHost.serve(ServerRuntimeRegistry, { compose: () => runtime as ServerRuntime });
					facetHost.serve(WorkerRunners, { compose: () => undefined });
				}),
			},
			{ name: "@earendil-works/p3-environments", facet: environmentsServer },
			{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
			{ name: "@earendil-works/p3-backup", facet: backupServer },
		],
		path,
	);
	try {
		await fn(await now.host.get(BackupStore, {}, context));
		assert.deepEqual(now.errors, []);
	} finally {
		await now.close(context);
	}
}
