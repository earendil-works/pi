// The sessions plugin's server facet (`testPlugin`, beside the real people, environments, apps, coding and sign-in
// facets and a test kind of thing): a session made in one commit, the store's checks, the access answer per caller
// kind and live, which options apply to whom, migrated or not, a person's list of their sessions, the kinds the owner
// may add, a page's `SessionInfo`, a worker's facts, and every object refusing the principals it does not serve.

import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	isChordError,
	type Member,
	MyThings,
	type P3Principal,
	People,
	type Reference,
	SESSION_THINGS_WRITES,
	SessionAccess,
	SessionFacts,
	SessionInfo,
	Sessions,
	SessionsList,
	SessionThings,
	THIS_DEVICE,
	ThingAccess,
	thingOf,
	until,
	usingThing,
	type With,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { assertGranted } from "../../../test/granted.ts";
import { within } from "../../../test/until.ts";
import { Boards, NOTES, Notes, notesAt, STUBS, setNotes } from "./stubs.ts";

/** The owner's person in this test's Pi (made at its first start), and their caller key. */
let OWNER: Extract<P3Principal, { kind: "person" }>;
let OWNER_KEY: string;

/** Where the tests' sessions work. */
const HERE = { environment: THIS_DEVICE, folder: "/tmp/p3-sessions-test" };

let t: TestedPlugin<P3Principal>;

beforeEach(async () => {
	t = await testPlugin(fileURLToPath(new URL("../", import.meta.url)), { kind: "server", stubs: STUBS }, context);
	const [owner] = await t.root(
		async (ctx) => (await (await ctx.get(PeopleStore, {})).persons.owner.page({}, 1, ctx)).items,
		context,
	);
	OWNER = { kind: "person", id: owner!.id, name: owner!.name };
	OWNER_KEY = `person:${owner!.id}`;
});

afterEach(() => t.close(context));

/** Runs `fn` as the server (the store's caller: apps' server code). */
function asServer<T>(fn: (ctx: Ctx<P3Principal>, store: Awaited<ReturnType<typeof storeOf>>) => Promise<T>) {
	return t.root(async (ctx) => fn(ctx, await storeOf(ctx)), context);
}

/** The sessions store. */
function storeOf(ctx: Ctx<P3Principal>) {
	return ctx.get(SessionsStore, {});
}

/** Makes person `name`; their principal. */
async function person(name: string): Promise<Extract<P3Principal, { kind: "person" }>> {
	const id = await t.root(async (ctx) => (await ctx.get(PeopleStore, {})).createPerson({ name }, ctx), context);
	return { kind: "person", id, name };
}

/** Makes group `name` of the coding app with `persons` in it; its id. */
async function group(name: string, ...persons: { readonly id: string }[]): Promise<string> {
	return t.root(async (ctx) => {
		const people = await ctx.get(PeopleStore, {});
		const id = await people.group({ app: "coding", name }, ctx);
		for (const { id: member } of persons) await people.addToGroup({ group: id, person: member }, ctx);
		return id;
	}, context);
}

/** Makes a coding session with `members` and `things`; its id. */
function session(members: Member[] = [], things = [thingOf(Notes)]): Promise<string> {
	return asServer((ctx, store) => store.create({ app: "coding", location: HERE, members, things }, ctx));
}

/** `SessionThings`' writer, as a test holds it. */
type Writer = With<Reference<typeof SessionThings>, (typeof SESSION_THINGS_WRITES)[number]>;

/** Runs `fn` with `principal`'s writer of session `id`'s things (failing the test for a reader). */
function asWriter<T>(
	principal: P3Principal,
	id: string,
	fn: (things: Writer, ctx: Ctx<P3Principal>) => Promise<T>,
): Promise<T> {
	return t.root(
		async (ctx) => {
			const things = await ctx.get(SessionThings, { session: id });
			assertGranted(things, ...SESSION_THINGS_WRITES);
			return fn(things, ctx);
		},
		context,
		{ principal },
	);
}

