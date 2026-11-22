// The people plugin on the server: the persons and groups (`PeopleStore`), `Me`, the owner's `People` and
// `PeopleList`, in the plugin tier; the invite link end to end (`testServer`, with the tests' probe saying what a
// cookie signs in as): it signs a browser in as the person, once, and removing the person ends their sign-ins.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	isChordError,
	Me,
	type P3Principal,
	People,
	PeopleList,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { PeopleStore } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, type TestServer, testPlugin, testServer } from "@earendil-works/p3/v1/testing";
import { within } from "../../../test/until.ts";
import signInServer from "../../sign-in/server.ts";

const OWNER: P3Principal = { kind: "owner" };

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
			{ kind: "server", stubs: [{ name: "@earendil-works/p3-sign-in", facet: signInServer }] },
			context,
		);
	});
	afterEach(() => t.close(context));

	/** Runs `fn` with the store, as server code has it. */
	const store = <T>(fn: (people: Reference<typeof PeopleStore>, ctx: Ctx<P3Principal>) => Promise<T>) =>
		t.root(async (ctx) => fn(await ctx.get(PeopleStore, {}), ctx), context);

	it("tells the owner and a person who they are, a person's name live", async () => {
		const id = await store((people, ctx) => people.createPerson({ name: "Ann" }, ctx));
		assert.deepEqual(await t.root(async (ctx) => (await ctx.get(Me, {})).me.value, context, { principal: OWNER }), {
			kind: "owner",
		});
		await t.root(
			async (ctx) => {
				const me = await ctx.get(Me, {});
				assert.deepEqual(me.me.value, { kind: "person", id, name: "Ann" });
				await store((people, server) => people.renamePerson({ person: id, name: "Anna" }, server));
				assert.deepEqual(me.me.value, { kind: "person", id, name: "Anna" });
			},
			context,
			{ principal: { kind: "person", id, name: "Ann" } },
		);
		await refused(t.root(async (ctx) => ctx.get(Me, {}), context, { principal: { kind: "worker", session: "s" } }));
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
				{ id: ann, name: "Ann" },
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
				assert.equal(list.list.value.rows[0]?.name, "p00");
				await list.more(ctx);
				assert.deepEqual([list.list.value.rows.length, list.list.value.moreAfter], [60, false]);
			},
			context,
			{ principal: OWNER },
		);
	});

	it("gives `People` and `PeopleList` to the owner only; an invite's link is a fresh one-time path", async () => {
		for (const principal of [{ kind: "person", id: "p", name: "P" }, { kind: "server" }] satisfies P3Principal[]) {
			await refused(t.root(async (ctx) => ctx.get(People, {}), context, { principal }));
			await refused(t.root(async (ctx) => ctx.get(PeopleList, { view: "v" }), context, { principal }));
		}
		await t.root(
			async (ctx) => {
				const people = await ctx.get(People, {});
				const { person, link } = await people.invite({ name: "Ann" }, ctx);
				assert.match(link, new RegExp(`^/_p3/invite#${person}\\.[A-Za-z0-9_-]{43}$`));
				assert.notEqual(await people.link({ person }, ctx), link);
				await refused(people.link({ person: "none" }, ctx), "invalid");
			},
			context,
			{ principal: OWNER },
		);
	});
});

describe("an invite link", () => {
	let t: TestServer;
	beforeEach(async () => {
		t = await testServer({ plugins: [PROBE] }, context);
	});
	afterEach(() => t.close(context));

	/** Posts `link`'s token as its page does. */
	const post = (link: string) =>
		fetch(`http://127.0.0.1:${t.port}/_p3/invite`, {
			method: "POST",
			headers: { "content-type": "application/json" },
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
		assert.deepEqual(me.me.value, ann);
		await people.remove({ person }, context);
		assert.equal(await principalOf(cookie), undefined);
		await until(me.state, (state) => state.kind !== "live", within("her link closed", context));
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
