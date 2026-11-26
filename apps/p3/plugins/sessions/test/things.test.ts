// Things as owned records (`things.ts`, `facts.ts`, the store's thing writes; base.md "Things"): how things of a kind
// come to exist (content in a session, a person's in My things with its input and hooks, a plugin's in server code);
// who manages a thing; giving it an owner; the same thing in two sessions with options of their own; a thing nobody
// owns gone with its last link; a person's own things (`MyThings`) and the sessions a thing is in (`ThingUses`); what
// the agent makes; members and persons leaving. The plugin tier (`world.ts`).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BACKGROUND_CONTEXT as context,
	SessionInfo,
	Sessions,
	SessionThings,
	ThingAccess,
	type ThingUse,
	ThingUses,
	thingOf,
	usingThing,
} from "@earendil-works/p3/v1";
import { PeopleStore } from "@earendil-works/p3/v1/server";
import { Board, Boards, HOOKS, Logins, Notes } from "./stubs.ts";
import { world } from "./world.ts";

const w = world();

describe("making a thing", () => {
	it("makes content into the session, owned by nobody and linked by its maker; its kind's `create` runs after", async () => {
		const ann = await w.person("Ann");
		const id = await w.session([ann]);
		const board = await w.asWriter(ann, id, async (things, ctx) => {
			// Only the kinds of content are made in a session.
			assert.deepEqual(things.kinds.value, [{ kind: Boards.name, title: "Board" }]);
			return things.create({ kind: Boards.name, name: "Plan" }, ctx);
		});
		assert.deepEqual(await w.linksOf(id), [
			{ thing: board, name: "Plan", owner: { kind: "none" }, by: { kind: "person", id: ann.id } },
		]);
		assert.deepEqual(HOOKS, [{ hook: "create", id: board, name: "Plan", owner: "none", input: undefined }]);
		assert.equal((await w.thingRow(board))?.everywhere, false);
		// Its object admits by the thing's id: a writer whose options say draw is a drawer.
		const variant = await w
			.t()
			.root(
				async (ctx) =>
					(await ctx.get(Board, { session: id, thing: board })).granted.has("draw") ? "drawer" : "viewer",
				context,
				{
					principal: ann,
				},
			);
		assert.equal(variant, "drawer");
	});

	it("refuses in a session what is not content: a person's kind", async () => {
		const ann = await w.person("Ann");
		const id = await w.session([ann]);
		await w.asWriter(ann, id, async (things, ctx) => {
			await w.refused(things.create({ kind: Logins.name }, ctx));
			await w.refused(things.create({ kind: Notes.name }, ctx));
			await w.refused(things.create({ kind: "no.kind" }, ctx), "invalid");
		});
		await w.asMine(ann, async (mine, ctx) => {
			await w.refused(mine.create({ kind: Boards.name, owner: { kind: "person", id: ann.id } }, ctx));
		});
		assert.deepEqual(await w.linksOf(id), []);
	});

	it("makes a person's kind in My things for them, their group or (the owner) the Pi, everywhere, with its input", async () => {
		const ann = await w.person("Ann");
		const ben = await w.person("Ben");
		const coaches = await w.group("coaches", ann);
		const login = await w.asMine(ann, async (mine, ctx) => {
			assert.deepEqual(mine.kinds.value, [{ kind: Logins.name, title: "Login" }]);
			assert.deepEqual(mine.owners.value, [
				{ owner: { kind: "person", id: ann.id }, name: "Ann" },
				{ owner: { kind: "group", id: coaches }, name: "coaches" },
			]);
			await mine.create({ kind: Logins.name, owner: { kind: "group", id: coaches }, input: { secret: "g" } }, ctx);
			await w.refused(mine.create({ kind: Logins.name, owner: { kind: "person", id: ben.id } }, ctx));
			await w.refused(mine.create({ kind: Logins.name, owner: { kind: "pi" } }, ctx));
			return mine.create(
				{ kind: Logins.name, name: "Mail", owner: { kind: "person", id: ann.id }, input: { secret: "s" } },
				ctx,
			);
		});
		assert.deepEqual(
			HOOKS.filter(({ hook }) => hook === "create").map((hook) => (hook.hook === "create" ? hook.input : null)),
			[{ secret: "g" }, { secret: "s" }],
		);
		const row = await w.thingRow(login);
		assert.deepEqual([row?.name, row?.owner, row?.everywhere], ["Mail", { kind: "person", id: ann.id }, true]);
		await w.asMine(w.owner(), (mine, ctx) => mine.create({ kind: Logins.name, owner: { kind: "pi" } }, ctx));
	});

	it("refuses input its kind does not take or its schema refuses; a failing `create` leaves no thing", async () => {
		const ann = await w.person("Ann");
		const me = { kind: "person", id: ann.id } as const;
		await w.asMine(ann, async (mine, ctx) => {
			await w.refused(mine.create({ kind: Logins.name, owner: me, input: { secret: 1 } }, ctx), "invalid");
			await assert.rejects(
				mine.create({ kind: Logins.name, owner: me, input: { secret: "fail" } }, ctx),
				/no login today/,
			);
		});
		const made = HOOKS.find(({ hook }) => hook === "create");
		assert.equal(await w.thingRow(made!.id), undefined, "deleted again");
		assert.ok(HOOKS.some(({ hook, id }) => hook === "delete" && id === made!.id));
		// Server code is trusted with any kind, but not with input a kind does not take.
		await w.refused(
			w.asServer((store, ctx) => store.createThing({ kind: Boards.name, owner: me, input: { secret: "s" } }, ctx)),
			"invalid",
		);
	});

	it("makes a plugin's thing once (`ensureThing`), everywhere; `createThing` outside a session is everywhere too", async () => {
		const pi = { kind: "pi" } as const;
		const first = await w.asServer((store, ctx) =>
			store.ensureThing({ kind: Notes.name, owner: pi, name: "N" }, ctx),
		);
		const again = await w.asServer((store, ctx) => store.ensureThing({ kind: Notes.name, owner: pi }, ctx));
		assert.equal(again, first);
		assert.equal((await w.thingRow(first))?.everywhere, true);
		const made = await w.asServer((store, ctx) => store.createThing({ kind: Notes.name, owner: pi }, ctx));
		assert.equal((await w.thingRow(made))?.everywhere, true);
	});

	it("gives a reader no writer", async () => {
		const ann = await w.person("Ann");
		const id = await w.session([], [{ kind: "person", id: ann.id, access: "read" }]);
		const variant = await w
			.t()
			.root(
				async (ctx) =>
					(await ctx.get(SessionThings, { session: id })).granted.has("create") ? "writer" : "reader",
				context,
				{ principal: ann },
			);
		assert.equal(variant, "reader");
	});

	it("makes a session's new things and links existing ones in its create", async () => {
		const pis = await w.asServer((store, ctx) => store.createThing({ kind: Notes.name, owner: { kind: "pi" } }, ctx));
		const id = await w.t().root(
			async (ctx) =>
				(await ctx.get(Sessions, {})).create(
					{
						app: "coding",
						location: { environment: "this-device", folder: "/tmp" },
						things: [thingOf(Boards, { name: "Sketch" }), usingThing(pis, { color: "blue" })],
						follows: null,
					},
					ctx,
				),
			context,
			{ principal: w.owner() },
		);
		assert.deepEqual(
			(await w.linksOf(id)).map(({ name, owner, by }) => [name, owner.kind, by]),
			[
				["Sketch", "none", { kind: "person", id: w.owner().id }],
				["", "pi", { kind: "person", id: w.owner().id }],
			],
		);
		assert.deepEqual(
			await w.asServer(
				async (store, ctx) => (await store.options.of.page({ session: id, thing: pis }, 10, ctx)).items,
			),
			[{ thing: pis, for: "everyone", version: 1, options: { color: "blue" } }],
		);
	});

	it("makes only content, owned by nobody, in the owner's create; any kind and owner through the store", async () => {
		const owner = w.owner();
		const location = { environment: "this-device", folder: "/tmp" };
		const make = (things: ThingUse[]) =>
			w
				.t()
				.root(
					async (ctx) => (await ctx.get(Sessions, {})).create({ app: "coding", location, things }, ctx),
					context,
					{
						principal: owner,
					},
				);
		await w.refused(make([thingOf(Notes)]));
		await w.refused(make([thingOf(Logins)]));
		await w.refused(make([{ use: "new", kind: Boards.name, owner: { kind: "pi" } }]));
		await make([{ use: "new", kind: Boards.name, owner: { kind: "none" } }]);
		const id = await w.asServer((store, ctx) =>
			store.create(
				{ app: "coding", location, things: [{ use: "new", kind: Notes.name, owner: { kind: "pi" } }] },
				ctx,
			),
		);
		assert.deepEqual(
			(await w.linksOf(id)).map(({ owner: o }) => o),
			[{ kind: "pi" }],
		);
	});
});

