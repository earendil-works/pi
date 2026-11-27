// The people plugin on the server: the persons and groups (`PeopleStore`), `Me`, the owner's `People` and
// `PeopleList`, in the plugin tier; the invite link end to end (`testServer`, with the tests' probe saying what a
// cookie signs in as): it signs a browser in as the person, once, and removing the person ends their sign-ins; a things
// invite link (`Workspace.inviteLink`) is redeemed through the same route, as a member and as a guest.

import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	isChordError,
	Me,
	OwnerAccess,
	type P3Principal,
	People,
	PeopleList,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { PeopleStore } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, type TestServer, testPlugin, testServer } from "@earendil-works/p3/v1/testing";
import { eventually, within } from "../../../test/until.ts";
import appsServer from "../../apps/server.ts";
import environmentsServer from "../../environments/server.ts";
import sessionsServer from "../../sessions/server.ts";
import signInServer from "../../sign-in/server.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import { Workspace } from "../../things/workspace.ts";

/** The tests' probe plugin, whose route says what a request signed in as. */
const PROBE = fileURLToPath(new URL("../../../test/plugins/probe/", import.meta.url));

/** Whether `promise` rejects with a ChordError of `code`. */
async function refused(promise: Promise<unknown>, code = "forbidden"): Promise<void> {
	await assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === code);
}

