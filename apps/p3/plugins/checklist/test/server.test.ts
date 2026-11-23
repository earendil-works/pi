// The checklist plugin on the server (`testPlugin`, beside the real sessions, people, environments, apps, coding and
// sign-in facets): a writer makes a checklist in a session (content), a checker adds and ticks items, a reader and a
// writer whose options say no check read only, an option downgrade turns a holder into a reader at once, a tick of an
// unknown item says so, a full checklist refuses a 501st item, a person outside is denied, and a deleted checklist
// keeps no items.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	isChordError,
	type Member,
	type P3Principal,
	type Reference,
	SessionThings,
	THIS_DEVICE,
	until,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { within } from "../../../test/until.ts";
import appsServer from "../../apps/server.ts";
import codingServer from "../../coding/server.ts";
import environmentsServer from "../../environments/server.ts";
import peopleServer from "../../people/server.ts";
import sessionsServer from "../../sessions/server.ts";
import signInServer from "../../sign-in/server.ts";
import { Checklist, ChecklistKind } from "../contract.ts";
import { ChecklistStore } from "../server.ts";

/** A person's principal. */
type Person = Extract<P3Principal, { kind: "person" }>;

/** `Checklist` as a test holds it. */
type ChecklistRef = Reference<typeof Checklist>;

/** The owner's person in this test's Pi (made at its first start). */
let OWNER: Person;

/** Where the tests' sessions work. */
const HERE = { environment: THIS_DEVICE, folder: "/tmp/p3-checklist-test" };

let t: TestedPlugin<P3Principal>;

beforeEach(async () => {
	t = await testPlugin(
		fileURLToPath(new URL("../", import.meta.url)),
		{
			kind: "server",
			stubs: [
				{ name: "@earendil-works/p3-apps", facet: appsServer },
				{ name: "@earendil-works/p3-coding", facet: codingServer },
				{ name: "@earendil-works/p3-environments", facet: environmentsServer },
				{ name: "@earendil-works/p3-people", facet: peopleServer },
				{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
				{ name: "@earendil-works/p3-sign-in", facet: signInServer },
			],
		},
		context,
	);
	const [owner] = await t.root(
		async (ctx) => (await (await ctx.get(PeopleStore, {})).persons.owner.page({}, 1, ctx)).items,
		context,
	);
	OWNER = { kind: "person", id: owner!.id, name: owner!.name };
});

afterEach(() => t.close(context));

/** Makes person `name`; their principal. */
async function person(name: string): Promise<Person> {
	const id = await t.root(async (ctx) => (await ctx.get(PeopleStore, {})).createPerson({ name }, ctx), context);
	return { kind: "person", id, name };
}

/** A coding session with Ann (writes), Ben (reads) and Cleo (writes), and a checklist Ann made there. */
async function setup() {
	const ann = await person("Ann");
	const ben = await person("Ben");
	const cleo = await person("Cleo");
	const members: Member[] = [
		{ kind: "person", id: ann.id, access: "write" },
		{ kind: "person", id: ben.id, access: "read" },
		{ kind: "person", id: cleo.id, access: "write" },
	];
	const id = await t.root(
		async (ctx) => (await ctx.get(SessionsStore, {})).create({ app: "coding", location: HERE, members }, ctx),
		context,
	);
	const thing = await managing(ann, id, (things, ctx) =>
		things.create({ kind: ChecklistKind.name, name: "Groceries" }, ctx),
	);
	return { ann, ben, cleo, id, thing };
}

/** Runs `fn` with `principal`'s writer of session `id`'s things, failing the test for a reader. */
function managing<T>(
	principal: P3Principal,
	id: string,
	fn: (things: Extract<Reference<typeof SessionThings>, { variant: "writer" }>, ctx: Ctx<P3Principal>) => Promise<T>,
): Promise<T> {
	return t.root(
		async (ctx) => {
			const things = await ctx.get(SessionThings, { session: id });
			if (things.variant !== "writer") return assert.fail(things.variant);
			return fn(things, ctx);
		},
		context,
		{ principal },
	);
}

/** Runs `fn` with `principal`'s `Checklist` of thing `thing` of session `id`. */
function holding<T>(
	principal: P3Principal,
	id: string,
	thing: string,
	fn: (list: ChecklistRef, ctx: Ctx<P3Principal>) => Promise<T>,
): Promise<T> {
	return t.root(async (ctx) => fn(await ctx.get(Checklist, { session: id, thing }), ctx), context, { principal });
}

/** The checker of `list`, failing the test for a reader. */
function checkerOf(list: ChecklistRef) {
	if (list.variant !== "checker") return assert.fail(`a ${list.variant}`);
	return list;
}

/** `list`'s variant now (a reference's variant changes with its admission). */
function variantOf(list: ChecklistRef): string {
	return list.variant;
}

/** Whether `promise` rejects with a ChordError of `code`. */
async function refused(promise: Promise<unknown>, code = "forbidden"): Promise<void> {
	await assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code);
}

