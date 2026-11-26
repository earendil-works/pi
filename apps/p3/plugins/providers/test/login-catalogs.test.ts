// The provider types' catalog runs (`login-catalogs.ts`), with a type of a test plugin: every registered catalog runs
// from the start with its own provider's stored entry and the server's network (none on a test host), and ends when
// its contribution goes (its plugin's reload starts the new one); a login's account is cut over its type's catalog,
// the stored models laid over the shipped ones (a model the account lacks is left out).

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
import { type CatalogContext, LoginCatalogs } from "../login-catalogs.ts";
import { makeLogin } from "../logins.ts";
import { providersWorld } from "./hosts.ts";

/** Who sets things up. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** The test type's runs: how many began and ended, and the network each got. */
const runs = { began: 0, ended: 0, networks: [] as CatalogContext["network"][] };

/** A catalog model `id` of the test type. */
const model = (id: string) => ({
	...fauxProvider({ provider: "cut", api: "cut", models: [{ id }] }).provider.getModels()[0]!,
});

/**
 * A provider type `cut` whose accounts have only the models named `keep-…`, and its catalog: it stores one catalog
 * (`keep-new`, `drop-new`) and waits for its end.
 */
const cutType = defineFacet((_host, self) => {
	const base = fauxProvider({ provider: "cut", api: "cut", models: [{ id: "keep-shipped" }] }).provider;
	self.contribute(LoginProviders, [
		{ ...base, filterModels: (models) => models.filter(({ id }) => id.startsWith("keep-")) },
	]);
	self.contribute(LoginCatalogs, [
		{
			provider: "cut",
			catalog: async ({ store, network, signal }) => {
				runs.began++;
				runs.networks.push(network);
				await store.write({
					models: [model("keep-new"), model("drop-new")],
					lastModified: Date.now(),
					checkedAt: Date.now(),
				});
				await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
				runs.ended++;
			},
		},
	]);
});

let w: World | undefined;

afterEach(async () => {
	await w?.close(context);
	w = undefined;
	runs.began = 0;
	runs.ended = 0;
	runs.networks = [];
});

/** The test type's stored entry, once there. */
async function storedCut(world: World) {
	const catalogs = await world.host.get(CatalogStore, {}, context);
	const rows = await eventually(
		async () => (await catalogs.catalogs.one.page({ provider: "cut" }, 1, context)).items,
		(found) => found.length > 0,
		5_000,
	);
	return rows[0]!.entry;
}

describe("the catalog runs", () => {
	it("run every registered catalog with its entry and no network on a test host; a reload starts it anew", async () => {
		w = await providersWorld(context, new Set(), [{ name: "cut", facet: cutType }]);
		assert.equal((await storedCut(w)).models.length, 2);
		assert.deepEqual(runs.networks, [undefined]);
		await w.reload("cut", context);
		await eventually(
			async () => [runs.began, runs.ended],
			([began, ended]) => began === 2 && ended === 1,
			5_000,
		);
	});
});

describe("a login's account", () => {
	it("is cut over its type's catalog: the stored models laid over the shipped ones, the account's only", async () => {
		w = await providersWorld(context, new Set(), [{ name: "cut", facet: cutType }]);
		await storedCut(w);
		const things = await w.host.get(ThingsStore, {}, context);
		const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
		const workspace = await things.createWorkspace(
			{ kind: "things.workspace", name: "s1", parent: pi, by: BY },
			context,
		);
		await things.putParty({ workspace, party: { kind: "agent", session: "s1" }, source: BY }, context);
		const credential = { type: "api_key", key: "k" };
		const thing = await w.host.root(
			(ctx) => makeLogin({ name: "Cut", workspace, by: BY, provider: "cut", credential }, ctx),
			context,
		);
		const agent: P3Principal = { kind: "worker", session: "s1" };
		const ids = await w.host.root(
			async (ctx) => {
				const login = await ctx.get(Login, { workspace, thing });
				const catalog = await until(login.catalog!, (now) => now.length > 0, within("the catalog", ctx));
				return catalog.map((found) => (found as { id: string }).id).sort();
			},
			context,
			{ principal: agent },
		);
		assert.deepEqual(ids, ["keep-new", "keep-shipped"]);
	});
});