describe("a session's size", () => {
	it("holds 1000 things: a write that links a 1001st is refused before it commits; a removal makes room", async () => {
		const ann = await w.person("Ann");
		const location = { environment: "this-device", folder: "/tmp" };
		const full = Array.from({ length: 1000 }, () => thingOf(Boards));
		const holds = /a session holds 1000 things/;
		await assert.rejects(
			w.asServer((store, ctx) => store.create({ app: "coding", location, things: [...full, thingOf(Boards)] }, ctx)),
			holds,
		);
		const mail = await w.asMine(ann, (mine, ctx) =>
			mine.create({ kind: Logins.name, owner: { kind: "person", id: ann.id } }, ctx),
		);
		const id = await w.asServer((store, ctx) =>
			store.create(
				{
					app: "coding",
					location,
					members: [{ kind: "person", id: ann.id, access: "write" }],
					things: full,
					follows: { kind: "person", id: ann.id },
				},
				ctx,
			),
		);
		const other = await w.asServer((store, ctx) =>
			store.createThing({ kind: Notes.name, owner: { kind: "person", id: ann.id } }, ctx),
		);
		await w.asWriter(ann, id, async (things, ctx) => {
			await assert.rejects(things.create({ kind: Boards.name }, ctx), holds);
			await assert.rejects(things.add({ thing: other }, ctx), holds);
		});
		await assert.rejects(
			w.asServer((store, ctx) => store.createThing({ kind: Notes.name, session: id, owner: { kind: "pi" } }, ctx)),
			holds,
		);
		await assert.rejects(
			w.asServer((store, ctx) => store.addThing({ session: id, thing: other }, ctx)),
			holds,
		);
		// Stopping to follow, keeping the login, would link a 1001st.
		await assert.rejects(
			w.asServer((store, ctx) => store.follow({ session: id, follows: null }, ctx)),
			holds,
		);
		const links = await w.asServer(
			async (store, ctx) => (await store.links.of.page({ session: id }, 1001, ctx)).items,
		);
		assert.equal(links.length, 1000);
		// Its things read whole: the 1000 linked and the two it has from Ann (both "in all her sessions").
		const shown = await w
			.t()
			.root(async (ctx) => (await ctx.get(SessionInfo, { session: id })).things.value, context, {
				principal: ann,
			});
		assert.equal(shown.length, 1002);
		assert.ok(shown.some(({ thing }) => thing === mail));
		assert.ok(shown.some(({ thing }) => thing === other));
		await w.asWriter(ann, id, async (things, ctx) => {
			await things.remove({ thing: links[0]!.thing }, ctx);
			await things.add({ thing: other }, ctx);
			await assert.rejects(things.create({ kind: Boards.name }, ctx), holds);
		});
	});
});

