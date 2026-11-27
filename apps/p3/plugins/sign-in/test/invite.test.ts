// The invite link's route end to end (`testServer`, with the tests' probe saying what a cookie signs in as): a link
// from `Workspace.inviteLink` signs an anonymous browser in as the person it makes, as a member or a guest, once; a
// browser signed in already is put in as itself and keeps its sign-in; removing the person ends their sign-ins.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	Me,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { type TestServer, testServer } from "@earendil-works/p3/v1/testing";
import { within } from "../../../test/until.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import { Workspace } from "../../things/workspace.ts";

/** The tests' probe plugin, whose route says what a request signed in as. */
const PROBE = fileURLToPath(new URL("../../../test/plugins/probe/", import.meta.url));

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
	/** Runs `fn` with the things store, as server code has it. */
	const things = <T>(fn: (store: Reference<typeof ThingsStore>, ctx: Ctx<P3Principal>) => Promise<T>) =>
		t.host.root(async (ctx) => fn(await ctx.get(ThingsStore, {}), ctx), context);
	/** The owner's Workspace of Pi (the owner has every tick there), and Pi's id. */
	const pi = async () => {
		const id = await things(
			async (store, ctx) => (await store.workspaces.children.page({ parent: "" }, 1, ctx)).items[0]!.workspace,
		);
		const owner = await t.client(context);
		return { id, workspace: await owner.get(Workspace, { workspace: id }, context) };
	};

	it("signs a new person in as a member or a guest, once; a signed-in person is put in and keeps the sign-in", async () => {
		const page = await fetch(`http://127.0.0.1:${t.port}/_p3/invite`);
		assert.ok((await page.text()).includes("location.hash"));
		const { id: root, workspace } = await pi();
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
				as === "member" ? [[root], []] : [[], [true]],
			);
			if (as === "guest") continue;
			// Signed in, the member accepts a guest link too: they are put in themself, no person is made, the browser
			// keeps its sign-in.
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

	it("refuses a token that is no link's; removing the person it signed in ends their sign-ins", async () => {
		const { workspace } = await pi();
		const { url } = await workspace.inviteLink!({ name: "Ann", as: "member" }, context);
		const [invite] = url.slice(url.indexOf("#") + 1).split(".");
		assert.equal((await post(`#${invite}.nonsense`)).status, 403);
		assert.equal((await post("#no-dot")).status, 403);
		const signed = await post(url);
		const cookie = signed.headers.get("set-cookie")!.split(";")[0]!;
		const ann = await principalOf(cookie);
		assert.ok(ann?.kind === "person");
		// A device of hers, with an open link and an object on it.
		const device = await t.client(context, ann);
		const me = await device.get(Me, {}, context);
		assert.deepEqual(me.me.value, { ...ann, owner: false });
		await things((store, ctx) => store.removePerson({ person: ann.id }, ctx));
		await until(me.state, (state) => state.kind !== "live", within("her link closed", context));
		assert.equal(await principalOf(cookie), undefined);
	});
});
