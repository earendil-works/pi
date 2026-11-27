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
import { Gives, GroupPresence, OwnerSeeds, ThingsStore } from "../contract.server.ts";
import { Group, type Party, partyKey, type Source } from "../contract.ts";
import { Workspace } from "../workspace.ts";
import { BOARD_PLUGIN, Board } from "./kinds.ts";
import { signInsStub, storedRows, THINGS, type World, world } from "./world.ts";

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
	it("the owner's person is made at the first start, named Owner, once", async () => {
		const owners = (await store.persons.owners.page({}, 10, context)).items;
		assert.deepEqual(
			owners.map(({ name, owner }) => [name, owner]),
			[["Owner", true]],
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
			await host.load([THINGS], context);
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
			// Reloads in the order that once held the store's drain 30 s (the seed's plugin, another, then things):
			// nothing is reported, and each is quick.
			for (const plugin of ["@earendil-works/p3-people", BOARD_PLUGIN, "@earendil-works/p3-things"]) {
				const started = performance.now();
				await seeded.reload(plugin, context);
				assert.ok(performance.now() - started < 5000, `the reload of ${plugin} took too long`);
			}
			const again = await seeded.host.get(ThingsStore, {}, context);
			assert.deepEqual(
				(await again.persons.owners.page({}, 10, context)).items.map(({ person: id }) => id),
				["people-owner"],
			);
			assert.deepEqual(seeded.errors, []);
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
			return { add: held.addMember, members: held.members.value.rows.map(({ name }) => name).sort() };
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

	it("held by anyone it is present for, with no calls; denied to someone it is nothing to (1141 §7)", async () => {
		// Kim is in Family, where parents is put in: she sees the group and its members.
		const kim = await as(f.kim, async (ctx) => {
			const held = await ctx.get(Group, { group: f.parents });
			return { add: held.addMember, members: held.members.value.rows.map(({ name }) => name).sort() };
		});
		assert.deepEqual(kim, { add: undefined, members: ["Anna", "Leo"] });
		const stranger = await store.createPerson({ name: "Stranger", madeBy: ADMIN }, context);
		await assert.rejects(as(stranger, (ctx) => ctx.get(Group, { group: f.parents }, { readyTimeout: 1000 })));
	});

	it("the owner adds anyone, present anywhere or not; server code too", async () => {
		const stranger = await store.createPerson({ name: "Stranger", madeBy: ADMIN }, context);
		await store.setOwner({ person: f.kim, owner: true }, context);
		await as(f.kim, async (ctx) =>
			(await ctx.get(Group, { group: f.parents })).addMember!({ person: stranger }, ctx),
		);
		const other = await store.createPerson({ name: "Other", madeBy: ADMIN }, context);
		await w.host.root(
			async (ctx) => (await ctx.get(Group, { group: f.parents })).addMember!({ person: other }, ctx),
			context,
		);
		const groups = async (id: string) =>
			(await store.groupMembers.ofPerson.page({ person: id }, 10, context)).items.map(({ group: g }) => g);
		assert.deepEqual([await groups(stranger), await groups(other)], [[f.parents], [f.parents]]);
	});

	it("a group a share manages has no calls for anyone", async () => {
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
			/not present for you/,
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
				(members) => members.rows.some(({ person: id }) => id === f.kim),
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
		const names = (
			await store.picker({ workspace: f.session, caller: { kind: "person", person: f.anna }, query: "" }, context)
		).map(({ name }) => name);
		// Leo is present only through kids and parents: the groups are offered, not him.
		assert.deepEqual(names, ["Anna", "kids", "Kim", "parents"]);
		assert.deepEqual(
			(
				await store.picker(
					{ workspace: f.session, caller: { kind: "person", person: f.anna }, query: "KI" },
					context,
				)
			).map(({ name }) => name),
			["kids", "Kim"],
		);
		assert.equal(
			await store.offers(
				{ workspace: f.session, caller: { kind: "person", person: f.anna }, party: person(boss) },
				context,
			),
			false,
		);
		// Boss is offered to Anna once she is present in Work too.
		await store.putParty({ workspace: elsewhere, party: person(f.anna), source: ADMIN }, context);
		assert.equal(
			await store.offers(
				{ workspace: f.session, caller: { kind: "person", person: f.anna }, party: person(boss) },
				context,
			),
			true,
		);
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
		// A live hold in the session: the index has it loaded, and reads again what the commit touched there.
		const gives = await w.host.get(Gives, { workspace: f.session, caller: `person:${f.anna}` }, context);
		const reads = w.count("things.access.reads");
		await store.deleteEverythingFrom({ source: share }, context);
		// The index reads again only what the commit touched and it has loaded, however many guests went (the commit's
		// own reads: plans.test.ts; the time: bench/things.ts).
		const read = w.count("things.access.reads") - reads;
		gives.release();
		const persons = new Set(storedRows(w.path, "persons").map(({ person: id }) => id));
		assert.ok(persons.has(made[0]!));
		assert.equal(made.filter((id) => persons.has(id)).length, 1);
		assert.ok(!storedRows(w.path, "groups").some(({ group: g }) => g === guests));
		assert.ok(!w.rows("grants").some((row) => String(row.partyKey) === `group/${guests}`));
		assert.ok(!w.rows("workspace-members").some((row) => String(row.partyKey) === `group/${guests}`));
		assert.ok(read <= 10, `the index read ${read} sets again`);
	});
});

describe("round 1's reproductions (Opus, Astra, Fable)", () => {
	/** A stand-in for the people plugin handing over its owner (`null`: none yet). */
	const seedPlugin = (seed: { person: string; name: string } | null) => ({
		name: "@earendil-works/p3-people",
		facet: defineFacet((host) => contribute(host, "test.owner-seed", (self) => self.contribute(OwnerSeeds, seed))),
	});
	const ownersOf = async (at: World) =>
		(await (await at.host.get(ThingsStore, {}, context)).persons.owners.page({}, 10, context)).items
			.map(({ person: id }) => id)
			.sort();

	it("a thing's last unlink runs its cleanup: the persons it made go with their sign-ins and its links (Astra must 1, Opus S2)", async () => {
		const board = await store.create({ kind: Board.name, name: "share", workspace: f.session, by: ADMIN }, context);
		await store.link({ workspace: f.family, thing: board }, context);
		const made = await store.createPerson({ name: "Guest", madeBy: { kind: "thing", thing: board } }, context);
		await (await w.host.get(SignIns, {}, context)).issue(
			{ principal: principal(made), label: "guest", kind: "browser" },
			context,
		);
		const link = await store.createInvite(
			{ workspace: f.session, name: "x", as: "member", by: { kind: "thing", thing: board } },
			context,
		);
		await store.unlink({ workspace: f.family, thing: board }, context);
		assert.ok(storedRows(w.path, "persons").some(({ person: id }) => id === made));
		await store.unlink({ workspace: f.session, thing: board }, context);
		assert.ok(!storedRows(w.path, "persons").some(({ person: id }) => id === made));
		assert.equal(await store.redeemInvite({ secret: link }, context), null);
		await until(
			(await w.host.get(SignIns, {}, context)).list,
			(list) => list.length === 0,
			within("the guest's sign-in ended", context),
		);
	});

	it("the bridge adopts once: a used placeholder and other owners stay, a handover stands (Astra must 2)", async () => {
		const at = await world(context, [seedPlugin(null)]);
		try {
			const things = await at.host.get(ThingsStore, {}, context);
			const [placeholder] = await ownersOf(at);
			// The placeholder got something (a manager row), and another person has the flag too.
			const g = await things.makeGroup(
				{ name: "g", managedBy: { kind: "people" }, outside: false, managers: [person(placeholder!)] },
				context,
			);
			const other = await things.createPerson({ name: "Other", madeBy: ADMIN }, context);
			await things.setOwner({ person: other, owner: true }, context);
			await at.reload("@earendil-works/p3-people", context, seedPlugin({ person: "seed", name: "Mario" }).facet);
			await eventually(
				() => ownersOf(at),
				(ids) => ids.includes("seed"),
			);
			assert.deepEqual(await ownersOf(at), [other, placeholder!, "seed"].sort());
			assert.ok(g !== "");
			// The flag handed over from the seed's person; the seed comes again with another name: it stands.
			const again = await at.host.get(ThingsStore, {}, context);
			await again.setOwner({ person: "seed", owner: false }, context);
			await at.reload("@earendil-works/p3-people", context, seedPlugin({ person: "seed", name: "Mario Z" }).facet);
			await at.reload("@earendil-works/p3-things", context);
			assert.deepEqual(await ownersOf(at), [other, placeholder!].sort());
			// Asked again, as the bridge asks at every start: adopted once, the handover stands.
			await (await at.host.get(ThingsStore, {}, context)).adoptOwner({ person: "seed", name: "Mario Z" }, context);
			assert.deepEqual(await ownersOf(at), [other, placeholder!].sort());
			assert.deepEqual(at.errors, []);
		} finally {
			await at.close(context);
		}
	});

	it("an unused placeholder goes at the adoption; only the people plugin's contribution counts", async () => {
		// The other plugin comes first, by load and by name: its contribution is ignored.
		const at = await world(context, [
			{
				name: "@earendil-works/a-other",
				facet: defineFacet((host) =>
					contribute(host, "test.other-seed", (self) =>
						self.contribute(OwnerSeeds, { person: "impostor", name: "Eve" }),
					),
				),
			},
			seedPlugin(null),
		]);
		try {
			const [placeholder] = await ownersOf(at);
			await at.reload("@earendil-works/p3-people", context, seedPlugin({ person: "seed", name: "Mario" }).facet);
			await eventually(
				() => ownersOf(at),
				(ids) => ids.includes("seed"),
			);
			assert.deepEqual(await ownersOf(at), ["seed"]);
			assert.ok(placeholder !== "seed");
		} finally {
			await at.close(context);
		}
	});

	it("the picker offers what is present where the caller is present, inherited below too (Opus S1, Astra must 3)", async () => {
		// Sub is put into the session only; Anna, put into Family, is present in the session from above.
		const sub = await store.createPerson({ name: "Sub", madeBy: ADMIN }, context);
		await store.putParty({ workspace: f.session, party: person(sub), source: ADMIN }, context);
		assert.equal(
			await store.offers(
				{ workspace: f.family, caller: { kind: "person", person: f.anna }, party: person(sub) },
				context,
			),
			true,
		);
		// Hidden in the session, Anna is present there no more: Sub is offered only where it is used.
		await store.setSwitch(
			{ workspace: f.session, item: { kind: "party", party: person(f.anna) }, shown: false },
			context,
		);
		assert.equal(
			await store.offers(
				{ workspace: f.family, caller: { kind: "person", person: f.anna }, party: person(sub) },
				context,
			),
			false,
		);
		assert.equal(
			await store.offers(
				{ workspace: f.session, caller: { kind: "person", person: f.anna }, party: person(sub) },
				context,
			),
			true,
		);
	});

	it("the owner's picker offers everyone (decision 78)", async () => {
		const stranger = await store.createPerson({ name: "Stranger", madeBy: ADMIN }, context);
		await store.setOwner({ person: f.kim, owner: true }, context);
		const kim = { kind: "person", person: f.kim } as const;
		assert.equal(await store.offers({ caller: kim, party: person(stranger) }, context), true);
		const names = (await store.picker({ workspace: f.session, caller: kim, query: "stran" }, context)).map(
			({ name }) => name,
		);
		assert.deepEqual(names, ["Stranger"]);
	});

	it("a person who made someone still present stays with the source's cleanup (Astra must 4)", async () => {
		const share: Source = { kind: "thing", thing: "share-2" };
		const first = await store.createPerson({ name: "First", madeBy: share }, context);
		const second = await store.createPerson({ name: "Second", madeBy: { kind: "person", person: first } }, context);
		await store.putParty({ workspace: f.family, party: person(second), source: ADMIN }, context);
		await store.deleteEverythingFrom({ source: share }, context);
		const ids = storedRows(w.path, "persons").map(({ person: id }) => id);
		assert.ok(ids.includes(first) && ids.includes(second));
	});

	it("each route of 'something left' keeps a person; the owner flag too (Opus S7)", async () => {
		const share: Source = { kind: "thing", thing: "share-3" };
		const [inGroup, source, manager, owner, nothing] = await Promise.all(
			["inGroup", "source", "manager", "owner", "nothing"].map((name) =>
				store.createPerson({ name, madeBy: share }, context),
			),
		);
		await store.addToGroup({ group: f.kids, person: inGroup!, source: ADMIN }, context);
		await store.putParty(
			{ workspace: f.family, party: person(f.kim), source: { kind: "person", person: source! } },
			context,
		);
		await store.setGroupManagers({ group: f.kids, parties: [person(manager!)] }, context);
		await store.setOwner({ person: owner!, owner: true }, context);
		await store.deleteEverythingFrom({ source: share }, context);
		const ids = new Set(storedRows(w.path, "persons").map(({ person: id }) => String(id)));
		assert.deepEqual(
			[inGroup!, source!, manager!, owner!, nothing!].map((id) => ids.has(id)),
			[true, true, true, true, false],
		);
	});

	it("removeMember takes the rows people and plugins wrote, by the group and person, keeps a provider's (Astra must 5)", async () => {
		const radius: Source = { kind: "identity", provider: "radius" };
		await store.addToGroup({ group: f.parents, person: f.leo, source: { kind: "person", person: f.anna } }, context);
		await store.addToGroup({ group: f.parents, person: f.leo, source: radius }, context);
		await store.removeMember({ group: f.parents, person: f.leo }, context);
		const rows = storedRows(w.path, "group-members").filter((row) => row.group === f.parents && row.person === f.leo);
		assert.deepEqual(
			rows.map((row) => row.sourceKey),
			["identity/radius"],
		);
	});

	it("a group's members come a page at a time; a manager through a group of theirs gets the calls", async () => {
		for (let i = 0; i < 101; i++) {
			const id = await store.createPerson({ name: `m${String(i).padStart(3, "0")}`, madeBy: ADMIN }, context);
			await store.addToGroup({ group: f.kids, person: id, source: ADMIN }, context);
		}
		await store.setGroupManagers({ group: f.kids, parties: [group(f.parents)] }, context);
		await as(f.leo, async (ctx) => {
			const held = await ctx.get(Group, { group: f.kids });
			assert.ok(held.addMember !== undefined);
			assert.deepEqual([held.members.value.rows.length, held.members.value.moreAfter], [100, true]);
			await held.more(ctx);
			assert.equal(held.members.value.rows.length, 102);
		});
	});

	it("a redeemed link keeps an entry there already, spends nothing for a person who does not exist (Opus S3)", async () => {
		// Anna, with Manage people in Family, makes the link: a replaced entry would name her as its source.
		await store.setTick(
			{
				workspace: f.family,
				thing: f.family,
				party: person(f.anna),
				tick: "managePeople",
				gives: true,
				source: ADMIN,
			},
			context,
		);
		const link = await store.createInvite(
			{ workspace: f.family, name: "x", as: "member", by: { kind: "person", person: f.anna } },
			context,
		);
		assert.equal(await store.redeemInvite({ secret: link, person: "nobody" }, context), null);
		assert.notEqual(await store.redeemInvite({ secret: link, person: f.kim }, context), null);
		const entry = (await store.workspaceMembers.here.page({ workspace: f.family }, 100, context)).items.find(
			({ party }) => party.kind === "person" && party.person === f.kim,
		);
		assert.deepEqual(entry?.source, ADMIN);
		const gone = await store.createWorkspace(
			{ kind: "things.workspace", name: "g", parent: f.pi, by: ADMIN },
			context,
		);
		const into = await store.createInvite({ workspace: gone, name: "y", as: "member", by: ADMIN }, context);
		await store.removeWorkspace({ workspace: gone }, context);
		assert.equal(await store.redeemInvite({ secret: into }, context), null);
	});

	it("a link's group needs its own tick: refused to Leo, made for Anna (scenario 18, Opus S4)", async () => {
		await assert.rejects(
			store.createInvite(
				{ workspace: f.family, name: "x", as: "member", group: f.parents, by: { kind: "person", person: f.leo } },
				context,
			),
			(error: Error & { details?: { message?: { key: string } } }) =>
				error.details?.message?.key === "groupNotManaged",
		);
		await store.createInvite(
			{ workspace: f.family, name: "x", as: "member", group: f.parents, by: { kind: "person", person: f.anna } },
			context,
		);
		// An owner without the group's tick names it too.
		await store.setOwner({ person: f.kim, owner: true }, context);
		await store.createInvite(
			{ workspace: f.family, name: "x", as: "member", group: f.parents, by: { kind: "person", person: f.kim } },
			context,
		);
	});

	it("a removed group leaves no manager rows of its own elsewhere, and no link naming it (Astra)", async () => {
		await store.setGroupManagers({ group: f.kids, parties: [group(f.parents)] }, context);
		const link = await store.createInvite(
			{ workspace: f.family, name: "x", as: "member", group: f.parents, by: ADMIN },
			context,
		);
		await store.removeGroup({ group: f.parents }, context);
		assert.ok(!storedRows(w.path, "group-managers").some((row) => row.partyKey === `group/${f.parents}`));
		assert.equal(await store.redeemInvite({ secret: link }, context), null);
	});
});

describe("after push A (Opus's check of the explainer)", () => {
	it("a link redeems only while its maker may still write it: Manage people where it points, its group's own tick", async () => {
		const anna = { kind: "person", person: f.anna } as const;
		const club = await store.createWorkspace(
			{ kind: "things.workspace", name: "Club", parent: f.family, by: anna },
			context,
		);
		const link = (group?: string) =>
			store.createInvite(
				{ workspace: club, name: "x", as: "member", by: anna, ...(group === undefined ? {} : { group }) },
				context,
			);
		const plain = await link();
		const grouped = await link(f.parents);
		const managePeople = (gives: boolean) =>
			store.setTick(
				{ workspace: club, thing: club, party: person(f.anna), tick: "managePeople", gives, source: ADMIN },
				context,
			);
		// Manage people withheld from Anna in Club: her link redeems nothing, and stays good.
		await managePeople(false);
		assert.equal(await store.redeemInvite({ secret: plain }, context), null);
		await managePeople(true);
		assert.notEqual(await store.redeemInvite({ secret: plain }, context), null);
		// The group's own tick taken from her: the link naming the group redeems nothing, until she has it again.
		await store.setGroupManagers({ group: f.parents, parties: [] }, context);
		assert.equal(await store.redeemInvite({ secret: grouped }, context), null);
		await store.setGroupManagers({ group: f.parents, parties: [person(f.anna)] }, context);
		assert.notEqual(await store.redeemInvite({ secret: grouped }, context), null);
	});
});

describe("the picker's check against its list", () => {
	it("offers agrees with the picker's list for every caller, place and party, with hides and a people default", async () => {
		// The check looks only where a party and the caller can meet; the list looks at the whole tree below the caller.
		const sub = await store.createPerson({ name: "Sub", madeBy: ADMIN }, context);
		const deep = await store.createWorkspace(
			{ kind: "things.workspace", name: "Deep", parent: f.session, by: ADMIN },
			context,
		);
		await store.putParty({ workspace: f.session, party: person(sub), source: ADMIN }, context);
		await store.putParty({ workspace: deep, party: person(f.leo), source: ADMIN }, context);
		await store.putParty({ workspace: deep, party: { kind: "agent", session: deep }, source: ADMIN }, context);
		const callers = [f.anna, f.kim, f.leo, sub].map((id) => ({ kind: "person", person: id }) as const);
		const parties: Party[] = [
			...[f.anna, f.kim, f.leo, sub].map(person),
			group(f.kids),
			group(f.parents),
			{ kind: "agent", session: deep },
		];
		const places = [undefined, f.pi, f.family, f.session, deep];
		const agree = async (what: string) => {
			for (const caller of [...callers, { kind: "agent", session: deep } as const]) {
				for (const workspace of places) {
					const at = workspace === undefined ? {} : { workspace };
					const listed = new Set(
						(await store.picker({ ...at, caller, query: "" }, context)).map(({ party }) => partyKey(party)),
					);
					for (const party of parties) {
						const offered = await store.offers({ ...at, caller, party }, context);
						assert.equal(
							offered,
							listed.has(partyKey(party)),
							`${what}: ${JSON.stringify([caller, workspace, party])}`,
						);
					}
				}
			}
		};
		await agree("plain");
		await store.setSwitch(
			{ workspace: f.session, item: { kind: "party", party: group(f.kids) }, shown: false },
			context,
		);
		await store.setSwitch({ workspace: deep, item: { kind: "party", party: person(f.anna) }, shown: false }, context);
		await agree("hides");
		await store.setDefaults({ workspace: f.session, showsPeople: false }, context);
		await agree("people from above hidden in the session");
	});
});

describe("sign-outs", () => {
	it("a removed person's sign-ins that could not end are ended at the next start (Opus S7)", async (t) => {
		t.mock.method(console, "error", () => {});
		await w.host.root(
			async (ctx) =>
				(await ctx.get(SignIns, {})).issue({ principal: principal(f.kim), label: "phone", kind: "browser" }, ctx),
			context,
		);
		signIns.failing = true;
		await store.removePerson({ person: f.kim }, context);
		await eventually(
			() => w.rows("sign-outs").length,
			(n) => n === 1,
		);
		signIns.failing = false;
		await w.reload("@earendil-works/p3-things", context);
		await eventually(
			() => w.rows("sign-outs").length,
			(n) => n === 0,
		);
		assert.equal(signIns.revoked.length, 1);
	});
});

describe("Manage people on a workspace (slice 2's Workspace, slice 3's calls)", () => {
	it("its maker picks, makes a group put in there, writes an invite link; a stranger is not put in", async () => {
		const club = await store.createWorkspace(
			{ kind: "things.workspace", name: "Club", parent: f.family, by: { kind: "person", person: f.anna } },
			context,
		);
		const stranger = await store.createPerson({ name: "Stranger", madeBy: ADMIN }, context);
		await as(f.anna, async (ctx) => {
			const held = await ctx.get(Workspace, { workspace: club });
			const names = (await held.picker!({ query: "" }, ctx)).map(({ name }) => name);
			assert.ok(names.includes("Kim") && !names.includes("Stranger"), JSON.stringify(names));
			const made = await held.makeGroup!({ name: "coaches" }, ctx);
			const { url } = await held.inviteLink!({ name: "Coach", as: "member", group: made }, ctx);
			assert.match(url, /^\/_p3\/invite#[0-9a-f-]+\./);
			await assert.rejects(
				held.putParty!({ party: person(stranger) }, ctx),
				(error: Error & { details?: { message?: { key: string } } }) =>
					error.details?.message?.key === "notOffered",
			);
			const coach = await store.redeemInvite({ secret: url.slice(url.indexOf("#") + 1) }, context);
			const groups = (await store.groupMembers.ofPerson.page({ person: coach!.person }, 10, context)).items;
			assert.deepEqual(
				groups.map(({ group: g }) => g),
				[made],
			);
		});
	});
});

describe("round 2's reproductions (Opus, Astra)", () => {
	const notOffered = (error: Error & { details?: { message?: { key: string } } }) =>
		error.details?.message?.key === "notOffered";

	it("a held group presence follows: gained from above, lost to a hide, gained and lost in Family (Astra 1, Opus 2)", async () => {
		const annex = await store.createPerson({ name: "Annex", madeBy: ADMIN }, context);
		const held = await w.host.get(GroupPresence, { group: f.parents, person: annex }, context);
		try {
			assert.equal(held.present.value, false);
			// Put into the session only: parents, put into Family, is present there from above.
			await store.putParty({ workspace: f.session, party: person(annex), source: ADMIN }, context);
			await until(held.present, (present) => present, within("present from above", context));
			await store.setSwitch(
				{ workspace: f.session, item: { kind: "party", party: group(f.parents) }, shown: false },
				context,
			);
			await until(held.present, (present) => !present, within("hidden in the session", context));
			// Astra's case: placed in Family, where parents is put in.
			await store.putParty({ workspace: f.family, party: person(annex), source: ADMIN }, context);
			await until(held.present, (present) => present, within("present in Family", context));
			await store.removeParty({ workspace: f.family, party: group(f.parents) }, context);
			await until(held.present, (present) => !present, within("parents out of Family", context));
		} finally {
			held.release();
		}
	});

	it("Kim's open hold of a group present for her ends when it leaves Family; a new one is denied (Opus 2)", async () => {
		await as(f.kim, async (ctx) => {
			const held = await ctx.get(Group, { group: f.parents });
			await store.removeParty({ workspace: f.family, party: group(f.parents) }, context);
			await until(held.state, (state) => state.kind !== "live", within("her hold ended", ctx));
			await assert.rejects(ctx.get(Group, { group: f.parents }, { readyTimeout: 1000 }));
		});
	});

	it("an agent names only whom the picker offers it; a named agent is offered by its session's name (Opus 4)", async () => {
		const agent = { kind: "agent", session: f.session } as const;
		await store.putParty({ workspace: f.family, party: agent, source: ADMIN }, context);
		const stranger = await store.createPerson({ name: "Stranger", madeBy: ADMIN }, context);
		const names = (await store.picker({ workspace: f.session, caller: agent, query: "" }, context)).map(
			({ name }) => name,
		);
		assert.deepEqual(names, ["Anna", "kids", "Kim", "parents", "Session"]);
		const source: Source = { kind: "agent", session: f.session };
		await assert.rejects(
			store.putParty({ workspace: f.session, party: person(stranger), source, caller: agent }, context),
			notOffered,
		);
		await assert.rejects(
			store.addToGroup({ group: f.kids, person: stranger, source, caller: agent }, context),
			notOffered,
		);
		await store.putParty({ workspace: f.session, party: person(f.kim), source, caller: agent }, context);
		// Anna is offered the agent in Family, named as its session.
		const anna = { kind: "person", person: f.anna } as const;
		assert.ok(
			(await store.picker({ workspace: f.family, caller: anna, query: "sess" }, context)).some(
				({ party, name }) => party.kind === "agent" && name === "Session",
			),
		);
	});

	it("a thing's last unlink takes a person it made whose only other row is a grant on that thing (Astra 3)", async () => {
		const made = await store.createPerson({ name: "Guest", madeBy: { kind: "thing", thing: f.sketch } }, context);
		const { id } = await (await w.host.get(SignIns, {}, context)).issue(
			{ principal: principal(made), label: "guest", kind: "browser" },
			context,
		);
		await store.setGrants(
			{
				source: ADMIN,
				grants: [{ workspace: f.session, thing: f.sketch, party: person(made), tick: "draw", gives: true }],
			},
			context,
		);
		await store.unlink({ workspace: f.session, thing: f.sketch }, context);
		assert.equal(w.rows("grants").filter((row) => row.thing === f.sketch).length, 0);
		assert.equal((await store.persons.one.page({ person: made }, 1, context)).items.length, 0);
		await until(
			(await w.host.get(SignIns, {}, context)).list,
			(list) => list.length === 0,
			within("the guest's sign-in ended", context),
		);
		assert.deepEqual(signIns.revoked, [id]);
	});

	it("a removed workspace takes its Guests group, its links, and the persons its things made with nothing else (Astra 4, Opus 1)", async () => {
		const club = await store.createWorkspace(
			{ kind: "things.workspace", name: "Club", parent: f.family, by: ADMIN },
			context,
		);
		const share = await store.create({ kind: Board.name, name: "share", workspace: club, by: ADMIN }, context);
		const link = await store.createInvite({ workspace: club, name: "Invitee", as: "guest", by: ADMIN }, context);
		const { person: invitee } = (await store.redeemInvite({ secret: link }, context))!;
		const guests = (await store.groupMembers.ofPerson.page({ person: invitee }, 1, context)).items[0]!.group;
		// The share's persons: one put into Club, one into its Guests group, both by someone else.
		const by: Source = { kind: "thing", thing: share };
		const [inClub, inGuests] = await Promise.all(
			["inClub", "inGuests"].map((name) => store.createPerson({ name, madeBy: by }, context)),
		);
		await store.putParty({ workspace: club, party: person(inClub!), source: ADMIN }, context);
		await store.addToGroup({ group: guests, person: inGuests!, source: ADMIN }, context);
		await store.createInvite({ workspace: club, name: "Later", as: "member", by: ADMIN }, context);
		await store.removeWorkspace({ workspace: club }, context);
		await eventually(
			() => w.rows("things"),
			(rows) => !rows.some((row) => row.thing === club),
		);
		assert.equal((await store.groups.one.page({ group: guests }, 1, context)).items.length, 0);
		assert.ok(!w.rows("group-members").some((row) => row.group === guests));
		assert.ok(!w.rows("invites").some((row) => row.workspace === club));
		const ids = new Set(storedRows(w.path, "persons").map(({ person: id }) => String(id)));
		// The invitee is the link maker's: they stay until their maker goes (people.md §7).
		assert.deepEqual(
			[invitee, inClub!, inGuests!].map((id) => ids.has(id)),
			[true, false, false],
		);
	});

	it("a removed workspace takes a thing's guest whose own thing goes in the same commit; kept when it stays elsewhere (Astra, round 3)", async () => {
		/** Sketch made Guest, Guest made Sheet in the session; `elsewhere`: Sheet linked in Family too. */
		const retire = async (elsewhere: boolean) => {
			const session = await store.createWorkspace(
				{ kind: "things.workspace", name: "Session", parent: f.family, by: ADMIN },
				context,
			);
			const sketch = await store.create(
				{ kind: Board.name, name: "Sketch", workspace: session, by: ADMIN },
				context,
			);
			const guest = await store.createPerson({ name: "Guest", madeBy: { kind: "thing", thing: sketch } }, context);
			const by: Source = { kind: "person", person: guest };
			const sheet = await store.create({ kind: Board.name, name: "Sheet", workspace: session, by }, context);
			if (elsewhere) await store.link({ workspace: f.family, thing: sheet }, context);
			await store.removeWorkspace({ workspace: session }, context);
			await eventually(
				() => w.rows("things"),
				(rows) => !rows.some((row) => row.thing === session),
			);
			assert.deepEqual(
				[sketch, sheet].map((id) => w.rows("things").some((row) => row.thing === id)),
				[false, elsewhere],
			);
			return (await store.persons.one.page({ person: guest }, 1, context)).items.length;
		};
		assert.equal(await retire(false), 0);
		assert.equal(await retire(true), 1);
	});

	it("the adoption takes only the placeholder the first start made, never another owner named alike (Astra 5)", async () => {
		const [placeholder] = (await store.persons.owners.page({}, 10, context)).items.map(({ person: id }) => id);
		const other = await store.createPerson(
			{ name: "Owner", madeBy: { kind: "plugin", plugin: "@earendil-works/p3-things" } },
			context,
		);
		await store.setOwner({ person: other, owner: true }, context);
		await store.adoptOwner({ person: "adopted", name: "Mario" }, context);
		const ids = new Set(storedRows(w.path, "persons").map(({ person: id }) => String(id)));
		assert.deepEqual(
			[other, "adopted", placeholder!].map((id) => ids.has(id)),
			[true, true, false],
		);
	});

	it("a person who made a thing stays with their maker's cleanup (Astra must 4, things.madeByKey)", async () => {
		const share: Source = { kind: "thing", thing: "share-4" };
		const maker = await store.createPerson({ name: "Maker", madeBy: share }, context);
		const by: Source = { kind: "person", person: maker };
		await store.create({ kind: Board.name, name: "theirs", workspace: f.session, by }, context);
		// Their own rows (the maker's grants) taken first: only the thing they made names them.
		await store.deleteEverythingFrom({ source: by }, context);
		await store.deleteEverythingFrom({ source: share }, context);
		assert.ok(storedRows(w.path, "persons").some(({ person: id }) => id === maker));
	});

	it("expired links are swept at each new link and at the start (Opus o7)", async () => {
		const expired = async () =>
			(
				await store.createInvite({ workspace: f.session, name: "x", as: "member", expires: 1, by: ADMIN }, context)
			).split(".")[0]!;
		const has = (invite: string) => w.rows("invites").some((row) => row.invite === invite);
		const first = await expired();
		await new Promise((done) => setTimeout(done, 5));
		await store.createInvite({ workspace: f.session, name: "y", as: "member", by: ADMIN }, context);
		assert.ok(!has(first));
		const second = await expired();
		await new Promise((done) => setTimeout(done, 5));
		await w.reload("@earendil-works/p3-things", context);
		await eventually(
			() => has(second),
			(there) => !there,
		);
	});
});
