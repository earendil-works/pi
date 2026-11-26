// The environments plugin: this device's machine is a thing made in Pi once, also after a restart (end to end); the
// machine kind lets people in with no tick and gives agents Work here, for agents only; `reachMachine` lets a person
// with any answer and an agent with Work here reach a machine's host, and refuses the others with their message;
// `Environments` is the owner's (plugin tier); on a worker, `ExecutionEnvironments` gives a location on this device's
// machine a Node environment in its folder and nothing for another machine (plugin tier, a stand-in server).

import assert from "node:assert/strict";
import { hostname, tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	constant,
	BACKGROUND_CONTEXT as context,
	defineFacet,
	Environments,
	isChordError,
	type P3Principal,
	type Reference,
	ThisDevice,
	until,
} from "@earendil-works/p3/v1";
import { PeopleStore } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin, testServer } from "@earendil-works/p3/v1/testing";
import { ExecutionEnvironments } from "@earendil-works/p3/v1/worker";
import { within } from "../../../test/until.ts";
import peopleServer from "../../people/server.ts";
import { OneThing, ThingsStore } from "../../things/contract.server.ts";
import type { Source } from "../../things/contract.ts";
import thingsServer from "../../things/server.ts";
import { MachineHosts, reachMachine } from "../contract.server.ts";
import { Machine, MachineKind } from "../kind.ts";

/** The plugin's directory. */
const PLUGIN = fileURLToPath(new URL("../", import.meta.url));

/** Who sets things up in the tests. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** What the server facet uses of other plugins. */
const STUBS = [
	{ name: "@earendil-works/p3-people", facet: peopleServer },
	{ name: "@earendil-works/p3-things", facet: thingsServer },
];

describe("this device's machine", () => {
	it("exists after the first start, in Pi, and is the same one after a restart", async () => {
		const first = await testServer({}, context);
		let t = first;
		try {
			const listed = async () => (await (await t.client(context)).get(Environments, {}, context)).environments.value;
			const device = async () => (await (await t.client(context)).get(ThisDevice, {}, context)).machine.value;
			const machine = await device();
			assert.deepEqual(await listed(), [{ id: machine, name: hostname(), kind: "local" }]);
			t = await first.restart(context);
			assert.equal(await device(), machine);
			assert.deepEqual(await listed(), [{ id: machine, name: hostname(), kind: "local" }]);
		} finally {
			await t.close(context);
		}
	});
});

describe("the environments plugin on the server", () => {
	let t: TestedPlugin<P3Principal>;
	let things: Reference<typeof ThingsStore>;
	let pi: string;
	let machine: string;

	beforeEach(async () => {
		t = await testPlugin(PLUGIN, { kind: "server", stubs: STUBS }, context);
		things = await t.host.get(ThingsStore, {}, context);
		pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
		machine = (await t.host.get(OneThing, { kind: MachineKind.name }, context)).thing.value;
	});

	afterEach(() => t.close(context));

	/** Makes person `name`, put into Pi; their principal. */
	async function person(name: string): Promise<P3Principal> {
		const id = await things.createPerson({ name, madeBy: BY }, context);
		await things.putParty({ workspace: pi, party: { kind: "person", person: id }, source: BY }, context);
		return { kind: "person", id, name };
	}

	/** What `principal` is granted on this device's machine in Pi, and its info. */
	const held = (principal: P3Principal) =>
		t.root(
			async (ctx) => {
				const ref = await ctx.get(Machine, { workspace: pi, thing: machine }, { readyTimeout: 500 });
				return { granted: [...ref.granted], info: ref.info.value };
			},
			context,
			{ principal },
		);

	it("lets a person in with no tick and gives the agents Work here; never a person", async () => {
		await things.putParty({ workspace: pi, party: { kind: "agent", session: "s1" }, source: BY }, context);
		const info = { name: hostname(), kind: "local" };
		assert.deepEqual(await held(await person("Ann")), { granted: [], info });
		assert.deepEqual(await held({ kind: "worker", session: "s1" }), { granted: ["work"], info });
		const grant = { workspace: pi, thing: machine, party: { kind: "everyone" }, tick: "work", gives: true } as const;
		await assert.rejects(things.setGrants({ source: BY, grants: [grant] }, context), (error) =>
			isChordError(error, "invalid"),
		);
	});

	it("reaches a machine's host for a person with an answer and an agent with Work here, else refuses", async () => {
		const hosts = (await t.host.registry(MachineHosts, context)).value;
		const local = reachMachine(machine, { kind: "person", person: "p" }, { ticks: [] }, hosts);
		assert.equal(local.env.cwd.length > 0, true);
		assert.equal(reachMachine(machine, { kind: "agent", session: "s" }, { ticks: ["work"] }, hosts), local);
		assert.equal(reachMachine(machine, { kind: "server" }, undefined, hosts), local);
		const refusals: [Parameters<typeof reachMachine>[1], { ticks: string[] } | undefined, string][] = [
			[{ kind: "person", person: "p" }, undefined, "notHere"],
			[{ kind: "agent", session: "s" }, { ticks: [] }, "noWork"],
		];
		for (const [caller, answer, key] of refusals) {
			assert.throws(
				() => reachMachine(machine, caller, answer, hosts),
				(error) => isChordError(error, "forbidden") && JSON.stringify(error.details).includes(`"${key}"`),
			);
		}
		assert.throws(() => reachMachine("elsewhere", { kind: "server" }, undefined, hosts), /not available here/);
	});

	it("gives the owner the machines, and nobody else", async () => {
		const [owner] = await t.root(
			async (ctx) => (await (await ctx.get(PeopleStore, {})).persons.owner.page({}, 1, ctx)).items,
			context,
		);
		const ids = await t.root(
			async (ctx) => (await ctx.get(Environments, {})).environments.value.map(({ id }) => id),
			context,
			{ principal: { kind: "person", id: owner!.id, name: owner!.name } },
		);
		assert.deepEqual(ids, [machine]);
		for (const principal of [
			{ kind: "person", id: "p", name: "P" },
			{ kind: "worker", session: "s" },
		] satisfies P3Principal[]) {
			await assert.rejects(
				t.root(async (ctx) => ctx.get(Environments, {}, { readyTimeout: 500 }), context, { principal }),
				(error) => isChordError(error, "forbidden"),
			);
		}
	});
});

describe("the environments plugin on a worker", () => {
	it("resolves a location on this device's machine to its folder, and no other machine", async () => {
		const server = defineFacet((host) => host.serve(ThisDevice, () => ({ machine: constant("m1") })));
		const t = await testPlugin(
			PLUGIN,
			{ kind: "worker", session: "s1", server: [{ name: "stand-in", facet: server }] },
			context,
		);
		try {
			const here = { environment: "m1", folder: tmpdir() };
			// The resolver is contributed once the server answered.
			const resolve = await until(
				await t.host.registry(ExecutionEnvironments, context),
				(composed) => composed(here, context) !== undefined,
				within("this device's resolver", context),
			);
			const env = resolve(here, context);
			assert.equal(env?.cwd, tmpdir());
			assert.equal(resolve({ environment: "elsewhere", folder: "/" }, context), undefined);
		} finally {
			await t.close(context);
		}
	});
});
