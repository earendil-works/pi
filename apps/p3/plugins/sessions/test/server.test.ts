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
	type P3Principal,
	People,
	SessionAccess,
	SessionFacts,
	SessionInfo,
	Sessions,
	SessionsList,
	THIS_DEVICE,
	ThingAccess,
	ThingKindCatalog,
	thingOf,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { NOTES, Notes, notesAt, STUBS, setNotes } from "./stubs.ts";

const OWNER: P3Principal = { kind: "owner" };

/** Where the tests' sessions work. */
const HERE = { environment: THIS_DEVICE, folder: "/tmp/p3-sessions-test" };

let t: TestedPlugin<P3Principal>;

beforeEach(async () => {
	t = await testPlugin(fileURLToPath(new URL("../", import.meta.url)), { kind: "server", stubs: STUBS }, context);
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
						things: [thingOf(Notes, { color: "blue" }), thingOf(Notes)],
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
			const things = (await store.things.of.page({ session: id }, 10, ctx)).items;
			assert.deepEqual(
				things.map(({ kind, ref, options }) => [kind, ref, options]),
				[
					["test.notes", "", { color: "blue" }],
					["test.notes", "", { color: "red" }],
				],
			);
		});
	});

	it("writes nothing when a member, a kind or options are refused", async () => {
		const before = await activeCount();
		const cases = [
			{ members: [{ kind: "person", id: "nobody", access: "read" }] as Member[] },
			{ members: [{ kind: "group", id: "nogroup", access: "read" }] as Member[] },
			{ things: [{ kind: "no.kind" }] },
			{ things: [{ kind: Notes.name, options: { colour: 1 } }] },
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
				await access("owner"),
				await access("server"),
				await access(`worker:${id}`),
				await access(`worker:${other}`),
				await access(`person:${ann.id}`),
				await access(`person:${ann.id}`, other),
				await access("person:nobody"),
				await access("owner", "no-session"),
				await access("nonsense"),
			],
			["write", "write", "write", "none", "read", "none", "none", "none", "none"],
		);
		await asServer((ctx, store) => store.archive({ session: id }, ctx));
		assert.deepEqual(
			[await access("owner"), await access("server"), await access(`person:${ann.id}`)],
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
		assert.equal(await ask(OWNER, "owner"), "write");
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
	return asServer(async (ctx, store) => (await store.things.of.page({ session: id }, 1, ctx)).items[0]!.thing);
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
				[await options(`worker:${id}`), await options("owner"), await options("server")],
				["white", "red", "red"],
			);
			await set({ kind: "person", id: ann.id }, null);
			assert.equal(await options(`person:${ann.id}`), "yellow", "null removes a member's");
			await set({ kind: "everyone" }, { color: "pink" });
			await set({ kind: "everyone" }, null);
			assert.equal(await options("owner"), "red", "null resets the default to the kind's initial");
			await refused(set({ kind: "agent" }, { color: 3 }), "invalid");
			await refused(set({ kind: "person", id: ben.id }, { color: "blue" }), "invalid");
			await store.removeMember({ session: id, party: { kind: "group", id: second } }, ctx);
			assert.equal(await options(`person:${ann.id}`), "green", "a removed member's options go with it");
			await store.removeThing({ session: id, thing }, ctx);
			assert.equal(await options("owner"), "none", "a removed thing");
			assert.deepEqual((await store.options.of.page({ session: id, thing }, 10, ctx)).items, []);
		});
	});

	it("are migrated from an older version, and give nothing at a version no migration reads", async () => {
		const id = await session();
		const thing = await firstThing(id);
		await asServer(async (ctx, store) => {
			await store.setOptions({ session: id, thing, for: { kind: "agent" }, options: { color: "blue" } }, ctx);
			const access = await ctx.get(ThingAccess, { session: id, thing, caller: `worker:${id}` });
			const facts = async () =>
				t.root(async (worker) => (await worker.get(SessionFacts, {})).things.value, context, {
					principal: { kind: "worker", session: id },
				});
			setNotes(notesAt(2, (options) => ({ color: `${(options as { color: string }).color}!` })));
			assert.deepEqual(access.answer.value, {
				access: "write",
				kind: Notes.name,
				ref: "",
				version: 2,
				options: { color: "blue!" },
			});
			assert.deepEqual(await facts(), [
				{ thing, kind: Notes.name, ref: "", version: 2, options: { color: "blue!" } },
			]);
			// No migration: the agent gets nothing, and the answer keeps the stored version (`admitThing` denies it).
			setNotes(notesAt(3));
			assert.deepEqual(access.answer.value, {
				access: "write",
				kind: Notes.name,
				ref: "",
				version: 1,
				options: { color: "blue" },
			});
			assert.deepEqual(await facts(), [{ thing, kind: Notes.name, ref: "", version: 1, options: null }]);
			// A migration whose result the schema refuses gives nothing either.
			setNotes(notesAt(2, () => ({ color: 7 }) as unknown as { color: string }));
			assert.deepEqual(await facts(), [{ thing, kind: Notes.name, ref: "", version: 1, options: null }]);
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
			info[2].map(({ kind, options }) => [kind, options]),
			[[Notes.name, { color: "red" }]],
		);
		assert.deepEqual(info[3], [{ kind: "person", id: ann.id, access: "read" }]);
		await refused(
			t.root(async (ctx) => ctx.get(SessionInfo, { session: id }, { readyTimeout: 500 }), context, {
				principal: ben,
			}),
		);
	});
});

describe("refusals", () => {
	it("gives the owner's objects to the owner only, a worker's facts to workers only", async () => {
		const ann = await person("Ann");
		const worker: P3Principal = { kind: "worker", session: "s1" };
		for (const principal of [ann, worker]) {
			await refused(t.root(async (ctx) => ctx.get(Sessions, {}), context, { principal }));
			await refused(t.root(async (ctx) => ctx.get(ThingKindCatalog, {}), context, { principal }));
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
	});
});

describe("the kinds of things", () => {
	it("are listed for the owner by title, live as a kind's plugin changes", async () => {
		await t.root(
			async (ctx) => {
				const catalog = await ctx.get(ThingKindCatalog, {});
				assert.deepEqual(catalog.kinds.value, [{ kind: Notes.name, title: "Notes" }]);
				setNotes({ ...NOTES, title: "A note" });
				assert.deepEqual(catalog.kinds.value, [{ kind: Notes.name, title: "A note" }]);
				setNotes(NOTES);
			},
			context,
			{ principal: OWNER },
		);
	});
});

describe("a worker's facts", () => {
	it("give its row, its things with the agent's options, and its report", async () => {
		const id = await session();
		const thing = await firstThing(id);
		await t.root(
			async (ctx) => {
				const facts = await ctx.get(SessionFacts, {});
				assert.equal(facts.session.value?.id, id);
				assert.deepEqual(facts.things.value, [
					{ thing, kind: Notes.name, ref: "", version: 1, options: { color: "red" } },
				]);
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
