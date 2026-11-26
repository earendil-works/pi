// The backup plugin on the server: the owner sets whether sessions are backed up by default and each session's own
// choice, and a session's worker sees the result for its session (plugin tier); only the owner may use `Backups`, and only a session's worker `SessionBackup` (plugin tier);
// the default is stored, so it survives a restart and a reload of the plugin while the owner holds `Backups` (end to
// end).

import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, isChordError, type P3Principal, until } from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { testPlugin, testServer } from "@earendil-works/p3/v1/testing";
import { within } from "../../../test/until.ts";
import appsServer from "../../apps/server.ts";
import codingServer from "../../coding/server.ts";
import environmentsServer from "../../environments/server.ts";
import peopleServer from "../../people/server.ts";
import sessionsServer from "../../sessions/server.ts";
import { Backups, SessionBackup } from "../contract.ts";

/** The plugin's directory. */
const PLUGIN = fileURLToPath(new URL("../", import.meta.url));

/** A session's worker. */
const WORKER: P3Principal = { kind: "worker", session: "s1" };

/**
 * The plugin's server facet, with the people plugin (who the owner is), the sessions plugin (which sessions exist),
 * the environments plugin (where a new session works), and the apps plugin's `Apps` registry with the coding app in it
 * (the sessions plugin's store makes a session only of an app `Apps` has); `test` gets the owner and the ids of two
 * new sessions.
 */
async function withServerFacet(
	test: (t: Awaited<ReturnType<typeof testPlugin>>, owner: P3Principal, sessions: [string, string]) => Promise<void>,
): Promise<void> {
	const stubs = [
		{ name: "@earendil-works/p3-people", facet: peopleServer },
		{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
		{ name: "@earendil-works/p3-environments", facet: environmentsServer },
		{ name: "@earendil-works/p3-apps", facet: appsServer },
		{ name: "@earendil-works/p3-coding", facet: codingServer },
	];
	const t = await testPlugin(PLUGIN, { kind: "server", stubs }, context);
	try {
		const [person] = await t.root(
			async (ctx) => (await (await ctx.get(PeopleStore, {})).persons.owner.page({}, 1, ctx)).items,
			context,
		);
		const create = (title: string) =>
			t.root(async (ctx) => (await ctx.get(SessionsStore, {})).create({ app: "coding", title }, ctx), context);
		const sessions: [string, string] = [await create("one"), await create("two")];
		await test(t, { kind: "person", id: person!.id, name: person!.name }, sessions);
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

	it("is kept across a restart", async () => {
		const first = await testServer({}, context);
		let t = first;
		try {
			const backups = async () => (await t.client(context)).get(Backups, {}, context);
			await (await backups()).setDefault(true, context);
			t = await first.restart(context);
			assert.equal((await backups()).defaultEnabled.value, true);
		} finally {
			await t.close(context);
		}
	});

	it("is kept through a reload of the plugin while the owner holds it", async () => {
		// A copy of the built-in plugins, so the test can edit the backup plugin as a person would.
		const dir = await mkdtemp(join(tmpdir(), "p3-backup-reload-"));
		const builtIn = join(dir, "built-in");
		await cp(fileURLToPath(new URL("../../", import.meta.url)), builtIn, { recursive: true });
		const t = await testServer({ builtIn }, context);
		try {
			const backups = await (await t.client(context)).get(Backups, {}, context);
			await backups.setDefault(true, context);
			const file = join(builtIn, "backup", "server.ts");
			await writeFile(file, `${await readFile(file, "utf8")}\n// edited\n`);
			await until(t.plugins, (marks) => marks.dirty.length > 0, within("the watcher's marks", context, 10_000));
			await t.apply(context);
			await until(backups.state, (state) => state.kind === "live", within("Backups live again", context));
			assert.equal(backups.defaultEnabled.value, true);
			// It still works after the reload.
			await backups.setDefault(false, context);
			assert.equal(backups.defaultEnabled.value, false);
			assert.deepEqual(t.errors, []);
		} finally {
			await t.close(context);
			await rm(dir, { recursive: true, force: true });
		}
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

describe("who may use what", () => {
	it("gives Backups to the owner only", async () => {
		await withServerFacet(async (t) => {
			for (const principal of [{ kind: "person", id: "p", name: "P" }, WORKER] satisfies P3Principal[]) {
				await assert.rejects(
					t.root(async (ctx) => ctx.get(Backups, {}, { readyTimeout: 500 }), context, { principal }),
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
