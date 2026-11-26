// The store's writes (`ThingsStore`): `create` is one commit (the thing, its link, the kind's default grants, every
// tick for its maker) followed by the kind's `create` hook, whose throw deletes the thing again; a thing goes with its
// last link and its kind's `delete` hook runs; a kind of one workspace is linked once; `ensure` makes a plugin's one
// thing once; Pi exists from the start; `deleteEverythingFrom` takes a source's rows and the groups it manages.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, type Reference } from "@earendil-works/p3/v1";
import { eventually } from "../../../test/until.ts";
import { ThingsStore } from "../contract.server.ts";
import type { Source } from "../contract.ts";
import { BOARD_PLUGIN, Board, FAIL, HOOKS } from "./kinds.ts";
import { type World, world } from "./world.ts";

const BY: Source = { kind: "plugin", plugin: "test" };

let w: World;
let store: Reference<typeof ThingsStore>;
let pi: string;

beforeEach(async () => {
	w = await world(context);
	store = await w.host.get(ThingsStore, {}, context);
	pi = (await store.workspaces.children.page({ parent: "" }, 10, context)).items[0]!.workspace;
	HOOKS.length = 0;
	FAIL.create = false;
});

afterEach(() => w.close(context));

describe("the tree", () => {
	it("starts with Pi, the one root; a workspace's path is its parent's and itself", async () => {
		const roots = (await store.workspaces.children.page({ parent: "" }, 10, context)).items;
		assert.deepEqual(
			roots.map(({ path }) => path),
			[[pi]],
		);
		const team = await store.createWorkspace({ kind: "things.workspace", name: "Team", parent: pi, by: BY }, context);
		const [row] = (await store.workspaces.one.page({ workspace: team }, 1, context)).items;
		assert.deepEqual(row, { workspace: team, parent: pi, showsThings: true, showsPeople: true, path: [pi, team] });
		const under = (await store.workspaces.under.page({ pathPrefix: `${pi}/` }, 10, context)).items;
		assert.deepEqual(
			under.map(({ workspace }) => workspace),
			[pi, team],
		);
		await assert.rejects(
			store.createWorkspace({ kind: "things.workspace", name: "x", parent: "nowhere", by: BY }, context),
			/no workspace nowhere/,
		);
		// After a reload of the plugin Pi is still the one root.
		await w.reload("@earendil-works/p3-things", context);
		const again = await w.host.get(ThingsStore, {}, context);
		assert.equal((await again.workspaces.children.page({ parent: "" }, 10, context)).items.length, 1);
	});
});

describe("making and deleting a thing", () => {
	it("create is one commit: the thing, its link, the default grants and the maker's; then the kind's hook", async () => {
		const ada = await store.createPerson({ name: "Ada", madeBy: BY }, context);
		const by: Source = { kind: "person", person: ada };
		const thing = await store.create({ kind: Board.name, name: "Sketch", workspace: pi, by }, context);
		const [row] = (await store.things.one.page({ thing }, 1, context)).items;
		assert.deepEqual([row?.kind, row?.name, row?.madeBy], [Board.name, "Sketch", by]);
		assert.deepEqual((await store.links.where.page({ thing }, 10, context)).items, [
			{ workspace: pi, thing, of: Board.name },
		]);
		const grants = (await store.grants.of.page({ workspace: pi, thing }, 10, context)).items;
		const summary = grants.map(({ party, source, ticks }) => [party.kind, source.kind, ticks]).sort();
		assert.deepEqual(summary, [
			["agents", "plugin", ["read"]],
			["everyone", "plugin", ["read"]],
			["person", "person", ["read", "write", "draw", "moderate", "look"]],
		]);
		assert.ok(grants.every(({ version, kind }) => version === 1 && kind === Board.name));
		assert.deepEqual(grants.find(({ party }) => party.kind === "everyone")?.source, {
			kind: "plugin",
			plugin: BOARD_PLUGIN,
		});
		assert.deepEqual(HOOKS, [`create ${thing}`]);
	});

	it("a create hook that throws deletes the thing again: nothing of it is left", async () => {
		FAIL.create = true;
		await assert.rejects(
			store.create({ kind: Board.name, name: "x", workspace: pi, by: BY }, context),
			/could not be made/,
		);
		assert.deepEqual((await store.things.ofKind.page({ kind: Board.name }, 10, context)).items, []);
		assert.deepEqual((await store.links.here.page({ workspace: pi }, 10, context)).items, []);
		assert.deepEqual((await store.grants.here.page({ workspace: pi }, 10, context)).items, []);
	});

	it("refuses a kind no plugin registers and a workspace that does not exist", async () => {
		await assert.rejects(
			store.create({ kind: "nobody.kind", name: "x", workspace: pi, by: BY }, context),
			/no kind nobody.kind/,
		);
		await assert.rejects(
			store.create({ kind: Board.name, name: "x", workspace: "nowhere", by: BY }, context),
			/no workspace/,
		);
	});

	it("a thing goes with its last link: its grants and switches everywhere, then its kind's delete hook", async () => {
		const team = await store.createWorkspace({ kind: "things.workspace", name: "Team", parent: pi, by: BY }, context);
		const thing = await store.create({ kind: Board.name, name: "x", workspace: pi, by: BY }, context);
		await store.link({ workspace: team, thing, by: BY }, context);
		await store.setSwitch({ workspace: team, item: { kind: "thing", thing }, shown: false }, context);
		await store.unlink({ workspace: pi, thing }, context);
		assert.equal((await store.things.one.page({ thing }, 1, context)).items.length, 1);
		await store.unlink({ workspace: team, thing }, context);
		assert.deepEqual((await store.things.one.page({ thing }, 1, context)).items, []);
		assert.deepEqual((await store.grants.ofThing.page({ thing }, 10, context)).items, []);
		assert.deepEqual((await store.switches.here.page({ workspace: team }, 10, context)).items, []);
		await eventually(
			() => HOOKS,
			(hooks) => hooks.includes(`delete ${thing}`),
		);
	});
});