/** Whether `promise` rejects with a ChordError of `code`. */
async function refused(promise: Promise<unknown>, code = "forbidden"): Promise<void> {
	await assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code);
}

describe("making a session", () => {
	it("writes the session, its members, its things and their default options in one commit", async () => {
		const ann = await person("Ann");
		const coaches = await group("coaches", ann);
		const id = await t.root(
			async (ctx) =>
				(await ctx.get(Sessions, {})).create(
					{
						app: "coding",
						title: "Plans",
						location: HERE,
						members: [
							{ kind: "person", id: ann.id, access: "read" },
							{ kind: "group", id: coaches, access: "write" },
						],
						things: [thingOf(Boards, { name: "Blue", options: { draw: false } }), thingOf(Boards)],
					},
					ctx,
				),
			context,
			{ principal: OWNER },
		);
		await asServer(async (ctx, store) => {
			const [row] = (await store.sessions.one.page({ id }, 1, ctx)).items;
			assert.deepEqual(
				[row?.title, row?.app, row?.location, row?.state, row?.archivedAt],
				["Plans", "coding", HERE, "settled", null],
			);
			assert.deepEqual((await store.members.of.page({ session: id }, 10, ctx)).items, [
				{ kind: "person", id: ann.id, access: "read" },
				{ kind: "group", id: coaches, access: "write" },
			]);
			const things = (await store.links.of.page({ session: id }, 10, ctx)).items;
			const defaults = (await store.options.ofSession.page({ session: id, for: "everyone" }, 10, ctx)).items;
			const optionsOf = new Map(defaults.map(({ thing, options }) => [thing, options]));
			assert.deepEqual(
				things.map(({ kind, name, owner, by, thing }) => [kind, name, owner, by, optionsOf.get(thing)]),
				[
					["test.boards", "Blue", { kind: "none" }, { kind: "person", id: OWNER.id }, { draw: false }],
					["test.boards", "", { kind: "none" }, { kind: "person", id: OWNER.id }, { draw: true }],
				],
			);
		});
	});

	it("writes nothing when a member, a kind or options are refused", async () => {
		const before = await activeCount();
		const cases = [
			{ members: [{ kind: "person", id: "nobody", access: "read" }] as Member[] },
			{ members: [{ kind: "group", id: "nogroup", access: "read" }] as Member[] },
			{ things: [{ use: "new", kind: "no.kind" } as const] },
			{ things: [thingOf(Notes, { options: { colour: 1 } as unknown as { color: string } })] },
			{ things: [thingOf(Notes, { input: { any: 1 } })] },
			{ things: [usingThing("no-thing")] },
			{ location: { environment: "nowhere", folder: "/" } },
		];
		for (const given of cases) {
			await refused(
				asServer((ctx, store) => store.create({ app: "coding", location: HERE, ...given }, ctx)),
				"invalid",
			);
		}
		await refused(
			asServer((ctx, store) => store.create({ app: "no-app", location: HERE }, ctx)),
			"invalid",
		);
		assert.equal(await activeCount(), before);
	});

	it("works in a private folder of the data directory on this device without a location", async () => {
		const id = await asServer((ctx, store) => store.create({ app: "coding" }, ctx));
		const row = await asServer(async (ctx, store) => (await store.sessions.one.page({ id }, 1, ctx)).items[0]);
		assert.equal(row?.location.environment, THIS_DEVICE);
		assert.match(row!.location.folder, new RegExp(`/folders/${id}$`));
		assert.equal((await stat(row!.location.folder)).mode & 0o777, 0o700);
	});
});

/** How many coding sessions are active. */
function activeCount(): Promise<number> {
	return asServer(async (ctx, store) => (await store.sessions.active.page({ app: "coding" }, 1000, ctx)).items.length);
}