describe("the people plugin on the server", () => {
	let t: TestedPlugin<P3Principal>;
	beforeEach(async () => {
		t = await testPlugin(
			fileURLToPath(new URL("../", import.meta.url)),
			{
				kind: "server",
				// What a person's removal reaches besides the people: their sign-ins and their sessions.
				stubs: [
					{ name: "@earendil-works/p3-apps", facet: appsServer },
					{ name: "@earendil-works/p3-environments", facet: environmentsServer },
					{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
					{ name: "@earendil-works/p3-sign-in", facet: signInServer },
				],
			},
			context,
		);
	});
	afterEach(() => t.close(context));

	/** Runs `fn` with the store, as server code has it. */
	const store = <T>(fn: (people: Reference<typeof PeopleStore>, ctx: Ctx<P3Principal>) => Promise<T>) =>
		t.root(async (ctx) => fn(await ctx.get(PeopleStore, {}), ctx), context);
	/** The owner's person, as a principal. */
	const owner = () =>
		store(async (people, ctx) => {
			const [found] = (await people.persons.owner.page({}, 1, ctx)).items;
			return { kind: "person", id: found!.id, name: found!.name } satisfies P3Principal;
		});

	it("makes the owner's person at the first start, once, named after the OS user; never removes it", async () => {
		const owners = await store(async (people, ctx) => (await people.persons.all.page({}, 10, ctx)).items);
		const user = userInfo().username;
		assert.deepEqual(owners, [{ id: owners[0]!.id, name: `${user[0]!.toUpperCase()}${user.slice(1)}`, owner: true }]);
		await refused(
			store((people, ctx) => people.removePerson({ person: owners[0]!.id }, ctx)),
			"invalid",
		);
		const me = await owner();
		await refused(
			t.root(async (ctx) => (await ctx.get(People, {})).link({ person: me.id }, ctx), context, { principal: me }),
			"invalid",
		);
	});

	it("admits the owner to the owner's objects, live from their row, and refuses everyone else", async () => {
		const me = await owner();
		const ann = await store((people, ctx) => people.createPerson({ name: "Ann" }, ctx));
		const annP: P3Principal = { kind: "person", id: ann, name: "Ann" };
		assert.equal(
			await t.root(async (ctx) => (await ctx.get(People, {})).state.value.kind, context, { principal: me }),
			"live",
		);
		const ask = (principal: P3Principal, caller: string) =>
			t.root(async (ctx) => (await ctx.get(OwnerAccess, { caller })).owner.value, context, { principal });
		assert.deepEqual(
			[
				await ask(me, `person:${me.id}`),
				await ask(annP, `person:${ann}`),
				await ask({ kind: "worker", session: "s" }, `person:${me.id}`),
				await ask({ kind: "server" }, "server"),
			],
			[true, false, true, false],
		);
		await refused(ask(annP, `person:${me.id}`));
		for (const principal of [annP, { kind: "worker", session: "s" }, { kind: "server" }] satisfies P3Principal[]) {
			await refused(t.root(async (ctx) => ctx.get(People, {}, { readyTimeout: 500 }), context, { principal }));
			await refused(
				t.root(async (ctx) => ctx.get(PeopleList, { view: "v" }, { readyTimeout: 500 }), context, { principal }),
			);
		}
	});

	it("tells the owner, a person and a session's agent who they are, a rename live; refuses the server", async () => {
		const id = await store((people, ctx) => people.createPerson({ name: "Ann" }, ctx));
		const me = await owner();
		await t.root(
			async (ctx) => {
				const mine = await ctx.get(Me, {});
				assert.deepEqual(mine.me.value, { kind: "person", id: me.id, name: me.name, owner: true });
				await store((people, server) => people.renamePerson({ person: me.id, name: "Mario" }, server));
				assert.deepEqual(mine.me.value, { kind: "person", id: me.id, name: "Mario", owner: true });
			},
			context,
			{ principal: me },
		);
		await t.root(
			async (ctx) => {
				const mine = await ctx.get(Me, {});
				assert.deepEqual(mine.me.value, { kind: "person", id, name: "Ann", owner: false });
				await store((people, server) => people.renamePerson({ person: id, name: "Anna" }, server));
				assert.deepEqual(mine.me.value, { kind: "person", id, name: "Anna", owner: false });
			},
			context,
			{ principal: { kind: "person", id, name: "Ann" } },
		);
		const agent = await t.root(async (ctx) => (await ctx.get(Me, {})).me.value, context, {
			principal: { kind: "worker", session: "s" },
		});
		assert.deepEqual(agent, { kind: "agent", session: "s" });
		await refused(t.root(async (ctx) => ctx.get(Me, {}), context, { principal: { kind: "server" } }));
	});

	it("makes an app's group once per name, and removes a removed person from every group", async () => {
		await store(async (people, ctx) => {
			const ann = await people.createPerson({ name: "Ann" }, ctx);
			const coaches = await people.group({ app: "club", name: "coaches" }, ctx);
			assert.equal(await people.group({ app: "club", name: "coaches" }, ctx), coaches);
			const other = await people.group({ app: "family", name: "coaches" }, ctx);
			assert.notEqual(other, coaches);
			await people.addToGroup({ group: coaches, person: ann }, ctx);
			await people.addToGroup({ group: other, person: ann }, ctx);
			await refused(people.addToGroup({ group: "none", person: ann }, ctx), "invalid");
			await refused(people.addToGroup({ group: coaches, person: "none" }, ctx), "invalid");
			assert.deepEqual(
				(await people.groups.ofApp.page({ app: "club" }, 10, ctx)).items.map(({ name }) => name),
				["coaches"],
			);
			assert.deepEqual((await people.members.of.page({ group: coaches }, 10, ctx)).items, [
				{ id: ann, name: "Ann", owner: false },
			]);
			assert.equal((await people.groups.ofPerson.page({ person: ann }, 10, ctx)).items.length, 2);
			await people.removePerson({ person: ann }, ctx);
			assert.deepEqual((await people.groups.ofPerson.page({ person: ann }, 10, ctx)).items, []);
			assert.deepEqual((await people.members.of.page({ group: coaches }, 10, ctx)).items, []);
			assert.deepEqual((await people.persons.one.page({ id: ann }, 1, ctx)).items, []);
		});
	});

	it("lists the owner's persons by name, a page at a time", async () => {
		await store(async (people, ctx) => {
			for (let i = 0; i < 60; i++) await people.createPerson({ name: `p${String(i).padStart(2, "0")}` }, ctx);
		});
		await t.root(
			async (ctx) => {
				const list = await ctx.get(PeopleList, { view: "v" });
				assert.deepEqual([list.list.value.rows.length, list.list.value.moreAfter], [50, true]);
				// By name, the owner's person ("Badlogic" here) first: capitals sort first.
				assert.equal(
					list.list.value.rows.some(({ owner }) => owner),
					true,
				);
				await list.more(ctx);
				// The owner's person among them.
				assert.deepEqual([list.list.value.rows.length, list.list.value.moreAfter], [61, false]);
			},
			context,
			{ principal: await owner() },
		);
	});

	it("makes an invite's link a fresh one-time path", async () => {
		await t.root(
			async (ctx) => {
				const people = await ctx.get(People, {});
				const { person, link } = await people.invite({ name: "Ann" }, ctx);
				assert.match(link, new RegExp(`^/_p3/invite#${person}\\.[A-Za-z0-9_-]{43}$`));
				assert.notEqual(await people.link({ person }, ctx), link);
				await refused(people.link({ person: "none" }, ctx), "invalid");
			},
			context,
			{ principal: await owner() },
		);
	});
});

describe("an invite link", () => {
	let t: TestServer;
	beforeEach(async () => {
		t = await testServer({ plugins: [PROBE] }, context);
	});
	afterEach(() => t.close(context));

	/** Posts `link`'s token as its page does (from a browser signed in with `cookie`, if given). */
	const post = (link: string, cookie?: string) =>
		fetch(`http://127.0.0.1:${t.port}/_p3/invite`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) },
			body: JSON.stringify({ token: link.slice(link.indexOf("#") + 1) }),
		});
	/** The principal a browser with `cookie` signs in as, or `undefined`. */
	const principalOf = async (cookie: string): Promise<P3Principal | undefined> => {
		const answer = await fetch(`http://127.0.0.1:${t.port}/_probe/principal`, { headers: { cookie } });
		return answer.status === 401 ? undefined : ((await answer.json()) as P3Principal);
	};

	it("signs a browser in as the person, once; removing the person ends their sign-ins and links", async () => {
		const owner = await t.client(context);
		const people = await owner.get(People, {}, context);
		const { person, link } = await people.invite({ name: "Ann" }, context);
		const page = await fetch(`http://127.0.0.1:${t.port}/_p3/invite`);
		assert.ok((await page.text()).includes("location.hash"));
		const signed = await post(link);
		assert.equal(signed.status, 200);
		assert.equal((await post(link)).status, 403, "used up");
		const cookie = signed.headers.get("set-cookie")!.split(";")[0]!;
		const ann = { kind: "person", id: person, name: "Ann" } as const;
		assert.deepEqual(await principalOf(cookie), ann);
		// A device of hers, with an open link and an object on it.
		const device = await t.client(context, ann);
		const me = await device.get(Me, {}, context);
		assert.deepEqual(me.me.value, { ...ann, owner: false });
		await people.remove({ person }, context);
		assert.equal(await principalOf(cookie), undefined);
		await until(me.state, (state) => state.kind !== "live", within("her link closed", context));
	});

	it("redeems a things invite link (Workspace.inviteLink) as a member and as a guest, once (ERNDL-1144 push A)", async () => {
		const owner = await t.client(context);
		const things = <T>(fn: (store: Reference<typeof ThingsStore>, ctx: Ctx<P3Principal>) => Promise<T>) =>
			t.host.root(async (ctx) => fn(await ctx.get(ThingsStore, {}), ctx), context);
		const pi = await things(
			async (store, ctx) => (await store.workspaces.children.page({ parent: "" }, 1, ctx)).items[0]!.workspace,
		);
		// The owner is the things store's owner once the bridge adopted them (when it went live): every tick in Pi.
		const workspace = await eventually(() => owner.get(Workspace, { workspace: pi }, context));
		for (const as of ["member", "guest"] as const) {
			const { url } = await workspace.inviteLink!({ name: `Ann the ${as}`, as }, context);
			const signed = await post(url);
			assert.equal(signed.status, 200);
			assert.equal((await post(url)).status, 403, "used up");
			const principal = await principalOf(signed.headers.get("set-cookie")!.split(";")[0]!);
			assert.equal(principal?.kind === "person" && principal.name, `Ann the ${as}`);
			const id = principal?.kind === "person" ? principal.id : "";
			const entries = await things(
				async (store, ctx) =>
					(await store.workspaceMembers.where.page({ partyKey: `person/${id}` }, 10, ctx)).items,
			);
			const groups = await things(
				async (store, ctx) => (await store.groupMembers.ofPerson.page({ person: id }, 10, ctx)).items,
			);
			// A member has an entry of their own in Pi; a guest only a membership in Pi's outside Guests group.
			assert.deepEqual(
				[entries.map(({ workspace: at }) => at), groups.map(({ outside }) => outside)],
				as === "member" ? [[pi], []] : [[], [true]],
			);
			if (as === "guest") continue;
			// Signed in, the member accepts a guest link too: they are put in themself, no person is made, the browser
			// keeps its sign-in (Astra, round 3).
			const cookie = signed.headers.get("set-cookie")!.split(";")[0]!;
			const persons = () => things(async (store, ctx) => (await store.persons.all.page({}, 20, ctx)).items.length);
			const before = await persons();
			const next = await workspace.inviteLink!({ name: "already here", as: "guest" }, context);
			const again = await post(next.url, cookie);
			assert.equal(again.status, 200);
			assert.equal(again.headers.get("set-cookie"), null);
			assert.equal(await persons(), before, "no new person");
			const mine = await things(
				async (store, ctx) => (await store.groupMembers.ofPerson.page({ person: id }, 10, ctx)).items,
			);
			assert.deepEqual(
				mine.map(({ outside }) => outside),
				[true],
			);
		}
	});

	it("refuses a token that is not the person's current one", async () => {
		const owner = await t.client(context);
		const people = await owner.get(People, {}, context);
		const { person, link } = await people.invite({ name: "Ann" }, context);
		await people.link({ person }, context);
		assert.equal((await post(link)).status, 403, "replaced by a fresh link");
		assert.equal((await post(`#${person}.nonsense`)).status, 403);
		assert.equal((await post("#no-dot")).status, 403);
	});
});

describe("the owner's person", () => {
	it("exists after the first start, once also after a restart, and the owner link signs in as them", async () => {
		const first = await testServer({}, context);
		let t = first;
		try {
			const owners = async () =>
				(await t.host.root(async (ctx) => (await ctx.get(PeopleStore, {})).persons.all.page({}, 10, ctx), context))
					.items;
			const [before] = await owners();
			assert.equal(before?.owner, true);
			const me = (await (await t.client(context)).get(Me, {}, context)).me.value;
			assert.deepEqual(me, { kind: "person", id: before!.id, name: before!.name, owner: true });
			t = await first.restart(context);
			assert.deepEqual(await owners(), [before]);
		} finally {
			await t.close(context);
		}
	});
});
