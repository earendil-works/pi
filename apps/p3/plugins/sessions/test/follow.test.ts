// Following (`follow.ts`, the store's `follow`, base.md "Things"): a session that follows a person or a group has,
// live, every thing of theirs "in all my sessions" (the owner's include the Pi's) while they write in it; it loses
// them when they stop; stopping to follow keeps what it had (linked) unless told otherwise; a followed thing cannot be
// removed but its options can be set; whoever reads a session's things (its info, its worker's facts, the thing
// access answer, its writers) sees the followed ones. The plugin tier (`world.ts`).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CodingTools,
	BACKGROUND_CONTEXT as context,
	SessionInfo,
	Sessions,
	THIS_DEVICE,
	ThingAccess,
} from "@earendil-works/p3/v1";
import { Boards, Logins } from "./stubs.ts";
import { type Person, world } from "./world.ts";

const w = world();

/** A login `who` makes for `owner` in My things (everywhere by default); its id. */
function login(who: Person, owner: Person | { kind: "group"; id: string }, everywhere?: boolean): Promise<string> {
	const keeper = owner.kind === "person" ? { kind: "person" as const, id: owner.id } : owner;
	return w.asMine(who, async (mine, ctx) => {
		const thing = await mine.create({ kind: Logins.name, owner: keeper }, ctx);
		if (everywhere !== undefined) await mine.setEverywhere({ thing, everywhere }, ctx);
		return thing;
	});
}

/**
 * Runs `fn` with session `id`'s info open as the owner: its things' ids and how the session has each, and the name of
 * whom it follows, read live.
 */
function withInfo(
	id: string,
	fn: (things: () => [string, string][], followsName: () => string) => Promise<void>,
): Promise<void> {
	return w.t().root(
		async (ctx) => {
			const info = await ctx.get(SessionInfo, { session: id });
			await fn(
				() => info.things.value.map(({ thing, by }) => [thing, by.kind]),
				() => info.followsName.value,
			);
		},
		context,
		{ principal: w.owner() },
	);
}

