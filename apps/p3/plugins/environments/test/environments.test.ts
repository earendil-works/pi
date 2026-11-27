// The environments plugin: this device's machine is a thing made in Pi once, also after a restart (end to end); the
// machine kind lets people in with no tick and gives agents Work here, for agents only; `reachMachine` lets a person
// with any answer and an agent with Work here reach a machine's host, and refuses the others with their message;
// `Environments` is the owner's (plugin tier); on a worker the plugin contributes the machine kind's part, the one part
// that gives environments (plugin tier).

import assert from "node:assert/strict";
import { hostname } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	BACKGROUND_CONTEXT as context,
	Environments,
	isChordError,
	obj,
	type P3Principal,
	type Reference,
	str,
	ThisDevice,
	until,
} from "@earendil-works/p3/v1";
import { PeopleStore } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin, testServer } from "@earendil-works/p3/v1/testing";
import { collected, eventually, within } from "../../../test/until.ts";
import peopleServer from "../../people/server.ts";
import { OneThing, ThingsStore } from "../../things/contract.server.ts";
import type { Source } from "../../things/contract.ts";
import { ThingHarnessParts } from "../../things/contract.worker.ts";
import thingsServer from "../../things/server.ts";
import { MachineHosts, reachMachine } from "../contract.server.ts";
import { MACHINE_KIND } from "../contract.ts";
import { Machine, MachineKind } from "../kind.ts";
import { MachinesStore } from "../store.ts";
import { fakeMachine, fakeType } from "./fake-machine.ts";
import { seeded } from "./seeded.ts";

/** The plugin's directory. */
const PLUGIN = fileURLToPath(new URL("../", import.meta.url));

/** Who sets things up in the tests. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** What the test type's machines did: connections made and ended, by settings' host. */
const typeLog: string[] = [];

/** A machine type of the test's (`remote`), whose settings name a host. */
const remoteType = fakeType(
	(settings) => {
		const { host } = settings as { host: string };
		typeLog.push(`connect ${host}`);
		return { ...fakeMachine().host, close: async () => void typeLog.push(`close ${host}`) };
	},
	"remote",
	obj({ host: str() }),
);

