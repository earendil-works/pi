// A link's sign-in (`link.ts`) against the person it signs in, and the invite route's order of issuing and redeeming,
// on a host of their own with the HTTP component (no listener), the things plugin and a stand-in signer: a sign-in
// issued for a person a removal took is revoked, so none outlives a removal however the two interleave; a signer that
// fails spends no invite link.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHttp } from "@earendil-works/chord/http";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	BACKGROUND_CONTEXT as context,
	createHost,
	defineFacet,
	type HostError,
	openStore,
	type P3Principal,
	Server,
	sqliteBackend,
} from "@earendil-works/p3/v1";
import { Http, type HttpRequest } from "@earendil-works/p3/v1/server";
import { eventually } from "../../../test/until.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import { RUNTIME, signInsStub, THINGS } from "../../things/test/world.ts";
import { INVITE_PATH, SignIns } from "../contract.ts";
import { serveInvite } from "../invite.ts";
import { answer, issue } from "../link.ts";

/** A host with the HTTP component, the things plugin, the stand-in signer and the invite route; close it after. */
async function signInHost() {
	const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(":memory:")), context);
	const errors: HostError[] = [];
	const host = createHost<P3Principal>({
		address: Server(),
		principal: { kind: "server" },
		store,
		onError: (error) => errors.push(error),
	});
	const http = createHttp(host, { onError: () => {} }, context);
	const signer = signInsStub();
	const loaded = await host.load(
		[
			{ name: "chord.http", facet: http.facet },
			THINGS,
			RUNTIME,
			signer.plugin,
			{ name: "test.invite", facet: defineFacet((h) => serveInvite(h)) },
		],
		context,
	);
	assert.deepEqual(loaded.failed, []);
	const things = await host.get(ThingsStore, {}, context);
	const by = { kind: "plugin", plugin: "test" } as const;
	/** The person ids with a sign-in now. */
	const signedIn = async () =>
		(await host.get(SignIns, {}, context)).list.value.map(({ principal }) =>
			principal.kind === "person" ? principal.id : "",
		);
	/** An anonymous browser's post of `token` to the invite route. */
	const post = async (token: string) => {
		const router = (await host.registry(Http, context)).value;
		const match = router.route("POST", INVITE_PATH);
		assert.ok(match !== undefined && match !== "bad_path");
		// What the route reads of a request: its body and where it came from.
		const request = { json: async () => ({ token }), provenance: { kind: "local" } } as unknown as HttpRequest;
		return host.root((ctx) => match.handler(request, ctx), context, { principal: undefined });
	};
	const close = async () => {
		await host.close(context);
		await store.close(context);
	};
	return { host, things, by, signer, signedIn, post, errors, close };
}

/** What `issue` reads of a request: where it came from. */
const LOCAL = { provenance: { kind: "local" } } as unknown as HttpRequest;

describe("a link's sign-in and removal", () => {
	it("a sign-in issued for a person a removal took is revoked; none outlives a removal, whatever the order (Astra)", async () => {
		const at = await signInHost();
		try {
			// Issued after the removal ended the sign-ins it saw: revoked by the issuer, a refusal answered.
			const late = await at.things.createPerson({ name: "Late", madeBy: at.by }, context);
			await at.things.removePerson({ person: late }, context);
			const refused = await at.host.root(
				async (ctx) => answer(await issue({ person: late, name: "Late" }, "test", LOCAL, ctx), late, ctx),
				context,
			);
			assert.deepEqual(refused, { kind: "error", status: 403 });
			assert.ok(!(await at.signedIn()).includes(late));
			// Interleaved: the removal after 0 to 5 turns of the issuance's own.
			for (let turns = 0; turns < 6; turns++) {
				const person = await at.things.createPerson({ name: `P${turns}`, madeBy: at.by }, context);
				const removal = (async () => {
					for (let i = 0; i < turns; i++) await new Promise((done) => setImmediate(done));
					await at.things.removePerson({ person }, context);
				})();
				const signing = at.host.root(
					async (ctx) => answer(await issue({ person, name: "P" }, "test", LOCAL, ctx), person, ctx),
					context,
				);
				await Promise.all([removal, signing]);
				await eventually(
					() => at.signedIn(),
					(ids) => !ids.includes(person),
				);
			}
			assert.deepEqual(at.errors, []);
		} finally {
			await at.close();
		}
	});
});

describe("the invite route and a signer that fails", () => {
	it("spends no link when the signer fails before it issues; the link signs in once it is back (Astra)", async () => {
		const at = await signInHost();
		try {
			const pi = (await at.things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
			const token = await at.things.createInvite({ workspace: pi, name: "Guest", as: "member", by: at.by }, context);
			const persons = async () => (await at.things.persons.all.page({}, 20, context)).items.length;
			const before = await persons();
			at.signer.failingIssue = true;
			await assert.rejects(at.post(token), /the signer is down/);
			assert.equal(await persons(), before, "no person made");
			at.signer.failingIssue = false;
			const signed = await at.post(token);
			assert.equal(signed.kind, "json");
			assert.equal(await persons(), before + 1);
			assert.deepEqual(await at.post(token), { kind: "error", status: 403 }, "used up");
		} finally {
			await at.close();
		}
	});
});