describe("a checklist", () => {
	it("lets a checker add and tick items, which a reader and a writer without check only read", async () => {
		const { ann, ben, cleo, id, thing } = await setup();
		await managing(OWNER, id, (things, ctx) =>
			things.setOptions({ thing, for: { kind: "person", id: cleo.id }, options: { check: false } }, ctx),
		);
		const milk = await holding(ann, id, thing, async (list, ctx) => {
			const checker = checkerOf(list);
			const added = await checker.add({ text: "milk" }, ctx);
			await checker.add({ text: "bread" }, ctx);
			await checker.tick({ id: added, done: true }, ctx);
			return added;
		});
		for (const reader of [ben, cleo]) {
			const seen = await holding(reader, id, thing, async (list) => [list.variant, list.items.value] as const);
			assert.deepEqual(seen[0], "reader");
			assert.deepEqual(
				seen[1].map(({ id: item, text, done }) => [item === milk, text, done]),
				[
					[true, "milk", true],
					[false, "bread", false],
				],
			);
		}
	});

	it("says so when a tick names an unknown item, and refuses a 501st item", async () => {
		const { ann, id, thing } = await setup();
		await holding(ann, id, thing, async (list, ctx) => {
			const checker = checkerOf(list);
			await assert.rejects(
				checker.tick({ id: "nope", done: true }, ctx),
				(error: unknown) =>
					isChordError(error) && error.code === "invalid" && error.message.includes("no item nope"),
			);
			for (let i = 0; i < 500; i++) await checker.add({ text: `item ${i}` }, ctx);
			await assert.rejects(
				checker.add({ text: "one too many" }, ctx),
				(error: unknown) => isChordError(error) && error.message.includes("a checklist holds 500 items"),
			);
			assert.equal(list.items.value.length, 500);
			assert.equal(list.items.value[0]?.text, "item 0");
		});
	});

	it("turns a holder into a reader the moment its options say no check", async () => {
		const { ann, id, thing } = await setup();
		await holding(ann, id, thing, async (list, ctx) => {
			assert.equal(list.variant, "checker");
			await managing(OWNER, id, (things, inner) =>
				things.setOptions({ thing, for: { kind: "everyone" }, options: { check: false } }, inner),
			);
			await until(
				list.state,
				(state) => state.kind === "live" && variantOf(list) === "reader",
				within("the reader", ctx),
			);
		});
	});

	it("is denied to a person outside the session, and keeps no items once deleted", async () => {
		const { ann, id, thing } = await setup();
		const dana = await person("Dana");
		await refused(
			t.root(async (ctx) => ctx.get(Checklist, { session: id, thing }, { readyTimeout: 500 }), context, {
				principal: dana,
			}),
		);
		await holding(ann, id, thing, (list, ctx) => checkerOf(list).add({ text: "gone soon" }, ctx));
		await managing(ann, id, (things, ctx) => things.delete({ thing }, ctx));
		const stored = await t.root(
			async (ctx) => (await (await ctx.get(ChecklistStore, {})).items.of.page({ checklist: thing }, 10, ctx)).items,
			context,
		);
		assert.deepEqual(stored, []);
		await refused(
			t.root(async (ctx) => ctx.get(Checklist, { session: id, thing }, { readyTimeout: 500 }), context, {
				principal: ann,
			}),
		);
	});
});