describe("the access answer", () => {
	it("answers each kind of caller", async () => {
		const ann = await person("Ann");
		const id = await session([{ kind: "person", id: ann.id, access: "read" }]);
		const other = await session();
		const access = (caller: string, of = id) =>
			t.root(async (ctx) => (await ctx.get(SessionAccess, { session: of, caller })).access.value, context);
		assert.deepEqual(
			[
				await access(OWNER_KEY),
				await access("server"),
				await access(`worker:${id}`),
				await access(`worker:${other}`),
				await access(`person:${ann.id}`),
				await access(`person:${ann.id}`, other),
				await access("person:nobody"),
				await access(OWNER_KEY, "no-session"),
				await access("nonsense"),
			],
			["write", "write", "write", "none", "read", "none", "none", "none", "none"],
		);
		await asServer((ctx, store) => store.archive({ session: id }, ctx));
		assert.deepEqual(
			[await access(OWNER_KEY), await access("server"), await access(`person:${ann.id}`)],
			["write", "none", "none"],
		);
	});

	it("follows memberships, groups, archives and persons live: the answer changes with the commit", async () => {
		const ann = await person("Ann");
		const coaches = await group("coaches", ann);
		const id = await session([
			{ kind: "person", id: ann.id, access: "read" },
			{ kind: "group", id: coaches, access: "write" },
		]);
		await asServer(async (ctx, store) => {
			const people = await ctx.get(PeopleStore, {});
			const answer = await ctx.get(SessionAccess, { session: id, caller: `person:${ann.id}` });
			assert.equal(answer.access.value, "write", "write wins over read");
			await people.removeFromGroup({ group: coaches, person: ann.id }, ctx);
			assert.equal(answer.access.value, "read");
			await people.addToGroup({ group: coaches, person: ann.id }, ctx);
			await store.removeMember({ session: id, party: { kind: "group", id: coaches } }, ctx);
			assert.equal(answer.access.value, "read");
			await store.addMember({ session: id, member: { kind: "person", id: ann.id, access: "write" } }, ctx);
			assert.equal(answer.access.value, "write", "an added member changes its access");
			await store.archive({ session: id }, ctx);
			assert.equal(answer.access.value, "none");
			await store.restore({ session: id }, ctx);
			assert.equal(answer.access.value, "write");
			await store.removeMember({ session: id, party: { kind: "person", id: ann.id } }, ctx);
			assert.equal(answer.access.value, "none");
			await store.addMember({ session: id, member: { kind: "person", id: ann.id, access: "read" } }, ctx);
			await people.removePerson({ person: ann.id }, ctx);
			assert.equal(answer.access.value, "none", "a removed person");
		});
	});

	it("answers the server and a session's worker about anyone, everyone else about themselves only", async () => {
		const ann = await person("Ann");
		const ben = await person("Ben");
		const id = await session([{ kind: "person", id: ann.id, access: "read" }]);
		const other = await session();
		const ask = (principal: P3Principal, caller: string, of = id) =>
			t.root(async (ctx) => (await ctx.get(SessionAccess, { session: of, caller })).access.value, context, {
				principal,
			});
		assert.equal(await ask(ann, `person:${ann.id}`), "read");
		assert.equal(await ask(OWNER, OWNER_KEY), "write");
		assert.equal(await ask({ kind: "worker", session: id }, `person:${ann.id}`), "read");
		await refused(ask(ben, `person:${ann.id}`));
		await refused(ask(OWNER, `person:${ann.id}`));
		await refused(ask({ kind: "worker", session: other }, `person:${ann.id}`));
		const thing = await firstThing(id);
		await refused(
			t.root(async (ctx) => ctx.get(ThingAccess, { session: id, thing, caller: `person:${ann.id}` }), context, {
				principal: ben,
			}),
		);
	});
});

/** The id of session `id`'s first thing. */
function firstThing(id: string): Promise<string> {
	return asServer(async (ctx, store) => (await store.links.of.page({ session: id }, 1, ctx)).items[0]!.thing);
}