describe("who manages a thing", () => {
	it("any writer of a session that uses it while nobody owns it; once kept, its owner and the owner of the Pi", async () => {
		const ann = await w.person("Ann");
		const ben = await w.person("Ben");
		const id = await w.session([ann, ben]);
		const board = await w.content(ann, id);
		await w.asWriter(ben, id, async (things, ctx) => {
			await things.rename({ thing: board, name: "Ben's name" }, ctx);
			await things.setOptions({ thing: board, for: { kind: "everyone" }, options: { draw: false } }, ctx);
			// Nobody gives a thing to someone else.
			await w.refused(things.keep({ thing: board, owner: { kind: "person", id: ann.id } }, ctx));
		});
		await w.asWriter(ann, id, async (things, ctx) => {
			assert.deepEqual(things.owners.value, [{ owner: { kind: "person", id: ann.id }, name: "Ann" }]);
			await things.keep({ thing: board, owner: { kind: "person", id: ann.id } }, ctx);
		});
		const kept = await w.thingRow(board);
		assert.deepEqual([kept?.owner, kept?.everywhere], [{ kind: "person", id: ann.id }, false]);
		// Given on, an owned thing keeps its switch.
		await w.asMine(ann, (mine, ctx) => mine.setEverywhere({ thing: board, everywhere: true }, ctx));
		await w.asWriter(ben, id, async (things, ctx) => {
			await w.refused(things.rename({ thing: board, name: "x" }, ctx));
			await w.refused(things.setOptions({ thing: board, for: { kind: "everyone" }, options: { draw: true } }, ctx));
			await w.refused(things.remove({ thing: board }, ctx));
			await w.refused(things.delete({ thing: board }, ctx));
			await w.refused(things.keep({ thing: board, owner: { kind: "person", id: ben.id } }, ctx));
		});
		await w.asWriter(ann, id, (things, ctx) => things.rename({ thing: board, name: "Ann's" }, ctx));
		await w.asWriter(w.owner(), id, (things, ctx) => things.keep({ thing: board, owner: { kind: "pi" } }, ctx));
		assert.equal((await w.thingRow(board))?.everywhere, true, "still everywhere");
		await w.asWriter(ann, id, (things, ctx) => w.refused(things.rename({ thing: board, name: "mine?" }, ctx)));
		assert.equal((await w.thingRow(board))?.name, "Ann's");
	});

	it("a group's members manage the group's things; others do not", async () => {
		const ann = await w.person("Ann");
		const ben = await w.person("Ben");
		const coaches = await w.group("coaches", ann);
		const id = await w.session([ann, ben]);
		const board = await w.owned(ann, id, { kind: "group", id: coaches });
		await w.asWriter(ben, id, (things, ctx) => w.refused(things.rename({ thing: board, name: "x" }, ctx)));
		await w
			.t()
			.root(
				async (ctx) => (await ctx.get(PeopleStore, {})).addToGroup({ group: coaches, person: ben.id }, ctx),
				context,
			);
		await w.asWriter(ben, id, (things, ctx) => things.rename({ thing: board, name: "Coaches' board" }, ctx));
		assert.equal((await w.thingRow(board))?.name, "Coaches' board");
	});

	it("links an owned thing the caller manages into another session they write; never another's, never nobody's", async () => {
		const ann = await w.person("Ann");
		const ben = await w.person("Ben");
		const first = await w.session([ann, ben]);
		const second = await w.session([ann, ben]);
		const owned = await w.owned(ann, first, { kind: "person", id: ann.id });
		const content = await w.content(ann, first);
		await w.asWriter(ben, second, async (things, ctx) => {
			await w.refused(things.add({ thing: owned }, ctx));
			await w.refused(things.add({ thing: content }, ctx));
		});
		await w.asWriter(ann, second, async (things, ctx) => {
			await w.refused(things.add({ thing: content }, ctx));
			await things.add({ thing: owned }, ctx);
			await w.refused(things.add({ thing: owned }, ctx), "invalid");
		});
		assert.deepEqual(
			(await w.linksOf(second)).map(({ thing }) => thing),
			[owned],
		);
	});
});