describe("linking", () => {
	it("a link starts with the kind's default grants; linking again changes nothing", async () => {
		const team = await store.createWorkspace({ kind: "things.workspace", name: "Team", parent: pi, by: BY }, context);
		const thing = await store.create({ kind: Board.name, name: "x", workspace: pi, by: BY }, context);
		await store.link({ workspace: team, thing, by: BY }, context);
		await store.link({ workspace: team, thing, by: BY }, context);
		const grants = (await store.grants.of.page({ workspace: team, thing }, 10, context)).items;
		assert.deepEqual(grants.map(({ party }) => party.kind).sort(), ["agents", "everyone"]);
		await assert.rejects(store.link({ workspace: team, thing: "none", by: BY }, context), /no thing none/);
	});

	it("ensure makes a plugin's one thing once", async () => {
		const first = await store.ensure({ kind: Board.name, name: "tools", workspace: pi, plugin: "p" }, context);
		const second = await store.ensure({ kind: Board.name, name: "tools", workspace: pi, plugin: "p" }, context);
		assert.equal(first, second);
		assert.equal((await store.things.madeBy.page({ sourceKey: "plugin/p" }, 10, context)).items.length, 1);
	});
});

describe("people", () => {
	it("only a person, a group or a session's agent is put in", async () => {
		await assert.rejects(
			store.putParty({ workspace: pi, party: { kind: "everyone" }, source: BY }, context),
			/no party one puts in/,
		);
	});

	it("deleteEverythingFrom takes a source's grants, memberships and entries, and the groups it manages with all naming them", async () => {
		const share: Source = { kind: "thing", thing: "share" };
		const thing = await store.create({ kind: Board.name, name: "x", workspace: pi, by: BY }, context);
		const kim = await store.createPerson({ name: "Kim", madeBy: share }, context);
		const guests = await store.makeGroup(
			{ name: "guests", managedBy: { kind: "thing", thing: "share" }, outside: true },
			context,
		);
		const kept = await store.makeGroup({ name: "kept", managedBy: { kind: "people" }, outside: false }, context);
		await store.addToGroup({ group: guests, person: kim, source: BY }, context);
		await store.addToGroup({ group: kept, person: kim, source: share }, context);
		await store.addToGroup({ group: kept, person: kim, source: BY }, context);
		await store.putParty({ workspace: pi, party: { kind: "group", group: guests }, source: BY }, context);
		// A person wrote a grant for the share's group: it goes with the group.
		await store.setGrants(
			{
				source: BY,
				grants: [
					{
						workspace: pi,
						thing,
						party: { kind: "group", group: guests },
						gives: true,
						ticks: ["read"],
						takenAway: [],
					},
				],
			},
			context,
		);
		await store.setGroupManagers({ group: guests, parties: [{ kind: "person", person: kim }] }, context);
		await store.deleteEverythingFrom({ source: share }, context);
		assert.deepEqual(
			(await store.groups.ofIds.page({ groups: [guests, kept] }, 10, context)).items.map(({ group }) => group),
			[kept],
		);
		assert.deepEqual(
			(await store.groupMembers.ofPerson.page({ person: kim }, 10, context)).items.map(({ group, source }) => [
				group,
				source,
			]),
			[[kept, BY]],
		);
		assert.deepEqual(
			(await store.workspaceMembers.where.page({ partyKey: `group/${guests}` }, 10, context)).items,
			[],
		);
		assert.deepEqual((await store.grants.ofParty.page({ partyKey: `group/${guests}` }, 10, context)).items, []);
		assert.deepEqual((await store.groupManagers.of.page({ group: guests }, 10, context)).items, []);
	});
});