describe("options", () => {
	it("apply the caller's own, else their first group's in member order, else the default; the agent's to the agent", async () => {
		const ann = await person("Ann");
		const ben = await person("Ben");
		const first = await group("first", ann, ben);
		const second = await group("second", ann);
		const id = await session([
			{ kind: "group", id: second, access: "read" },
			{ kind: "group", id: first, access: "read" },
			{ kind: "person", id: ann.id, access: "read" },
		]);
		const thing = await firstThing(id);
		await asServer(async (ctx, store) => {
			const options = async (caller: string) => {
				const found = (await ctx.get(ThingAccess, { session: id, thing, caller })).answer.value;
				return found.access === "none" ? "none" : (found.options as { color: string }).color;
			};
			const set = (by: Parameters<typeof store.setOptions>[0]["for"], options: unknown) =>
				store.setOptions({ session: id, thing, for: by, options }, ctx);
			await set({ kind: "group", id: first }, { color: "green" });
			assert.deepEqual([await options(`person:${ann.id}`), await options(`person:${ben.id}`)], ["green", "green"]);
			await set({ kind: "group", id: second }, { color: "yellow" });
			assert.equal(await options(`person:${ann.id}`), "yellow", "the first group in member order");
			await set({ kind: "person", id: ann.id }, { color: "black" });
			assert.deepEqual([await options(`person:${ann.id}`), await options(`person:${ben.id}`)], ["black", "green"]);
			await set({ kind: "agent" }, { color: "white" });
			assert.deepEqual(
				[await options(`worker:${id}`), await options(OWNER_KEY), await options("server")],
				["white", "red", "red"],
			);
			await set({ kind: "person", id: ann.id }, null);
			assert.equal(await options(`person:${ann.id}`), "yellow", "null removes a member's");
			await set({ kind: "everyone" }, { color: "pink" });
			await set({ kind: "everyone" }, null);
			assert.equal(await options(OWNER_KEY), "red", "null resets the default to the kind's initial");
			await refused(set({ kind: "agent" }, { color: 3 }), "invalid");
			await refused(set({ kind: "person", id: ben.id }, { color: "blue" }), "invalid");
			await store.removeMember({ session: id, party: { kind: "group", id: second } }, ctx);
			assert.equal(await options(`person:${ann.id}`), "green", "a removed member's options go with it");
			await store.removeThing({ session: id, thing }, ctx);
			assert.equal(await options(OWNER_KEY), "none", "a removed thing");
			assert.deepEqual((await store.options.of.page({ session: id, thing }, 10, ctx)).items, []);
		});
	});

	it("are migrated from an older version, and give nothing at a version no migration reads", async () => {
		const id = await session();
		const thing = await firstThing(id);
		await asServer(async (ctx, store) => {
			await store.setOptions({ session: id, thing, for: { kind: "agent" }, options: { color: "blue" } }, ctx);
			const access = await ctx.get(ThingAccess, { session: id, thing, caller: `worker:${id}` });
			setNotes(notesAt(2, (options) => ({ color: `${(options as { color: string }).color}!` })));
			assert.deepEqual(access.answer.value, {
				access: "write",
				kind: Notes.name,
				version: 2,
				options: { color: "blue!" },
			});
			// No migration: the answer keeps the stored version (`admitThing` denies it).
			setNotes(notesAt(3));
			assert.deepEqual(access.answer.value, {
				access: "write",
				kind: Notes.name,
				version: 1,
				options: { color: "blue" },
			});
			setNotes(NOTES);
		});
	});
});