describe("the same thing in two sessions", () => {
	it("has options of its own in each, one name everywhere, and goes from both with its delete", async () => {
		const ann = await w.person("Ann");
		const first = await w.session([ann]);
		const second = await w.session([ann]);
		const board = await w.owned(ann, first, { kind: "person", id: ann.id }, "Shared");
		await w.asWriter(ann, second, (things, ctx) => things.add({ thing: board, options: { draw: false } }, ctx));
		const draws = (of: string) =>
			w.t().root(async (ctx) => {
				const found = (await ctx.get(ThingAccess, { session: of, thing: board, caller: `person:${ann.id}` })).answer
					.value;
				return found.access === "none" ? "none" : (found.options as { draw: boolean }).draw;
			}, context);
		assert.deepEqual([await draws(first), await draws(second)], [true, false]);
		await w.t().root(
			async (ctx) => {
				const infos = [
					await ctx.get(SessionInfo, { session: first }),
					await ctx.get(SessionInfo, { session: second }),
				];
				await w.asWriter(ann, second, (things, inner) => things.rename({ thing: board, name: "Renamed" }, inner));
				assert.deepEqual(
					infos.map((info) => info.things.value[0]?.name),
					["Renamed", "Renamed"],
				);
			},
			context,
			{ principal: ann },
		);
		await w.asWriter(ann, first, (things, ctx) => things.remove({ thing: board }, ctx));
		assert.notEqual(await w.thingRow(board), undefined, "an owned thing outlives its links");
		await w.asWriter(ann, second, (things, ctx) => things.delete({ thing: board }, ctx));
		assert.equal(await w.thingRow(board), undefined);
		assert.deepEqual([await w.linksOf(first), await w.linksOf(second)], [[], []]);
		assert.ok(HOOKS.some(({ hook, id }) => hook === "delete" && id === board));
	});

	it("a thing nobody owns is gone with its last link, its content with it", async () => {
		const ann = await w.person("Ann");
		const first = await w.session([ann]);
		const second = await w.session([ann]);
		const board = await w.content(ann, first);
		// An app's server code links it on (persons do not take nobody's things elsewhere).
		await w.asServer((store, ctx) => store.addThing({ session: second, thing: board }, ctx));
		await w.asWriter(ann, first, (things, ctx) => things.remove({ thing: board }, ctx));
		assert.notEqual(await w.thingRow(board), undefined, "still used by the second session");
		assert.ok(!HOOKS.some(({ hook }) => hook === "delete"));
		await w.asWriter(ann, second, (things, ctx) => things.remove({ thing: board }, ctx));
		assert.equal(await w.thingRow(board), undefined);
		assert.ok(HOOKS.some(({ hook, id }) => hook === "delete" && id === board));
	});
});

