// The apps plugin on the server: `AppCatalog` and `AppAccess` per caller, live as a person joins a group or a session
// of an app (plugin tier, beside the real sessions, people, environments, coding and sign-in facets and a test app
// with an object of its own admitted by `admitApp`); and an app added and removed by an apply while a person's catalog
// is open, its `AppEntered` released with it (end to end).

import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	AppAccess,
	AppAdmission,
	AppCatalog,
	admitApp,
	type Ctx,
	constant,
	BACKGROUND_CONTEXT as context,
	defineFacet,
	isChordError,
	type P3Principal,
	People,
	type Reference,
	remote,
	Server,
	str,
	until,
} from "@earendil-works/p3/v1";
import { Apps, PeopleStore, SessionsStore } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin, testServer } from "@earendil-works/p3/v1/testing";
import { within } from "../../../test/until.ts";
import codingServer from "../../coding/server.ts";
import environmentsServer from "../../environments/server.ts";
import peopleServer from "../../people/server.ts";
import sessionsServer from "../../sessions/server.ts";
import signInServer from "../../sign-in/server.ts";
import { AppEntered } from "../entered.ts";

const OWNER: P3Principal = { kind: "owner" };

/** The test app's own object: who the caller is in the club. */
const Board = remote("club.board", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	admission: AppAdmission,
	variants: { owner: { state: { who: str() } }, person: { state: { who: str() } } },
});

/** The test app: its entry in `Apps`, and its object admitted by `admitApp`. */
const clubServer = defineFacet((host, self) => {
	self.contribute(Apps, { id: "club", title: "Club", chrome: "button" });
	host.serve(
		Board,
		(_params, _principal, admitted) =>
			admitted.kind === "owner"
				? { variant: "owner", members: { who: constant("owner") } }
				: { variant: "person", members: { who: constant(admitted.groups.join(",")) } },
		{ admit: admitApp("club") },
	);
});

/** Whether `promise` rejects with a ChordError of `code`. */
async function refused(promise: Promise<unknown>, code = "forbidden"): Promise<void> {
	await assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code);
}