describe("a person's list", () => {
	it("shows only their sessions, direct and through a group, each once, and `more` reaches every one", async () => {
		const ann = await person("Ann");
		const coaches = await group("coaches", ann);
		const mine: string[] = [];
		for (let i = 0; i < 60; i++) {
			const members: Member[] = [{ kind: "group", id: coaches, access: "read" }];
			if (i % 2 === 0) members.push({ kind: "person", id: ann.id, access: "write" });
			mine.push(await session(members, []));
		}
		await session([], []);
		await t.root(
			async (ctx) => {
				const list = await ctx.get(SessionsList, { app: "coding", set: "active", view: "v" });
				const ids = () => list.list.value.rows.map(({ id }) => id);
				assert.ok(ids().length <= 50 && list.list.value.moreAfter);
				assert.equal(new Set(ids()).size, ids().length, "each session once");
				while (list.list.value.moreAfter) await list.more(ctx);
				assert.deepEqual(new Set(ids()), new Set(mine));
				assert.equal(ids().length, 60);
			},
			context,
			{ principal: ann },
		);
	});

	it("follows their groups and an archive live", async () => {
		const ann = await person("Ann");
		const coaches = await group("coaches");
		const id = await session([{ kind: "group", id: coaches, access: "read" }]);
		await t.root(
			async (ctx) => {
				const active = await ctx.get(SessionsList, { app: "coding", set: "active", view: "a" });
				const archived = await ctx.get(SessionsList, { app: "coding", set: "archived", view: "b" });
				assert.equal(active.list.value.rows.length, 0);
				await t.root(
					async (server) =>
						(await server.get(PeopleStore, {})).addToGroup({ group: coaches, person: ann.id }, server),
					context,
				);
				assert.deepEqual(
					active.list.value.rows.map((row) => row.id),
					[id],
				);
				await asServer((server, store) => store.archive({ session: id }, server));
				assert.deepEqual(active.list.value.rows, []);
				assert.deepEqual(
					archived.list.value.rows.map((row) => row.id),
					[id],
				);
			},
			context,
			{ principal: ann },
		);
	});
});

describe("SessionInfo", () => {
	it("shows a member the session, their access, its things and members; a person outside is denied", async () => {
		const ann = await person("Ann");
		const ben = await person("Ben");
		const id = await session([{ kind: "person", id: ann.id, access: "read" }]);
		const info = await t.root(
			async (ctx) => {
				const found = await ctx.get(SessionInfo, { session: id });
				return [found.session.value.id, found.access.value, found.things.value, found.members.value] as const;
			},
			context,
			{ principal: ann },
		);
		assert.deepEqual(info.slice(0, 2), [id, "read"]);
		assert.deepEqual(
			info[2].map(({ kind, options, title }) => [kind, options, title]),
			[[Notes.name, { color: "red" }, "Notes"]],
		);
		assert.deepEqual(info[3], [{ kind: "person", id: ann.id, access: "read", name: "Ann" }]);
		await refused(
			t.root(async (ctx) => ctx.get(SessionInfo, { session: id }, { readyTimeout: 500 }), context, {
				principal: ben,
			}),
		);
	});

	it("names the things by their kind's title and the members by their names, live", async () => {
		const ann = await person("Ann");
		const coaches = await group("coaches");
		const id = await session([
			{ kind: "group", id: coaches, access: "write" },
			{ kind: "person", id: ann.id, access: "read" },
		]);
		await t.root(
			async (ctx) => {
				const info = await ctx.get(SessionInfo, { session: id });
				const names = () => info.members.value.map(({ name }) => name);
				assert.deepEqual(names(), ["coaches", "Ann"]);
				await t.root(async (server) => {
					const people = await server.get(PeopleStore, {});
					await people.renamePerson({ person: ann.id, name: "Anna" }, server);
				}, context);
				assert.deepEqual(names(), ["coaches", "Anna"]);
				const ben = await person("Ben");
				await asServer((server, store) =>
					store.addMember({ session: id, member: { kind: "person", id: ben.id, access: "read" } }, server),
				);
				await until(
					info.members,
					(members) => members.some(({ name }) => name === "Ben"),
					within("Ben's name", context),
				);
				assert.deepEqual(names(), ["coaches", "Anna", "Ben"]);
				setNotes({ ...NOTES, title: "Notebook" });
				assert.deepEqual(
					info.things.value.map(({ title }) => title),
					["Notebook"],
				);
				setNotes(NOTES);
			},
			context,
			{ principal: OWNER },
		);
	});
});

