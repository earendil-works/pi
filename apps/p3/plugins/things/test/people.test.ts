// People (ERNDL-1144) through the things store and `Group`, on one family's Pi:
//
//   Pi
//   └── Family           Anna and Kim are put in; the group "kids" (Leo) and "parents" (Anna, Leo) are put in
//       └── Session      the Sketch is linked here; everyone here draws by the kind's default
//
// The owner's person made at the first start; hiding people by every route (scenario 1); invite links as member and
// guest (scenario 17); a group's own tick (scenario 18); an outside group taking nothing (scenario 9); the picker;
// memberships of two sources; the cleanup when a source goes, with the sign-ins of the persons it took (test 8);
// a provider's refresh (scenario 13); and a person's removal.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	contribute,
	createHost,
	defineFacet,
	openStore,
	type P3Principal,
	type Reference,
	Server,
	sqliteBackend,
	until,
} from "@earendil-works/p3/v1";
import { eventually, within } from "../../../test/until.ts";
import { SignIns } from "../../sign-in/contract.ts";
import { Gives, OwnerSeeds, ThingsStore } from "../contract.server.ts";
import { Group, type Party, type Source } from "../contract.ts";
import { Board } from "./kinds.ts";
import { RUNTIME, signInsStub, storedRows, THINGS, type World, world } from "./world.ts";

const ADMIN: Source = { kind: "plugin", plugin: "admin" };

/** The family's world: ids of its workspaces, persons, groups and the Sketch. */
type Family = {
	pi: string;
	family: string;
	session: string;
	anna: string;
	kim: string;
	leo: string;
	kids: string;
	parents: string;
	sketch: string;
};

let w: World;
let store: Reference<typeof ThingsStore>;
let f: Family;
let signIns: ReturnType<typeof signInsStub>;

const person = (id: string): Party => ({ kind: "person", person: id });
const group = (id: string): Party => ({ kind: "group", group: id });
const principal = (id: string): P3Principal => ({ kind: "person", id, name: id });