describe("the apps plugin on the server", () => {
	let t: TestedPlugin<P3Principal>;
	beforeEach(async () => {
		t = await testPlugin(
			fileURLToPath(new URL("../", import.meta.url)),
			{
				kind: "server",
				stubs: [
					{ name: "@earendil-works/p3-coding", facet: codingServer },
					{ name: "@earendil-works/p3-environments", facet: environmentsServer },
					{ name: "@earendil-works/p3-people", facet: peopleServer },
					{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
					{ name: "@earendil-works/p3-sign-in", facet: signInServer },
					{ name: "p3-test-club", facet: clubServer },
				],
			},
			context,
		);
	});
	afterEach(() => t.close(context));

	/** Runs `fn` as the server, with the people's and the sessions' stores. */
	const asServer = <T>(
		fn: (
			stores: { readonly people: Reference<typeof PeopleStore>; readonly sessions: Reference<typeof SessionsStore> },
			ctx: Ctx<P3Principal>,
		) => Promise<T>,
	) =>
		t.root(
			async (ctx) => fn({ people: await ctx.get(PeopleStore, {}), sessions: await ctx.get(SessionsStore, {}) }, ctx),
			context,
		);

	it("lists every app for the owner, by title; refuses workers and the server", async () => {
		const titles = await t.root(
			async (ctx) => (await ctx.get(AppCatalog, {})).apps.value.map(({ title }) => title),
			context,
			{ principal: OWNER },
		);
		assert.deepEqual(titles, ["Club", "Coding"]);
		for (const principal of [{ kind: "worker", session: "s" }, { kind: "server" }] satisfies P3Principal[]) {
			await refused(t.root(async (ctx) => ctx.get(AppCatalog, {}), context, { principal }));
		}
	});

	it("lists a person's apps live: through a group of the app, and as a member of one of its sessions", async () => {
		const ann = await asServer(({ people }, ctx) => people.createPerson({ name: "Ann" }, ctx));
		const principal: P3Principal = { kind: "person", id: ann, name: "Ann" };
		await t.root(
			async (ctx) => {
				const catalog = await ctx.get(AppCatalog, {});
				const titles = () => catalog.apps.value.map(({ title }) => title);
				assert.deepEqual(titles(), []);
				const coaches = await asServer(async ({ people }, server) => {
					const group = await people.group({ app: "club", name: "coaches" }, server);
					await people.addToGroup({ group, person: ann }, server);
					return group;
				});
				assert.deepEqual(titles(), ["Club"]);
				const session = await asServer(({ sessions }, server) =>
					sessions.create({ app: "coding", members: [{ kind: "person", id: ann, access: "read" }] }, server),
				);
				await until(catalog.apps, (apps) => apps.length === 2, within("Coding in her catalog", context));
				assert.deepEqual(titles(), ["Club", "Coding"]);
				await asServer(({ sessions }, server) =>
					sessions.removeMember({ session, party: { kind: "person", id: ann } }, server),
				);
				await until(catalog.apps, (apps) => apps.length === 1, within("Coding gone", context));
				await asServer(({ people }, server) => people.removeFromGroup({ group: coaches, person: ann }, server));
				assert.deepEqual(titles(), []);
			},
			context,
			{ principal },
		);
	});

	it("admits an app's own object with who the caller is in the app, live; others are denied", async () => {
		const [ann, coaches] = await asServer(async ({ people }, ctx) => {
			const person = await people.createPerson({ name: "Ann" }, ctx);
			const group = await people.group({ app: "club", name: "coaches" }, ctx);
			await people.addToGroup({ group, person }, ctx);
			return [person, group] as const;
		});
		const principal: P3Principal = { kind: "person", id: ann, name: "Ann" };
		assert.equal(
			await t.root(async (ctx) => (await ctx.get(Board, {})).who.value, context, { principal: OWNER }),
			"owner",
		);
		await t.root(
			async (ctx) => {
				const board = await ctx.get(Board, {});
				assert.deepEqual([board.variant, board.who.value], ["person", "coaches"]);
				await asServer(({ people }, server) => people.removeFromGroup({ group: coaches, person: ann }, server));
				await until(board.state, (state) => state.kind === "failed", within("her board denied", context));
			},
			context,
			{ principal },
		);
		const answer = (asker: P3Principal, caller: string) =>
			t.root(async (ctx) => (await ctx.get(AppAccess, { app: "club", caller })).answer.value, context, {
				principal: asker,
			});
		assert.deepEqual(await answer({ kind: "server" }, `person:${ann}`), { kind: "none" });
		assert.deepEqual(await answer(principal, `person:${ann}`), { kind: "none" });
		assert.deepEqual(await answer({ kind: "server" }, "owner"), { kind: "owner" });
		await refused(answer(principal, "owner"));
		await refused(answer(OWNER, `person:${ann}`));
	});
});

describe("an app added and removed by an apply", () => {
	it("enters and leaves a person's catalog live, and its `AppEntered` is released with it", async () => {
		const t = await testServer({}, context);
		try {
			const owner = await t.client(context);
			const { person } = await (await owner.get(People, {}, context)).invite({ name: "Ann" }, context);
			const ann = await t.client(context, { kind: "person", id: person, name: "Ann" });
			const catalog = await ann.get(AppCatalog, {}, context);
			const file = join(t.userRoot, "extra.server.ts");
			await writeFile(file, EXTRA);
			await until(t.plugins, (marks) => marks.set, within("the new plugin marked", context, 10_000));
			await t.apply(context);
			await t.host.root(async (ctx) => {
				const sessions = await ctx.get(SessionsStore, {});
				await sessions.create({ app: "extra", members: [{ kind: "person", id: person, access: "read" }] }, ctx);
			}, context);
			await until(catalog.apps, (apps) => apps.some(({ id }) => id === "extra"), within("Extra listed", context));
			const entered = t.host.references(AppEntered);
			assert.ok(entered.value.some(({ params }) => params.app === "extra" && params.person === person));
			await rm(file);
			await until(t.plugins, (marks) => marks.set, within("the plugin's removal marked", context, 10_000));
			await t.apply(context);
			await until(catalog.apps, (apps) => apps.length === 0, within("Extra gone", context));
			await until(
				entered,
				(refs) => !refs.some(({ params }) => params.app === "extra"),
				within("its AppEntered released", context),
			);
			assert.deepEqual(t.errors, []);
		} finally {
			await t.close(context);
		}
	});
});

/** A single-file server plugin: an app of its own. */
const EXTRA = `import { defineFacet } from "@earendil-works/p3/v1";
import { Apps } from "@earendil-works/p3/v1/server";
export default defineFacet((_host, self) => self.contribute(Apps, { id: "extra", title: "Extra", chrome: "bar" }));
`;