describe("a person's own things", () => {
	it("lists theirs, their groups' and for the owner the Pi's, by owner and name, searchable; renames, gives away, deletes", async () => {
		const ann = await w.person("Ann");
		const ben = await w.person("Ben");
		const coaches = await w.group("coaches", ann);
		const make = (
			who: typeof ann,
			name: string,
			owner: { kind: "person"; id: string } | { kind: "group"; id: string } | { kind: "pi" },
		) => w.asMine(who, (mine, ctx) => mine.create({ kind: Logins.name, name, owner }, ctx));
		const mine = await make(ann, "Apples", { kind: "person", id: ann.id });
		await make(ann, "Avocados", { kind: "group", id: coaches });
		await make(ann, "Bananas", { kind: "person", id: ann.id });
		await make(w.owner(), "Pears", { kind: "pi" });
		const id = await w.session([ann]);
		await w.content(ann, id, "Nobody's");
		assert.deepEqual(
			await w.asMine(ann, async (things) => [...new Set(things.list.value.rows.map(({ title }) => title))]),
			["Login"],
			"each with its kind's title",
		);
		const names = (who: typeof ann, prefix: string) =>
			w.asMine(who, async (things) => things.list.value.rows.map(({ name }) => name), prefix);
		assert.deepEqual(await names(ann, ""), ["Avocados", "Apples", "Bananas"]);
		assert.deepEqual(await names(ann, "A"), ["Avocados", "Apples"]);
		assert.ok((await names(w.owner(), "")).includes("Pears"));
		assert.deepEqual(await names(ben, ""), []);
		await w.asMine(ann, async (things, ctx) => {
			await things.rename({ thing: mine, name: "Apricots" }, ctx);
			await things.setEverywhere({ thing: mine, everywhere: false }, ctx);
			await w.refused(things.keep({ thing: mine, owner: { kind: "person", id: ben.id } }, ctx));
			await things.keep({ thing: mine, owner: { kind: "group", id: coaches } }, ctx);
			await things.delete({ thing: mine }, ctx);
		});
		assert.equal(await w.thingRow(mine), undefined);
		// The Pi's things are the owner's to manage.
		const [pears] = await w.asServer(
			async (store, ctx) => (await store.things.owned.page({ owners: ["pi"], prefix: "P" }, 1, ctx)).items,
		);
		await w.refused(w.asMine(ann, (things, ctx) => things.rename({ thing: pears!.id, name: "x" }, ctx)));
		await w.refused(
			w.asMine(ann, (things, ctx) => things.setEverywhere({ thing: pears!.id, everywhere: false }, ctx)),
		);
	});

	it("lists the sessions a thing is in for whoever manages it, and denies anyone else", async () => {
		const ann = await w.person("Ann");
		const ben = await w.person("Ben");
		const first = await w.session([ann]);
		const second = await w.session([ann]);
		const board = await w.owned(ann, first, { kind: "person", id: ann.id });
		await w.asWriter(ann, second, (things, ctx) => things.add({ thing: board }, ctx));
		const uses = await w
			.t()
			.root(async (ctx) => (await ctx.get(ThingUses, { thing: board, view: "v" })).list.value.rows, context, {
				principal: ann,
			});
		assert.deepEqual(new Set(uses.map(({ session }) => session)), new Set([first, second]));
		await w.refused(
			w.t().root(async (ctx) => ctx.get(ThingUses, { thing: board, view: "v" }, { readyTimeout: 500 }), context, {
				principal: ben,
			}),
		);
	});
});