describe("SessionInfo's options", () => {
	it("shows each thing's overrides (the agent's, a member's) live after setOptions, null when unreadable", async () => {
		const ann = await person("Ann");
		const id = await session([{ kind: "person", id: ann.id, access: "write" }]);
		const thing = await firstThing(id);
		await t.root(
			async (ctx) => {
				const info = await ctx.get(SessionInfo, { session: id });
				const sessions = await ctx.get(SessionThings, { session: id });
				assertGranted(sessions, ...SESSION_THINGS_WRITES);
				const shown = () => info.things.value.map(({ options, overrides }) => ({ options, overrides }));
				assert.deepEqual(shown(), [{ options: { color: "red" }, overrides: [] }]);
				await sessions.setOptions({ thing, for: { kind: "person", id: ann.id }, options: { color: "black" } }, ctx);
				await sessions.setOptions({ thing, for: { kind: "agent" }, options: { color: "white" } }, ctx);
				await until(info.things, (things) => things[0]?.overrides.length === 2, within("two overrides", ctx));
				assert.deepEqual(shown(), [
					{
						options: { color: "red" },
						overrides: [
							{ for: { kind: "agent" }, options: { color: "white" } },
							{ for: { kind: "person", id: ann.id }, options: { color: "black" } },
						],
					},
				]);
				// The kind's plugin at another version, without a migration: nothing it reads.
				setNotes(notesAt(2));
				assert.deepEqual(shown(), [
					{
						options: null,
						overrides: [
							{ for: { kind: "agent" }, options: null },
							{ for: { kind: "person", id: ann.id }, options: null },
						],
					},
				]);
				setNotes(NOTES);
				await sessions.setOptions({ thing, for: { kind: "agent" }, options: null }, ctx);
				await until(info.things, (things) => things[0]?.overrides.length === 1, within("one override", ctx));
				assert.deepEqual(info.things.value[0]?.overrides, [
					{ for: { kind: "person", id: ann.id }, options: { color: "black" } },
				]);
			},
			context,
			{ principal: OWNER },
		);
	});
});

describe("refusals", () => {
	it("gives the owner's objects to the owner only, a worker's facts to workers only", async () => {
		const ann = await person("Ann");
		const worker: P3Principal = { kind: "worker", session: "s1" };
		for (const principal of [ann, worker]) {
			await refused(t.root(async (ctx) => ctx.get(Sessions, {}), context, { principal }));
			await refused(t.root(async (ctx) => ctx.get(People, {}), context, { principal }));
		}
		await refused(
			t.root(async (ctx) => ctx.get(SessionsList, { app: "coding", set: "active", view: "v" }), context, {
				principal: worker,
			}),
		);
		for (const principal of [OWNER, ann]) {
			await refused(t.root(async (ctx) => ctx.get(SessionFacts, {}), context, { principal }));
		}
		await refused(
			t.root(async (ctx) => ctx.get(MyThings, { view: "v", prefix: "" }), context, { principal: worker }),
		);
	});
});

describe("a worker's facts", () => {
	it("give its row and its report", async () => {
		const id = await session();
		await t.root(
			async (ctx) => {
				const facts = await ctx.get(SessionFacts, {});
				assert.equal(facts.session.value?.id, id);
				await facts.report({ state: "working" }, ctx);
				assert.equal(facts.session.value?.state, "working");
				assert.deepEqual(await asServer((server, store) => store.working({}, server)), [id]);
			},
			context,
			{ principal: { kind: "worker", session: id } },
		);
		const none = await t.root(async (ctx) => (await ctx.get(SessionFacts, {})).session.value, context, {
			principal: { kind: "worker", session: "unknown" },
		});
		assert.equal(none, null);
	});
});