/** What the server facet uses of other plugins. */
const STUBS = [
	{ name: "@earendil-works/p3-a-remote-type", facet: remoteType },
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
			assert.deepEqual(await listed(), [{ id: machine, name: hostname(), type: "local" }]);
			t = await first.restart(context);
			assert.equal(await device(), machine);
			assert.deepEqual(await listed(), [{ id: machine, name: hostname(), type: "local" }]);
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
		machine = await seeded(await t.host.get(OneThing, { kind: MachineKind.name }, context), context);
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
		const info = { name: hostname(), type: "local", status: "ready" };
		assert.deepEqual(await held(await person("Ann")), { granted: [], info });
		assert.deepEqual(await held({ kind: "worker", session: "s1" }), { granted: ["work"], info });
		const grant = { workspace: pi, thing: machine, party: { kind: "everyone" }, tick: "work", gives: true } as const;
		await assert.rejects(things.setGrants({ source: BY, grants: [grant] }, context), (error) =>
			isChordError(error, "invalid"),
		);
	});

	it("gives the owner no tick on it (Work here is the agents'), and lets them in (decision 99)", async () => {
		const id = await things.createPerson({ name: "Olga", madeBy: BY }, context);
		await things.setOwner({ person: id, owner: true }, context);
		const olga: P3Principal = { kind: "person", id, name: "Olga" };
		assert.deepEqual((await held(olga)).granted, []);
	});

	it("lets a Read share's guests in with no tick (decision 100)", () => {
		assert.deepEqual(MachineKind.info.defaultGrants.guests, []);
	});

	it("is made again with a new id when its last link goes: this device's machine again", async () => {
		await things.unlink({ workspace: pi, thing: machine }, context);
		const again = await t.host.get(OneThing, { kind: MachineKind.name }, context);
		const next = await until(again.thing, (id) => id !== "" && id !== machine, within("the new machine", context));
		machine = next;
		const info = { name: hostname(), type: "local", status: "ready" };
		assert.deepEqual(await held(await person("Ann")), { granted: [], info });
	});

	it("keeps no machine's info once every hold is released (guide 8.7)", async () => {
		const ann = await person("Ann");
		const info = await t.root(
			async (ctx) => {
				const ref = await ctx.get(Machine, { workspace: pi, thing: machine }, { readyTimeout: 500 });
				return new WeakRef(ref.info.value);
			},
			context,
			{ principal: ann },
		);
		assert.ok(await collected([info]));
	});

	it("reaches a machine's host for a person with an answer and an agent with Work here, else refuses", async () => {
		const hosts = (await t.host.registry(MachineHosts, context)).value;
		const local = await reachMachine(machine, { kind: "person", person: "p" }, { ticks: [] }, hosts, context);
		assert.equal(local.env.cwd.length > 0, true);
		assert.equal(
			await reachMachine(machine, { kind: "agent", session: "s" }, { ticks: ["work"] }, hosts, context),
			local,
		);
		assert.equal(await reachMachine(machine, { kind: "server" }, undefined, hosts, context), local);
		const refusals: [Parameters<typeof reachMachine>[1], { ticks: string[] } | undefined, string][] = [
			[{ kind: "person", person: "p" }, undefined, "notHere"],
			[{ kind: "agent", session: "s" }, { ticks: [] }, "noWork"],
		];
		for (const [caller, answer, key] of refusals) {
			await assert.rejects(
				reachMachine(machine, caller, answer, hosts, context),
				(error) => isChordError(error, "forbidden") && JSON.stringify(error.details).includes(`"${key}"`),
			);
		}
		await assert.rejects(
			reachMachine("elsewhere", { kind: "server" }, undefined, hosts, context),
			/not available here/,
		);
	});

	describe("a family of types (decision 117)", () => {
		/** Makes a machine from `input` in Pi, as a plugin does; its id. */
		const make = (input: unknown) =>
			things.create({ kind: MACHINE_KIND, name: "box", workspace: pi, by: BY, input }, context);

		it("makes a machine of a type with checked settings, connects it once and ends it with the machine", async () => {
			typeLog.length = 0;
			const box = await make({ type: "remote", settings: { host: "box.lan" } });
			const hosts = (await t.host.registry(MachineHosts, context)).value;
			const first = await hosts(box, context);
			assert.equal(await hosts(box, context), first, "one connection");
			const info = await t.root(async (ctx) => {
				const ref = await ctx.get(Machine, { workspace: pi, thing: box });
				return until(ref.info, (value) => value.type === "remote", within("its info", ctx));
			}, context);
			assert.deepEqual(info, { name: "box", type: "remote", status: "ready" });
			await things.unlink({ workspace: pi, thing: box }, context);
			// The delete hook runs after the commit that removed the machine.
			await eventually(
				() => [...typeLog],
				(log) => log.includes("close box.lan"),
				2000,
			);
			assert.deepEqual(typeLog, ["connect box.lan", "close box.lan"]);
			assert.equal(await hosts(box, context), undefined);
		});

		it("refuses a type that is not installed, settings that do not fit, and no input", async () => {
			const refusedWith = (input: unknown, key: string) =>
				assert.rejects(
					make(input),
					(error) => isChordError(error, "invalid") && JSON.stringify(error.details).includes(`"${key}"`),
				);
			await refusedWith({ type: "ssh", settings: {} }, "noType");
			await refusedWith({ type: "remote", settings: { port: 22 } }, "badSettings");
			// The store checks the input's shape (the kind's `create.input`) before the hook.
			await assert.rejects(make(undefined), (error) => isChordError(error, "invalid"));
		});

		it("keeps a machine whose type is gone, unavailable", async () => {
			const box = await make({ type: "remote", settings: { host: "box.lan" } });
			await (await t.host.get(MachinesStore, {}, context)).put(
				{ machine: box, type: "gone", settings: {} },
				context,
			);
			const hosts = (await t.host.registry(MachineHosts, context)).value;
			assert.equal(await hosts(box, context), undefined);
			const info = await t.root(
				async (ctx) => (await ctx.get(Machine, { workspace: pi, thing: box })).info.value,
				context,
			);
			assert.deepEqual(info, { name: "box", type: "gone", status: "unavailable" });
		});
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
	it("contributes the machine kind's part, its one part (round 1, must 3)", async () => {
		const t = await testPlugin(PLUGIN, { kind: "worker", session: "s1" }, context);
		try {
			const parts = t.contributions(ThingHarnessParts);
			assert.deepEqual(
				parts.map(({ value }) => value.kind.name),
				[MachineKind.name],
			);
		} finally {
			await t.close(context);
		}
	});
});