beforeEach(async () => {
	signIns = signInsStub();
	w = await world(context, [signIns.plugin]);
	store = await w.host.get(ThingsStore, {}, context);
	const pi = (await store.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	const family = await store.createWorkspace(
		{ kind: "things.workspace", name: "Family", parent: pi, by: ADMIN },
		context,
	);
	const session = await store.createWorkspace(
		{ kind: "things.workspace", name: "Session", parent: family, by: ADMIN },
		context,
	);
	const [anna, kim, leo] = await Promise.all(
		["Anna", "Kim", "Leo"].map((name) => store.createPerson({ name, madeBy: ADMIN }, context)),
	);
	const kids = await store.makeGroup({ name: "kids", managedBy: { kind: "people" }, outside: false }, context);
	const parents = await store.makeGroup(
		{ name: "parents", managedBy: { kind: "people" }, outside: false, managers: [person(anna!)] },
		context,
	);
	await store.addToGroup({ group: kids, person: leo!, source: ADMIN }, context);
	for (const member of [anna!, leo!])
		await store.addToGroup({ group: parents, person: member, source: ADMIN }, context);
	for (const party of [person(anna!), person(kim!), group(kids), group(parents)]) {
		await store.putParty({ workspace: family, party, source: ADMIN }, context);
	}
	const sketch = await store.create({ kind: Board.name, name: "Sketch", workspace: session, by: ADMIN }, context);
	f = { pi, family, session, anna: anna!, kim: kim!, leo: leo!, kids, parents, sketch };
});

afterEach(() => w.close(context));

/** What person `id` gets for `thing` in `workspace`: its ticks, or none. */
async function ticks(workspace: string, thing: string, id: string): Promise<string[] | undefined> {
	const gives = await w.host.get(Gives, { workspace, caller: `person:${id}` }, context);
	try {
		return gives.answers.value[thing]?.ticks;
	} finally {
		gives.release();
	}
}

/** Runs `fn` as person `id`. */
function as<T>(id: string, fn: (ctx: Ctx<P3Principal>) => Promise<T>): Promise<T> {
	return w.host.root(fn, context, { principal: principal(id) });
}

describe("persons and the owner", () => {
	it("the owner's person is made at the first start, named after the machine's user, once", async () => {
		const owners = (await store.persons.owners.page({}, 10, context)).items;
		assert.deepEqual(
			owners.map(({ name, owner }) => [name, owner]),
			[["Ann", true]],
		);
		// A start on the same disk (a copy of the committed file, opened by a host of its own) makes no second one.
		const copy = `${w.path}.copy`;
		const database = new DatabaseSync(w.path);
		database.prepare("VACUUM INTO ?").run(copy);
		database.close();
		const reopened = await openStore(sqliteBackend(new NodeSqliteDatabase(new DatabaseSync(copy))), context);
		const host = createHost<P3Principal>({
			address: Server(),
			principal: { kind: "server" },
			store: reopened,
			onError: (error) => assert.fail(`host error ${error.kind}`),
		});
		try {
			await host.load([RUNTIME, THINGS], context);
			const again = await host.get(ThingsStore, {}, context);
			assert.deepEqual(
				(await again.persons.owners.page({}, 10, context)).items.map(({ person: id }) => id),
				owners.map(({ person: id }) => id),
			);
		} finally {
			await host.close(context);
			await reopened.close(context);
		}
	});

	it("the people plugin's owner becomes the owner here, with the same id; the first start's own goes (the bridge)", async () => {
		const seeded = await world(context, [
			{
				name: "@earendil-works/p3-people",
				facet: defineFacet((host) =>
					contribute(host, "test.owner-seed", (self) =>
						self.contribute(OwnerSeeds, { person: "people-owner", name: "Mario" }),
					),
				),
			},
		]);
		try {
			const things = await seeded.host.get(ThingsStore, {}, context);
			// Adopted once the store is live: what no watchable shows, polled.
			const owners = await eventually(
				async () => (await things.persons.owners.page({}, 10, context)).items,
				(items) => items.length === 1 && items[0]!.person === "people-owner",
			);
			assert.deepEqual(
				owners.map(({ person: id, name }) => [id, name]),
				[["people-owner", "Mario"]],
			);
		} finally {
			await seeded.close(context);
		}
	});

	it("a person with the owner flag is not removed; without it, they go with everything naming them", async () => {
		await store.setOwner({ person: f.kim, owner: true }, context);
		await assert.rejects(store.removePerson({ person: f.kim }, context), /owner flag/);
		await store.setOwner({ person: f.kim, owner: false }, context);
		const { id } = await (await w.host.get(SignIns, {}, context)).issue(
			{ principal: principal(f.kim), label: "kim's phone", kind: "browser" },
			context,
		);
		assert.deepEqual(await ticks(f.session, f.sketch, f.kim), ["read"]);
		await store.removePerson({ person: f.kim }, context);
		assert.equal(await ticks(f.session, f.sketch, f.kim), undefined);
		assert.ok(!w.rows("workspace-members").some((row) => String(row.partyKey) === `person/${f.kim}`));
		assert.ok(!storedRows(w.path, "persons").some((row) => row.person === f.kim));
		await until(
			(await w.host.get(SignIns, {}, context)).list,
			(list) => list.length === 0,
			within("her sign-ins ended", context),
		);
		assert.deepEqual(signIns.revoked, [id]);
		assert.deepEqual(w.rows("sign-outs"), []);
	});
});

describe("hiding people (scenario 1, decision 106)", () => {
	it("one switch each hides Kim (her own entry), Leo (only through kids) and grandma (a guest) in the session", async () => {
		const link = await store.createInvite({ workspace: f.family, name: "Grandma", as: "guest", by: ADMIN }, context);
		const grandma = (await store.redeemInvite({ secret: link }, context))!.person;
		const guests = (await store.groupMembers.ofPerson.page({ person: grandma }, 1, context)).items[0]!.group;
		await store.setGrants(
			{
				source: ADMIN,
				grants: [{ workspace: f.session, thing: f.sketch, party: group(guests), tick: "draw", gives: true }],
			},
			context,
		);
		for (const id of [f.kim, f.leo, grandma]) assert.notEqual(await ticks(f.session, f.sketch, id), undefined);
		for (const id of [f.kim, f.leo, grandma]) {
			await store.setSwitch(
				{ workspace: f.session, item: { kind: "party", party: person(id) }, shown: false },
				context,
			);
		}
		for (const id of [f.kim, f.leo, grandma]) assert.equal(await ticks(f.session, f.sketch, id), undefined);
		// Anna, not hidden, keeps it.
		assert.deepEqual(await ticks(f.session, f.sketch, f.anna), ["read"]);
	});
});

describe("invite links (scenario 17, R17, R39)", () => {
	it("grandma as a member counts as herself and everyone here", async () => {
		const link = await store.createInvite({ workspace: f.family, name: "Grandma", as: "member", by: ADMIN }, context);
		const grandma = await store.redeemInvite({ secret: link }, context);
		assert.equal(grandma?.name, "Grandma");
		assert.deepEqual(await ticks(f.session, f.sketch, grandma!.person), ["read"]);
		const row = storedRows(w.path, "persons").find(({ person: id }) => id === grandma!.person);
		assert.equal(row?.madeByKey, "plugin/admin");
	});

	it("grandma as a guest counts only as the Guests group: what everyone here gets gives her nothing", async () => {
		const link = await store.createInvite({ workspace: f.family, name: "Grandma", as: "guest", by: ADMIN }, context);
		const grandma = (await store.redeemInvite({ secret: link }, context))!.person;
		assert.equal(await ticks(f.session, f.sketch, grandma), undefined);
		const [membership] = (await store.groupMembers.ofPerson.page({ person: grandma }, 10, context)).items;
		assert.equal(membership?.outside, true);
		// A second guest joins the same Guests group, put into Family once.
		const second = await store.createInvite({ workspace: f.family, name: "Opa", as: "guest", by: ADMIN }, context);
		const opa = (await store.redeemInvite({ secret: second }, context))!.person;
		assert.equal(
			(await store.groupMembers.ofPerson.page({ person: opa }, 10, context)).items[0]?.group,
			membership?.group,
		);
		const entries = (await store.workspaceMembers.here.page({ workspace: f.family }, 100, context)).items;
		assert.equal(
			entries.filter(({ party }) => party.kind === "group" && party.group === membership?.group).length,
			1,
		);
	});

	it("a link is used up by its first use unless for several, expires, and puts an existing person in", async () => {
		const once = await store.createInvite({ workspace: f.session, name: "x", as: "member", by: ADMIN }, context);
		assert.notEqual(await store.redeemInvite({ secret: once, person: f.kim }, context), null);
		assert.equal(await store.redeemInvite({ secret: once }, context), null);
		const several = await store.createInvite(
			{ workspace: f.session, name: "Friend", as: "member", uses: "several", by: ADMIN },
			context,
		);
		assert.notEqual(await store.redeemInvite({ secret: several }, context), null);
		assert.notEqual(await store.redeemInvite({ secret: several }, context), null);
		const expired = await store.createInvite(
			{ workspace: f.session, name: "x", as: "member", expires: 1, by: ADMIN },
			context,
		);
		await new Promise((done) => setTimeout(done, 5));
		assert.equal(await store.redeemInvite({ secret: expired }, context), null);
		// A wrong secret redeems nothing, and leaves the link good for its right one.
		const guarded = await store.createInvite({ workspace: f.session, name: "y", as: "member", by: ADMIN }, context);
		const [invite] = guarded.split(".");
		assert.equal(await store.redeemInvite({ secret: `${invite}.wrong` }, context), null);
		assert.notEqual(await store.redeemInvite({ secret: guarded }, context), null);
		// Kim, put in by her redeemed link (the existing person, no new one).
		const entries = (await store.workspaceMembers.here.page({ workspace: f.session }, 100, context)).items;
		assert.ok(entries.some(({ party }) => party.kind === "person" && party.person === f.kim));
	});

	it("a link with a group puts its redeemer into the group too", async () => {
		const link = await store.createInvite(
			{ workspace: f.family, name: "Max", as: "member", group: f.kids, by: ADMIN },
			context,
		);
		const max = (await store.redeemInvite({ secret: link }, context))!.person;
		const groups = (await store.groupMembers.ofPerson.page({ person: max }, 10, context)).items.map(
			({ group: g }) => g,
		);
		assert.deepEqual(groups, [f.kids]);
	});
});

describe("a group's own tick (scenario 18, decision 68)", () => {
	it("Leo, a member of parents, sees it but cannot add himself; Anna, its manager, adds a person present", async () => {
		const leo = await as(f.leo, async (ctx) => {
			const held = await ctx.get(Group, { group: f.parents });
			return { add: held.addMember, members: held.members.value.map(({ name }) => name).sort() };
		});
		assert.equal(leo.add, undefined);
		assert.deepEqual(leo.members, ["Anna", "Leo"]);
		await as(f.anna, async (ctx) => {
			const held = await ctx.get(Group, { group: f.parents });
			await held.addMember!({ person: f.kim }, ctx);
		});
		assert.ok((await store.groupMembers.ofPerson.page({ person: f.kim }, 10, context)).items.length > 0);
	});

	it("a person present nowhere the manager is cannot be added", async () => {
		const stranger = await store.createPerson({ name: "Stranger", madeBy: ADMIN }, context);
		await assert.rejects(
			as(f.anna, async (ctx) => (await ctx.get(Group, { group: f.parents })).addMember!({ person: stranger }, ctx)),
			/not present where you are/,
		);
	});

	it("someone the group is nothing to is denied; a group a share manages has no calls for anyone", async () => {
		await assert.rejects(as(f.kim, (ctx) => ctx.get(Group, { group: f.parents })));
		const managed = await store.makeGroup(
			{ name: "share", managedBy: { kind: "thing", thing: "s" }, outside: true, managers: [person(f.anna)] },
			context,
		);
		const add = await as(f.anna, async (ctx) => (await ctx.get(Group, { group: managed })).addMember);
		assert.equal(add, undefined);
	});
});

describe("a group's page", () => {
	it("removeMember takes what people wrote for the person; a provider's row keeps them in", async () => {
		const radius: Source = { kind: "identity", provider: "radius" };
		await store.addToGroup({ group: f.parents, person: f.leo, source: radius }, context);
		await as(f.anna, async (ctx) =>
			(await ctx.get(Group, { group: f.parents })).removeMember!({ person: f.leo }, ctx),
		);
		const rows = storedRows(w.path, "group-members").filter((row) => row.group === f.parents && row.person === f.leo);
		assert.deepEqual(
			rows.map((row) => row.sourceKey),
			["identity/radius"],
		);
	});

	it("removing a group takes its members, managers and every entry naming it", async () => {
		// The call ends with the object it removes: its admission denies a group that is gone.
		await assert.rejects(
			as(f.anna, async (ctx) => (await ctx.get(Group, { group: f.parents })).remove!(ctx)),
			/not a member or a manager/,
		);
		for (const table of ["groups", "group-members", "group-managers"]) {
			assert.ok(!storedRows(w.path, table).some((row) => row.group === f.parents), table);
		}
		assert.ok(!w.rows("workspace-members").some((row) => String(row.partyKey) === `group/${f.parents}`));
	});

	it("a held group survives a reload of the things plugin: its members still change live", async () => {
		await as(f.anna, async (ctx) => {
			const held = await ctx.get(Group, { group: f.parents });
			await w.reload("@earendil-works/p3-things", context);
			const store2 = await w.host.get(ThingsStore, {}, context);
			await store2.addToGroup({ group: f.parents, person: f.kim, source: ADMIN }, context);
			await until(
				held.members,
				(members) => members.some(({ person: id }) => id === f.kim),
				within("Kim in the group", ctx),
			);
		});
	});
});

describe("presence", () => {
	it("a member who is also in an outside group loses nothing (scenario 9)", async () => {
		const share = await store.makeGroup(
			{ name: "share", managedBy: { kind: "thing", thing: "share" }, outside: true },
			context,
		);
		await store.addToGroup({ group: share, person: f.kim, source: ADMIN }, context);
		await store.putParty({ workspace: f.session, party: group(share), source: ADMIN }, context);
		assert.deepEqual(await ticks(f.session, f.sketch, f.kim), ["read"]);
	});

	it("the same person in a group from two sources: removing one keeps them in", async () => {
		const other: Source = { kind: "identity", provider: "radius" };
		await store.addToGroup({ group: f.kids, person: f.leo, source: other }, context);
		await store.removeFromGroup({ group: f.kids, person: f.leo, source: ADMIN }, context);
		const groups = (await store.groupMembers.ofPerson.page({ person: f.leo }, 10, context)).items.map(
			({ group: g }) => g,
		);
		assert.ok(groups.includes(f.kids));
	});

	it("a provider's refresh removes a membership: the person loses that group's ticks on an open hold (scenario 13)", async () => {
		const radius: Source = { kind: "identity", provider: "radius" };
		const staff = await store.makeGroup(
			{ name: "staff", managedBy: { kind: "identity", provider: "radius" }, outside: false },
			context,
		);
		const drafts = await store.createWorkspace(
			{ kind: "things.workspace", name: "Drafts", parent: f.pi, by: ADMIN },
			context,
		);
		await store.putParty({ workspace: drafts, party: group(staff), source: radius }, context);
		const board = await store.create({ kind: Board.name, name: "b", workspace: drafts, by: ADMIN }, context);
		await store.addToGroup({ group: staff, person: f.kim, source: radius }, context);
		const gives = await w.host.get(Gives, { workspace: drafts, caller: `person:${f.kim}` }, context);
		assert.deepEqual(gives.answers.value[board]?.ticks, ["read"]);
		await store.removeFromGroup({ group: staff, person: f.kim, source: radius }, context);
		await until(gives.answers, (answers) => answers[board] === undefined, within("the membership gone", context));
		gives.release();
	});
});

describe("the picker (R18)", () => {
	it("offers the persons and groups present where the caller is present, by name; nobody from elsewhere", async () => {
		const elsewhere = await store.createWorkspace(
			{ kind: "things.workspace", name: "Work", parent: f.pi, by: ADMIN },
			context,
		);
		const boss = await store.createPerson({ name: "Boss", madeBy: ADMIN }, context);
		await store.putParty({ workspace: elsewhere, party: person(boss), source: ADMIN }, context);
		const names = (await store.picker({ workspace: f.session, person: f.anna, query: "" }, context)).map(
			({ name }) => name,
		);
		// Leo is present only through kids and parents: the groups are offered, not him.
		assert.deepEqual(names, ["Anna", "kids", "Kim", "parents"]);
		assert.deepEqual(
			(await store.picker({ workspace: f.session, person: f.anna, query: "KI" }, context)).map(({ name }) => name),
			["kids", "Kim"],
		);
		assert.equal(await store.offers({ workspace: f.session, person: f.anna, party: person(boss) }, context), false);
		// Boss is offered to Anna once she is present in Work too.
		await store.putParty({ workspace: elsewhere, party: person(f.anna), source: ADMIN }, context);
		assert.equal(await store.offers({ workspace: f.session, person: f.anna, party: person(boss) }, context), true);
	});
});

describe("the cleanup when a source goes (test 8)", () => {
	it("a share's grants, its guest group with all naming it, and the guests it made with nothing else, in one commit", async () => {
		const share: Source = { kind: "thing", thing: "share-1" };
		const guests = await store.makeGroup(
			{ name: "share guests", managedBy: { kind: "thing", thing: "share-1" }, outside: true },
			context,
		);
		await store.putParty({ workspace: f.session, party: group(guests), source: share }, context);
		// A grant naming the share's group, written by a person: it goes too.
		await store.setGrants(
			{
				source: { kind: "person", person: f.anna },
				grants: [{ workspace: f.session, thing: f.sketch, party: group(guests), tick: "draw", gives: true }],
			},
			context,
		);
		const made: string[] = [];
		for (let i = 0; i < 50; i++) {
			const guest = await store.createPerson({ name: `guest ${i}`, madeBy: share }, context);
			await store.addToGroup({ group: guests, person: guest, source: share }, context);
			made.push(guest);
		}
		// One of them was also put into Family by hand: she stays.
		await store.putParty({ workspace: f.family, party: person(made[0]!), source: ADMIN }, context);
		const started = performance.now();
		await store.deleteEverythingFrom({ source: share }, context);
		const took = performance.now() - started;
		const persons = new Set(storedRows(w.path, "persons").map(({ person: id }) => id));
		assert.ok(persons.has(made[0]!));
		assert.equal(made.filter((id) => persons.has(id)).length, 1);
		assert.ok(!storedRows(w.path, "groups").some(({ group: g }) => g === guests));
		assert.ok(!w.rows("grants").some((row) => String(row.partyKey) === `group/${guests}`));
		assert.ok(!w.rows("workspace-members").some((row) => String(row.partyKey) === `group/${guests}`));
		assert.ok(took < 20, `the cleanup of 50 guests took ${took.toFixed(1)} ms`);
	});
});