describe("members and persons leaving", () => {
	it("a member removed takes the links of the things they own; the session's content stays", async () => {
		const ann = await w.person("Ann");
		const coaches = await w.group("coaches", ann);
		const id = await w.session([ann], [{ kind: "group", id: coaches, access: "write" }]);
		const hers = await w.owned(ann, id, { kind: "person", id: ann.id });
		const theirs = await w.owned(ann, id, { kind: "group", id: coaches });
		const content = await w.content(ann, id);
		await w.asServer((store, ctx) => store.removeMember({ session: id, party: { kind: "group", id: coaches } }, ctx));
		assert.deepEqual(
			(await w.linksOf(id)).map(({ thing }) => thing),
			[hers, content],
		);
		await w.asServer((store, ctx) => store.removeMember({ session: id, party: { kind: "person", id: ann.id } }, ctx));
		assert.deepEqual(
			(await w.linksOf(id)).map(({ thing }) => thing),
			[content],
		);
		assert.notEqual(await w.thingRow(hers), undefined, "unlinked, still hers");
		assert.notEqual(await w.thingRow(theirs), undefined);
	});

	it("a person removed from the Pi takes the things they own, with their content; their groups' stay", async () => {
		const ann = await w.person("Ann");
		const coaches = await w.group("coaches", ann);
		const id = await w.session([ann]);
		const hers = await w.owned(ann, id, { kind: "person", id: ann.id });
		const theirs = await w.owned(ann, id, { kind: "group", id: coaches });
		await w.t().root(async (ctx) => (await ctx.get(PeopleStore, {})).removePerson({ person: ann.id }, ctx), context);
		assert.equal(await w.thingRow(hers), undefined);
		assert.notEqual(await w.thingRow(theirs), undefined);
		assert.ok(HOOKS.some(({ hook, id: gone }) => hook === "delete" && gone === hers));
		assert.deepEqual(
			(await w.linksOf(id)).map(({ thing }) => thing),
			[theirs],
		);
	});
});