describe("the owner's person", () => {
	it("writes every session, archived too, and can be a member like anyone, with options of their own", async () => {
		const coaches = await group("coaches", OWNER);
		const notIn = await session();
		const id = await session([{ kind: "group", id: coaches, access: "read" }]);
		await asServer((ctx, store) => store.archive({ session: notIn }, ctx));
		const access = (of: string) =>
			t.root(
				async (ctx) => (await ctx.get(SessionAccess, { session: of, caller: OWNER_KEY })).access.value,
				context,
			);
		assert.deepEqual([await access(notIn), await access(id)], ["write", "write"]);
		const thing = await firstThing(id);
		const color = () =>
			t.root(async (ctx) => {
				const found = (await ctx.get(ThingAccess, { session: id, thing, caller: OWNER_KEY })).answer.value;
				return found.access === "none" ? "none" : (found.options as { color: string }).color;
			}, context);
		await asServer((ctx, store) =>
			store.setOptions(
				{ session: id, thing, for: { kind: "group", id: coaches }, options: { color: "green" } },
				ctx,
			),
		);
		assert.equal(await color(), "green", "their group's");
		await asServer((ctx, store) =>
			store.addMember({ session: id, member: { kind: "person", id: OWNER.id, access: "read" } }, ctx),
		);
		await asServer((ctx, store) =>
			store.setOptions(
				{ session: id, thing, for: { kind: "person", id: OWNER.id }, options: { color: "blue" } },
				ctx,
			),
		);
		assert.equal(await color(), "blue", "their own");
		const list = await t.root(
			async (ctx) =>
				(await ctx.get(SessionsList, { app: "coding", set: "archived", view: "v" })).list.value.rows.map(
					({ id: row }) => row,
				),
			context,
			{ principal: OWNER },
		);
		assert.deepEqual(list, [notIn], "the owner's list is every session of the app");
	});

	it("shows the owner's name and a bringer's live in a session's info; the app's things have none", async () => {
		const ann = await person("Ann");
		const id = await session([
			{ kind: "person", id: OWNER.id, access: "write" },
			{ kind: "person", id: ann.id, access: "write" },
		]);
		const brought = await asWriter(ann, id, async (things, ctx) => {
			const thing = await things.create({ kind: Boards.name }, ctx);
			await things.keep({ thing, owner: { kind: "person", id: ann.id } }, ctx);
			return thing;
		});
		const byOwner = await asWriter(OWNER, id, (things, ctx) => things.create({ kind: Boards.name }, ctx));
		await t.root(
			async (ctx) => {
				const info = await ctx.get(SessionInfo, { session: id });
				const names = () => info.members.value.map(({ name }) => name);
				const byName = () => Object.fromEntries(info.things.value.map(({ thing, byName: name }) => [thing, name]));
				const ownerName = () =>
					Object.fromEntries(info.things.value.map(({ thing, ownerName: name }) => [thing, name]));
				await until(info.things, (things) => things.length === 3, within("the three things", context));
				assert.deepEqual(names(), [OWNER.name, "Ann"]);
				assert.deepEqual(
					[byName()[await firstThing(id)], byName()[brought], byName()[byOwner]],
					["", "Ann", OWNER.name],
				);
				assert.deepEqual([ownerName()[brought], ownerName()[byOwner]], ["Ann", ""]);
				await t.root(async (server) => {
					const people = await server.get(PeopleStore, {});
					await people.renamePerson({ person: OWNER.id, name: "Mario" }, server);
					await people.renamePerson({ person: ann.id, name: "Anna" }, server);
				}, context);
				assert.deepEqual(names(), ["Mario", "Anna"]);
				assert.deepEqual([byName()[brought], byName()[byOwner]], ["Anna", "Mario"]);
				assert.equal(ownerName()[brought], "Anna");
			},
			context,
			{ principal: ann },
		);
	});

	it("is the only person admitted to the owner's objects", async () => {
		const ann = await person("Ann");
		assert.equal(
			await t.root(async (ctx) => (await ctx.get(Sessions, {})).state.value.kind, context, { principal: OWNER }),
			"live",
		);
		await refused(t.root(async (ctx) => ctx.get(Sessions, {}, { readyTimeout: 500 }), context, { principal: ann }));
	});
});
