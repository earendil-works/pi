// The plugin-tier world the things and following tests share: the sessions plugin on a test host beside its stubs
// (`stubs.ts`), made fresh for each case (`beforeEach`), and helpers that make persons, groups, sessions and things
// and read them back as server code, a writer of a session, a person's own things or a session's worker does.

import assert from "node:assert/strict";
import { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	isChordError,
	type Member,
	MyThings,
	type P3Principal,
	type Reference,
	SESSION_THINGS_WRITES,
	SessionFacts,
	SessionThings,
	type ThingKeeper,
	ThisDevice,
	type With,
} from "@earendil-works/p3/v1";
import { PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { assertGranted } from "../../../test/granted.ts";
import { Boards, HOOKS, STUBS } from "./stubs.ts";

/** A person's principal. */
export type Person = Extract<P3Principal, { kind: "person" }>;

/** `SessionThings`' writer, as a test holds it. */
export type Writer = With<Reference<typeof SessionThings>, (typeof SESSION_THINGS_WRITES)[number]>;

/** `MyThings`, as a test holds it. */
export type Mine = Reference<typeof MyThings>;

/** `SessionFacts`, as a session's worker holds it. */
export type Facts = Reference<typeof SessionFacts>;

/** Sets up a fresh world for each case of the file calling it; answers its helpers. */
export function world() {
	let tested: TestedPlugin<P3Principal> | undefined;
	let owner: Person | undefined;
	// Where the cases' sessions work: this device's machine (made at the Pi's first start), in a folder.
	let here: { environment: string; folder: string } | undefined;
	beforeEach(async () => {
		HOOKS.length = 0;
		tested = await testPlugin(
			fileURLToPath(new URL("../", import.meta.url)),
			{ kind: "server", stubs: STUBS },
			context,
		);
		const [found] = await tested.root(
			async (ctx) => (await (await ctx.get(PeopleStore, {})).persons.owner.page({}, 1, ctx)).items,
			context,
		);
		owner = { kind: "person", id: found!.id, name: found!.name };
		const machine = (await tested.host.get(ThisDevice, {}, context)).machine.value;
		here = { environment: machine, folder: "/tmp/p3-things-test" };
	});
	afterEach(() => tested?.close(context));
	const t = () => tested!;
	const asServer = <T>(fn: (store: Reference<typeof SessionsStore>, ctx: Ctx<P3Principal>) => Promise<T>) =>
		t().root(async (ctx) => fn(await ctx.get(SessionsStore, {}), ctx), context);
	const asWriter = <T>(who: P3Principal, id: string, fn: (things: Writer, ctx: Ctx<P3Principal>) => Promise<T>) =>
		t().root(
			async (ctx) => {
				const things = await ctx.get(SessionThings, { session: id });
				assertGranted(things, ...SESSION_THINGS_WRITES);
				return fn(things, ctx);
			},
			context,
			{ principal: who },
		);
	const asMine = <T>(who: P3Principal, fn: (things: Mine, ctx: Ctx<P3Principal>) => Promise<T>, prefix = "") =>
		t().root(async (ctx) => fn(await ctx.get(MyThings, { view: "v", prefix }), ctx), context, { principal: who });
	const asAgent = <T>(id: string, fn: (facts: Facts, ctx: Ctx<P3Principal>) => Promise<T>) =>
		t().root(async (ctx) => fn(await ctx.get(SessionFacts, {}), ctx), context, {
			principal: { kind: "worker", session: id },
		});
	return {
		t,
		/** The owner's person in this case's Pi (made at its first start). */
		owner: () => owner!,
		asServer,
		asWriter,
		asMine,
		asAgent,
		/** Makes person `name`; their principal. */
		person: async (name: string): Promise<Person> => {
			const id = await t().root(
				async (ctx) => (await ctx.get(PeopleStore, {})).createPerson({ name }, ctx),
				context,
			);
			return { kind: "person", id, name };
		},
		/** Makes group `name` of the coding app with `persons` in it; its id. */
		group: (name: string, ...persons: Person[]): Promise<string> =>
			t().root(async (ctx) => {
				const people = await ctx.get(PeopleStore, {});
				const id = await people.group({ app: "coding", name }, ctx);
				for (const { id: member } of persons) await people.addToGroup({ group: id, person: member }, ctx);
				return id;
			}, context),
		/** A coding session with `writers` (persons who write), `members`, following `follows`, no things; its id. */
		session: (writers: Person[], members: Member[] = [], follows: Member | null = null): Promise<string> => {
			const all = [...writers.map(({ id }) => ({ kind: "person", id, access: "write" }) as const), ...members];
			const followed = follows === null ? null : { kind: follows.kind, id: follows.id };
			return asServer((store, ctx) =>
				store.create({ app: "coding", location: here!, members: all, follows: followed }, ctx),
			);
		},
		/** A board `who` makes into session `id` (content, owned by nobody); its id. */
		content: (who: P3Principal, id: string, name?: string): Promise<string> =>
			asWriter(who, id, (things, ctx) =>
				things.create({ kind: Boards.name, ...(name === undefined ? {} : { name }) }, ctx),
			),
		/** A board `who` makes into session `id` and gives `keeper`; its id. */
		owned: (who: P3Principal, id: string, keeper: ThingKeeper, name?: string): Promise<string> =>
			asWriter(who, id, async (things, ctx) => {
				const thing = await things.create({ kind: Boards.name, ...(name === undefined ? {} : { name }) }, ctx);
				await things.keep({ thing, owner: keeper }, ctx);
				return thing;
			}),
		/** Session `id`'s links: each thing's id, name, owner and who linked it. */
		linksOf: (id: string) =>
			asServer(async (store, ctx) =>
				(await store.links.of.page({ session: id }, 100, ctx)).items.map(({ thing, name, owner: o, by }) => ({
					thing,
					name,
					owner: o,
					by,
				})),
			),
		/** Thing `id`, if it exists. */
		thingRow: (id: string) => asServer(async (store, ctx) => (await store.things.one.page({ id }, 1, ctx)).items[0]),
		/** Whether `promise` rejects with a ChordError of `code`. */
		refused: async (promise: Promise<unknown>, code = "forbidden"): Promise<void> => {
			await assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code);
		},
	};
}