/** Waits until `read` gives `expected`. */
async function eventually<T>(read: () => T, expected: T, what: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try {
			assert.deepEqual(read(), expected);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	assert.deepEqual(read(), expected, what);
}

describe("following a person", () => {
	it("has their things in all their sessions, live, while they write; never the others", async () => {
		const ann = await w.person("Ann");
		const mail = await login(ann, ann);
		const quiet = await login(ann, ann, false);
		const id = await w.session([ann], [], { kind: "person", id: ann.id, access: "write" });
		await withInfo(id, async (things, followsName) => {
			assert.deepEqual(things(), [[mail, "followed"]]);
			assert.equal(followsName(), "Ann");
			// Made later, or made everywhere later: shown at once.
			const later = await login(ann, ann);
			await w.asMine(ann, (mine, inner) => mine.setEverywhere({ thing: quiet, everywhere: true }, inner));
			await eventually(() => new Set(things().map(([thing]) => thing)), new Set([mail, later, quiet]), "all three");
			await w.asMine(ann, (mine, inner) => mine.setEverywhere({ thing: mail, everywhere: false }, inner));
			await eventually(() => things().some(([thing]) => thing === mail), false, "mail gone");
		});
	});

	it("the owner brings the Pi's things too, in every session they follow, archived or not", async () => {
		const owner = w.owner();
		const id = await w
			.t()
			.root(
				async (ctx) =>
					(await ctx.get(Sessions, {})).create(
						{ app: "coding", location: { environment: THIS_DEVICE, folder: "/tmp/p3-follow-test" } },
						ctx,
					),
				context,
				{
					principal: owner,
				},
			);
		const tools = await w.asServer(
			async (store, ctx) =>
				(await store.things.ofKind.page({ owner: "pi", kind: CodingTools.name }, 1, ctx)).items[0]!.id,
		);
		await withInfo(id, async (things) => {
			// A session the owner makes follows the owner: it has the Pi's coding tools.
			assert.deepEqual(things(), [[tools, "followed"]]);
			await w.asServer((store, inner) => store.archive({ session: id }, inner));
			// Give a change time to show (none should): the owner writes an archived session too.
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.deepEqual(things(), [[tools, "followed"]], "archived");
			await w.asServer((store, inner) => store.restore({ session: id }, inner));
			await eventually(things, [[tools, "followed"]], "after the archive");
		});
		const row = await w.asServer(async (store, ctx) => (await store.sessions.one.page({ id }, 1, ctx)).items[0]);
		assert.deepEqual(row?.follows, { kind: "person", id: owner.id });
	});

	it("loses their things when they stop writing, and an archive takes a person's away", async () => {
		const ann = await w.person("Ann");
		const mail = await login(ann, ann);
		const id = await w.session([ann], [], { kind: "person", id: ann.id, access: "write" });
		await withInfo(id, async (things) => {
			assert.deepEqual(things(), [[mail, "followed"]]);
			await w.asServer((store, inner) => store.archive({ session: id }, inner));
			await eventually(things, [], "archived");
			await w.asServer((store, inner) => store.restore({ session: id }, inner));
			await eventually(things, [[mail, "followed"]], "restored");
			await w.asServer((store, inner) =>
				store.addMember({ session: id, member: { kind: "person", id: ann.id, access: "read" } }, inner),
			);
			await eventually(things, [], "reads only");
		});
	});

	it("has them while the person writes through a group of theirs", async () => {
		const ann = await w.person("Ann");
		const coaches = await w.group("coaches", ann);
		const mail = await login(ann, ann);
		const id = await w.session([], [{ kind: "group", id: coaches, access: "write" }], {
			kind: "person",
			id: ann.id,
			access: "write",
		});
		await withInfo(id, async (things) => {
			assert.deepEqual(things(), [[mail, "followed"]]);
			await w.asServer((store, inner) =>
				store.removeMember({ session: id, party: { kind: "group", id: coaches } }, inner),
			);
			await eventually(things, [], "the group gone");
		});
	});
});

describe("following a group", () => {
	it("has the group's things in all its sessions while the group writes", async () => {
		const ann = await w.person("Ann");
		const coaches = await w.group("coaches", ann);
		const shared = await login(ann, { kind: "group", id: coaches });
		await login(ann, ann);
		const id = await w.session([ann], [{ kind: "group", id: coaches, access: "write" }], {
			kind: "group",
			id: coaches,
			access: "write",
		});
		await withInfo(id, async (things, followsName) => {
			assert.deepEqual(things(), [[shared, "followed"]]);
			assert.equal(followsName(), "coaches");
		});
		const reads = await w.session([ann], [{ kind: "group", id: coaches, access: "read" }], {
			kind: "group",
			id: coaches,
			access: "write",
		});
		await withInfo(reads, async (things) => assert.deepEqual(things(), []));
	});
});

describe("a followed thing in its session", () => {
	it("cannot be removed there, but its options can be set; the agent and the access answer see it", async () => {
		const ann = await w.person("Ann");
		const board = await w.asServer((store, ctx) =>
			store.createThing({ kind: Boards.name, owner: { kind: "person", id: ann.id } }, ctx),
		);
		const id = await w.session([ann], [], { kind: "person", id: ann.id, access: "write" });
		const draws = () =>
			w.t().root(async (ctx) => {
				const found = (await ctx.get(ThingAccess, { session: id, thing: board, caller: `person:${ann.id}` })).answer
					.value;
				return found.access === "none" ? "none" : (found.options as { draw: boolean }).draw;
			}, context);
		assert.equal(await draws(), true, "its kind's initial");
		await w.asWriter(ann, id, async (things, ctx) => {
			await w.refused(things.remove({ thing: board }, ctx), "invalid");
			await things.setOptions({ thing: board, for: { kind: "everyone" }, options: { draw: false } }, ctx);
		});
		assert.equal(await draws(), false);
		const facts = await w.asAgent(id, async (of) => of.things.value);
		assert.deepEqual(facts, [{ thing: board, kind: Boards.name, name: "", version: 1, options: { draw: false } }]);
		assert.deepEqual(await w.linksOf(id), [], "still not linked");
		// Linked too, without options: the options set here stay; unlinked again, they stay with the followed thing.
		await w.asWriter(ann, id, (things, ctx) => things.add({ thing: board }, ctx));
		assert.equal(await draws(), false, "linked");
		await w.asWriter(ann, id, (things, ctx) => things.remove({ thing: board }, ctx));
		assert.deepEqual(await w.linksOf(id), []);
		assert.equal(await draws(), false, "followed only again");
	});
});

describe("stopping to follow", () => {
	it("links what the session had, with the options set for it, unless told not to keep", async () => {
		const ann = await w.person("Ann");
		const board = await w.asServer((store, ctx) =>
			store.createThing({ kind: Boards.name, owner: { kind: "person", id: ann.id } }, ctx),
		);
		const follows = { kind: "person", id: ann.id, access: "write" } as const;
		const kept = await w.session([ann], [], follows);
		const dropped = await w.session([ann], [], follows);
		await w.asWriter(ann, kept, (things, ctx) =>
			things.setOptions({ thing: board, for: { kind: "everyone" }, options: { draw: false } }, ctx),
		);
		const owner = w.owner();
		await w.t().root(
			async (ctx) => {
				const sessions = await ctx.get(Sessions, {});
				await sessions.follow({ session: kept, follows: null }, ctx);
				await sessions.follow({ session: dropped, follows: null, keep: false }, ctx);
			},
			context,
			{ principal: owner },
		);
		// Linked by the owner who stopped it following.
		assert.deepEqual(
			(await w.linksOf(kept)).map(({ thing, by }) => [thing, by]),
			[[board, { kind: "person", id: owner.id }]],
		);
		assert.deepEqual(await w.linksOf(dropped), []);
		await withInfo(kept, async (things, followsName) => {
			assert.deepEqual(things(), [[board, "person"]]);
			assert.equal(followsName(), "", "nobody");
		});
		const options = await w.asServer(
			async (store, ctx) => (await store.options.of.page({ session: kept, thing: board }, 10, ctx)).items,
		);
		assert.deepEqual(options, [{ thing: board, for: "everyone", version: 1, options: { draw: false } }]);
		await w.refused(
			w.asServer((store, ctx) => store.follow({ session: kept, follows: { kind: "person", id: "nobody" } }, ctx)),
			"invalid",
		);
	});

	it("through the store, links as the app", async () => {
		const ann = await w.person("Ann");
		const mail = await login(ann, ann);
		const id = await w.session([ann], [], { kind: "person", id: ann.id, access: "write" });
		await w.asServer((store, ctx) => store.follow({ session: id, follows: null }, ctx));
		assert.deepEqual(
			(await w.linksOf(id)).map(({ thing, by }) => [thing, by]),
			[[mail, { kind: "app" }]],
		);
	});
});
