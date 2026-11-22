// The environments plugin: this device exists from the first start on, once, also after a restart (end to end);
// `Environments` is the owner's (plugin tier); on a worker, `ExecutionEnvironments` gives a location on this device a
// Node environment in its folder and nothing for another environment (plugin tier).

import assert from "node:assert/strict";
import { hostname, tmpdir } from "node:os";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BACKGROUND_CONTEXT as context,
	Environments,
	isChordError,
	type P3Principal,
	THIS_DEVICE,
} from "@earendil-works/p3/v1";
import { PeopleStore } from "@earendil-works/p3/v1/server";
import { testPlugin, testServer } from "@earendil-works/p3/v1/testing";
import { ExecutionEnvironments } from "@earendil-works/p3/v1/worker";
import peopleServer from "../../people/server.ts";

/** The plugin's directory. */
const PLUGIN = fileURLToPath(new URL("../", import.meta.url));

describe("this device", () => {
	it("exists after the first start, and once only after a restart", async () => {
		const first = await testServer({}, context);
		let t = first;
		try {
			const listed = async () => (await (await t.client(context)).get(Environments, {}, context)).environments.value;
			const expected = [{ id: THIS_DEVICE, name: hostname(), kind: "local" }];
			assert.deepEqual(await listed(), expected);
			t = await first.restart(context);
			assert.deepEqual(await listed(), expected);
		} finally {
			await t.close(context);
		}
	});
});

describe("the environments plugin's facets", () => {
	it("gives the owner the environments, and nobody else", async () => {
		// The people plugin answers who the owner is.
		const stubs = [{ name: "@earendil-works/p3-people", facet: peopleServer }];
		const t = await testPlugin(PLUGIN, { kind: "server", stubs }, context);
		try {
			const [owner] = await t.root(
				async (ctx) => (await (await ctx.get(PeopleStore, {})).persons.owner.page({}, 1, ctx)).items,
				context,
			);
			const ids = await t.root(
				async (ctx) => (await ctx.get(Environments, {})).environments.value.map(({ id }) => id),
				context,
				{ principal: { kind: "person", id: owner!.id, name: owner!.name } },
			);
			assert.deepEqual(ids, [THIS_DEVICE]);
			for (const principal of [
				{ kind: "person", id: "p", name: "P" },
				{ kind: "worker", session: "s" },
			] satisfies P3Principal[]) {
				await assert.rejects(
					t.root(async (ctx) => ctx.get(Environments, {}, { readyTimeout: 500 }), context, { principal }),
					(error) => isChordError(error, "forbidden"),
				);
			}
		} finally {
			await t.close(context);
		}
	});

	it("resolves a location on this device to its folder on a worker, and no other environment", async () => {
		const t = await testPlugin(PLUGIN, { kind: "worker", session: "s1" }, context);
		try {
			const resolve = (await t.host.registry(ExecutionEnvironments, context)).value;
			const env = resolve({ environment: THIS_DEVICE, folder: tmpdir() }, context);
			assert.equal(env?.cwd, tmpdir());
			assert.equal(resolve({ environment: "elsewhere", folder: "/" }, context), undefined);
		} finally {
			await t.close(context);
		}
	});
});
