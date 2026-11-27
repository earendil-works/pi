// The provider types' catalog runs (`login-catalogs.ts`), with types of a test plugin: every registered catalog runs
// from the start with its own provider's stored catalog, and ends when its contribution goes (a reload starts the new
// one; a contribution withdrawn starts none); a run that throws at once ends alone, the others run (Astra, round 1 of
// the catalog); a login's account is cut over its type's catalog, the stored models laid over the shipped ones (a
// model the account lacks is left out), and cut again when its type stores a new catalog, without a credential write
// (Astra and Opus, round 1).

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	BACKGROUND_CONTEXT as context,
	defineFacet,
	LoginProviders,
	type P3Principal,
	until,
} from "@earendil-works/p3/v1";
import { fauxProvider } from "@earendil-works/p3/v1/server";
import { eventually, within } from "../../../test/until.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import type { Source } from "../../things/contract.ts";
import type { World } from "../../things/test/world.ts";
import { CatalogStore } from "../contract.server.ts";
import { Login } from "../kind.ts";
import { type LoginCatalog, LoginCatalogs } from "../login-catalogs.ts";
import { makeLogin } from "../logins.ts";
import { providersWorld } from "./hosts.ts";

/** Who sets things up. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** The test type's runs: how many began and ended; when its catalog may be stored (`write`). */
let runs = { began: 0, ended: 0, write: Promise.resolve() as Promise<void> };

/** A catalog model `id` of the test type. */
const model = (id: string) => ({
	...fauxProvider({ provider: "cut", api: "cut", models: [{ id }] }).provider.getModels()[0]!,
});

/**
 * The test type's catalog, a new one for every contribution: once `runs.write` settles it stores one catalog
 * (`keep-new`, `drop-new`), then waits.
 */
const cutCatalog = (): LoginCatalog => ({
	provider: "cut",
	run: async ({ store, signal }) => {
		runs.began++;
		try {
			await runs.write;
			await store.write({ models: [model("keep-new"), model("drop-new")], lastModified: Date.now() }, Date.now());
			if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
		} finally {
			// However it ends: aborted while it waits, or its store refused once its run was stopped.
			runs.ended++;
		}
	},
});

/** A provider type `cut` whose accounts have only the models named `keep-…`, and its catalog (`catalogs`). */
function cutType(catalogs: () => readonly LoginCatalog[] = () => [cutCatalog()]) {
	return defineFacet((_host, self) => {
		const base = fauxProvider({ provider: "cut", api: "cut", models: [{ id: "keep-shipped" }] }).provider;
		self.contribute(LoginProviders, [
			{ ...base, filterModels: (models) => models.filter(({ id }) => id.startsWith("keep-")) },
		]);
		self.contribute(LoginCatalogs, catalogs());
	});
}

let w: World | undefined;

afterEach(async () => {
	await w?.close(context);
	w = undefined;
	runs = { began: 0, ended: 0, write: Promise.resolve() };
});

/** The test type's stored catalog, once there. */
async function storedCut(world: World) {
	const catalogs = await world.host.get(CatalogStore, {}, context);
	const rows = await eventually(
		async () => (await catalogs.catalogs.one.page({ provider: "cut" }, 1, context)).items,
		(found) => found.length > 0,
		5_000,
	);
	return rows[0]!.entry;
}

/** A Cut login in a session's workspace on `world`, and its catalog's model ids as the agent sees them once `done`. */
async function cutLogin(world: World) {
	const things = await world.host.get(ThingsStore, {}, context);
	const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	const workspace = await things.createWorkspace(
		{ kind: "things.workspace", name: "s1", parent: pi, by: BY },
		context,
	);
	await things.putParty({ workspace, party: { kind: "agent", session: "s1" }, source: BY }, context);
	const credential = { type: "api_key", key: "k" };
	const thing = await world.host.root(
		(ctx) => makeLogin({ name: "Cut", workspace, by: BY, provider: "cut", credential }, ctx),
		context,
	);
	const agent: P3Principal = { kind: "worker", session: "s1" };
	return (done: (ids: readonly string[]) => boolean) =>
		world.host.root(
			async (ctx) => {
				const login = await ctx.get(Login, { workspace, thing });
				const ids = (now: readonly unknown[]) => now.map((found) => (found as { id: string }).id).sort();
				const shown = await until(
					login.login,
					(now) => now !== null && done(ids(now.models)),
					within("the login's models", ctx),
				);
				return ids(shown!.models);
			},
			context,
			{ principal: agent },
		);
}

describe("the catalog runs", () => {
	it("run every registered catalog with its own entry; a reload starts it anew", async () => {
		w = await providersWorld(context, [{ name: "cut", facet: cutType() }]);
		assert.equal((await storedCut(w)).models.length, 2);
		const before = runs.began;
		await w.reload("cut", context);
		// The run before the reload ended, a new one runs.
		await eventually(
			async () => [runs.began, runs.ended],
			([began, ended]) => began === before + 1 && ended === before,
			5_000,
		);
	});

	it("end with their contribution withdrawn, and start no new one (Opus)", async () => {
		w = await providersWorld(context, [{ name: "cut", facet: cutType() }]);
		await storedCut(w);
		const before = runs.began;
		await w.reload(
			"cut",
			context,
			cutType(() => []),
		);
		await eventually(
			async () => runs.ended,
			(ended) => ended === before,
			5_000,
		);
		// An absence (testing.md 2): a run for the withdrawn contribution would start with the reload.
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(runs.began, before);
	});

	it("run on when another type's run throws at once (Astra)", async () => {
		const throwing: LoginCatalog = {
			provider: "boom",
			run: () => {
				throw new Error("at once");
			},
		};
		w = await providersWorld(context, [{ name: "cut", facet: cutType(() => [throwing, cutCatalog()]) }]);
		assert.equal((await storedCut(w)).models.length, 2);
	});
});

describe("a login's account", () => {
	it("is cut over its type's catalog: the stored models laid over the shipped ones, the account's only", async () => {
		w = await providersWorld(context, [{ name: "cut", facet: cutType() }]);
		await storedCut(w);
		const catalog = await cutLogin(w);
		assert.deepEqual(await catalog((ids) => ids.length > 0), ["keep-new", "keep-shipped"]);
	});

	it("is cut again when its type stores a new catalog, with no credential written (Astra, Opus)", async () => {
		const write = Promise.withResolvers<void>();
		runs.write = write.promise;
		w = await providersWorld(context, [{ name: "cut", facet: cutType() }]);
		const catalog = await cutLogin(w);
		assert.deepEqual(await catalog((ids) => ids.length > 0), ["keep-shipped"]);
		write.resolve();
		assert.deepEqual(await catalog((ids) => ids.includes("keep-new")), ["keep-new", "keep-shipped"]);
	});
});
