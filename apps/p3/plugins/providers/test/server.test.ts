// The providers plugin on the server (`testPlugin`, beside the things plugin's server facet, the faux login's and an
// OAuth test provider): a person's sign-in (its question, its answer, its end), a login made from it by its maker only
// (never by someone else, never twice), what everyone admitted sees of a login and what only agents get (`authorize`,
// Use by the kind's default grants; no person, not the owner), the credential in no state, an OAuth token refreshed
// once for concurrent requests and a refused refresh asking for a sign-in again, and a deleted login's credential
// gone.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	BACKGROUND_CONTEXT as context,
	defineFacet,
	LoginProviders,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { fauxProvider } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { FAUX_MODEL, FAUX_PROVIDER, keyOf, type Step } from "../../../test/plugins/faux-login/contract.ts";
import fauxServer from "../../../test/plugins/faux-login/server.ts";
import { eventually, within } from "../../../test/until.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import type { Source } from "../../things/contract.ts";
import thingsServer from "../../things/server.ts";
import { LoginStore } from "../contract.server.ts";
import { Login, LoginKind, SignIn } from "../contract.ts";
import { makeLogin } from "../logins.ts";

/** A person's principal. */
type Person = Extract<P3Principal, { kind: "person" }>;

/** Who sets things up in the tests. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** A faux script. */
const SCRIPT: Step[] = [{ when: "", reply: [{ kind: "text", text: "hi" }] }];

/** How often the OAuth test provider refreshed, and whether its refreshes are refused. */
const oauth = { refreshes: 0 };

/**
 * An OAuth test provider (`oauth-test`): its sign-in asks for a code and answers a token that expired; a refresh
 * answers `access-<n>` (refused for the refresh token `bad`); the request auth is the access token.
 */
const oauthStub = defineFacet((_host, self) => {
	const base = fauxProvider({ provider: "oauth-test", api: "oauth-test", models: [{ id: "m" }] }).provider;
	self.contribute(LoginProviders, [
		{
			...base,
			name: "OAuth test",
			auth: {
				oauth: {
					name: "OAuth test",
					login: async (interaction) => {
						const code = await interaction.prompt({ type: "manual_code", message: "the code" });
						return { type: "oauth", access: `access-${code}`, refresh: code, expires: 0 };
					},
					refresh: async (credential) => {
						oauth.refreshes++;
						// The test's two requests wait here together.
						await new Promise((resolve) => setTimeout(resolve, 20));
						if (credential.refresh === "bad") throw new Error("invalid_grant");
						return { ...credential, access: `access-${oauth.refreshes}`, expires: Date.now() + 3_600_000 };
					},
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
		},
	]);
});

let t: TestedPlugin<P3Principal>;
let things: Reference<typeof ThingsStore>;
let pi: string;

beforeEach(async () => {
	oauth.refreshes = 0;
	t = await testPlugin(
		fileURLToPath(new URL("../", import.meta.url)),
		{
			kind: "server",
			stubs: [
				{ name: "@earendil-works/p3-things", facet: thingsServer },
				{ name: "p3-test-faux-login", facet: fauxServer },
				{ name: "oauth-test", facet: oauthStub },
			],
		},
		context,
	);
	things = await t.host.get(ThingsStore, {}, context);
	pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
});

afterEach(() => t.close(context));

/** Makes person `name`, put into `workspace`; their principal. */
async function person(name: string, workspace = pi): Promise<Person> {
	const id = await things.createPerson({ name, madeBy: BY }, context);
	await things.putParty({ workspace, party: { kind: "person", person: id }, source: BY }, context);
	return { kind: "person", id, name };
}

/** A workspace under Pi with session `session`'s agent put in (as a session's will be); the agent's principal. */
async function session(name: string): Promise<{ workspace: string; agent: P3Principal }> {
	const workspace = await things.createWorkspace({ kind: "things.workspace", name, parent: pi, by: BY }, context);
	await things.putParty({ workspace, party: { kind: "agent", session: name }, source: BY }, context);
	return { workspace, agent: { kind: "worker", session: name } };
}

/** Runs `fn` as `principal` with its `SignIn`. */
function signingIn<T>(
	principal: P3Principal,
	fn: (signIn: Reference<typeof SignIn>, ctx: Ctx<P3Principal>) => Promise<T>,
) {
	return t.root(async (ctx) => fn(await ctx.get(SignIn, {}), ctx), context, { principal });
}

/** Signs `principal` in to the faux provider with `script`; the finished sign-in's id. */
function signIn(principal: P3Principal, script: readonly Step[] = SCRIPT): Promise<string> {
	return signingIn(principal, async (flow, ctx) => {
		const attempt = await flow.start({ provider: FAUX_PROVIDER, method: "api_key" }, ctx);
		const asked = await until(
			flow.attempt,
			(now) => now?.status === "working" && now.prompt !== null,
			within("the question", ctx),
		);
		assert.ok(asked?.status === "working" && asked.prompt !== null);
		await flow.answer({ attempt, prompt: asked.prompt.id, value: keyOf(script) }, ctx);
		const done = await until(flow.attempt, (now) => now?.status === "done", within("the end", ctx));
		assert.ok(done?.status === "done");
		return done.signIn;
	});
}

/** Makes a login in `workspace` from sign-in `id`, made by `principal` (a person's create step, an agent's). */
function create(principal: P3Principal, workspace: string, id: string): Promise<string> {
	const by: Source =
		principal.kind === "person" ? { kind: "person", person: principal.id } : { kind: "agent", session: "s1" };
	return things.create({ kind: LoginKind.name, name: "Mine", workspace, by, input: { signIn: id } }, context);
}

/** Runs `fn` with `principal`'s login `thing` held in `workspace`. */
function holding<T>(
	principal: P3Principal,
	workspace: string,
	thing: string,
	fn: (login: Reference<typeof Login>, ctx: Ctx<P3Principal>) => Promise<T>,
) {
	return t.root(async (ctx) => fn(await ctx.get(Login, { workspace, thing }, { readyTimeout: 500 }), ctx), context, {
		principal,
	});
}

/** Whether `promise` rejects with an error of `code`. */
async function refused(promise: Promise<unknown>, code: string): Promise<void> {
	await assert.rejects(promise, (error: unknown) => (error as { code?: unknown }).code === code);
}

describe("signing in", () => {
	it("offers the providers with how to sign in; a person's sign-in asks, takes the answer and ends with an id", async () => {
		const ann = await person("Ann");
		const offered = await signingIn(ann, async (flow) => flow.providers.value);
		assert.deepEqual(
			offered.find(({ id }) => id === FAUX_PROVIDER),
			{ id: FAUX_PROVIDER, name: "Faux", methods: [{ method: "api_key", label: "Faux script" }] },
		);
		assert.ok(
			offered.some(({ id }) => id === "anthropic"),
			"pi-ai's built-in providers are offered",
		);
		assert.match(await signIn(ann), /^[0-9a-f-]{36}$/);
	});

	it("is the person's own: another person sees none of it; nobody but people signs in", async () => {
		const [ann, bob] = [await person("Ann"), await person("Bob")];
		await signIn(ann);
		assert.equal(await signingIn(bob, async (flow) => flow.attempt.value), null);
		const { agent } = await session("s1");
		await refused(
			signingIn(agent, async (flow) => flow.providers.value),
			"forbidden",
		);
	});

	it("ends cancelled; a new start replaces the running one; an answer to another question is refused", async () => {
		const ann = await person("Ann");
		await signingIn(ann, async (flow, ctx) => {
			const first = await flow.start({ provider: "oauth-test", method: "oauth" }, ctx);
			await until(flow.attempt, (now) => now?.status === "working" && now.prompt !== null, within("asked", ctx));
			await refused(flow.answer({ attempt: first, prompt: "nope", value: "x" }, ctx), "invalid");
			const second = await flow.start({ provider: "oauth-test", method: "oauth" }, ctx);
			assert.notEqual(second, first);
			await until(flow.attempt, (now) => now?.attempt === second && now.status === "working", within("second", ctx));
			await flow.cancel({ attempt: second }, ctx);
			assert.equal(flow.attempt.value, null);
		});
	});

	it("never shows the secret: not in the attempt, not in the login", async () => {
		const ann = await person("Ann");
		const secret: Step[] = [{ when: "the-secret-text", reply: [] }];
		const id = await signIn(ann, secret);
		const shown = await signingIn(ann, async (flow) => JSON.stringify(flow.attempt.value));
		assert.ok(!shown.includes("the-secret-text"));
		const thing = await create(ann, pi, id);
		const login = await holding(ann, pi, thing, async (held) => JSON.stringify(held.login.value));
		assert.ok(!login.includes("the-secret-text"));
	});
});

describe("making a login", () => {
	it("takes its maker's finished sign-in: signed in, its provider and models", async () => {
		const ann = await person("Ann");
		const thing = await create(ann, pi, await signIn(ann));
		const login = await holding(ann, pi, thing, async (held) => held.login.value);
		assert.deepEqual(login, {
			provider: FAUX_PROVIDER,
			providerName: "Faux",
			method: "api_key",
			status: "signedIn",
			models: [login.models[0]!],
		});
		assert.equal(login.models[0]!.id, FAUX_MODEL);
	});

	it("refuses someone else's sign-in, an agent, and a sign-in used once already; nothing is made", async () => {
		const [ann, bob] = [await person("Ann"), await person("Bob")];
		const { workspace, agent } = await session("s1");
		const id = await signIn(ann);
		await refused(create(bob, pi, id), "invalid");
		await refused(create(agent, workspace, id), "invalid");
		await create(ann, pi, id);
		await refused(create(ann, pi, id), "invalid");
		const linked = (await things.links.here.page({ workspace: pi }, 100, context)).items;
		assert.equal(linked.filter(({ of }) => of === LoginKind.name).length, 1);
	});

	it("drops its credential when it goes with its last link", async () => {
		const ann = await person("Ann");
		const thing = await create(ann, pi, await signIn(ann));
		await things.unlink({ workspace: pi, thing }, context);
		const store = await t.host.get(LoginStore, {}, context);
		await eventually(
			async () => (await store.logins.one.page({ thing }, 1, context)).items,
			(rows) => rows.length === 0,
			2000,
		);
	});
});

describe("who gets the request auth", () => {
	it("gives the agents Use: authorize answers the login's key; no person, not its maker, not the owner", async () => {
		const { workspace, agent } = await session("s1");
		const ann = await person("Ann", workspace);
		const thing = await create(ann, workspace, await signIn(ann));
		const auth = await holding(agent, workspace, thing, (login, ctx) => login.authorize!({}, ctx));
		assert.deepEqual(auth, { auth: { apiKey: keyOf(SCRIPT) }, source: "faux script" });
		assert.equal(await holding(ann, workspace, thing, async (login) => login.authorize), undefined);
		await things.setOwner({ person: ann.id, owner: true }, context);
		assert.equal(await holding(ann, workspace, thing, async (login) => login.authorize), undefined);
	});

	it("refreshes an expired OAuth token once for requests at once, and keeps the new one", async () => {
		const { workspace, agent } = await session("s1");
		const thing = await t.root(
			(ctx) =>
				makeLogin(
					{
						name: "OAuth",
						workspace,
						by: BY,
						provider: "oauth-test",
						method: "oauth",
						credential: { type: "oauth", access: "old", refresh: "good", expires: 0 },
					},
					ctx,
				),
			context,
		);
		const both = await holding(agent, workspace, thing, (login, ctx) =>
			Promise.all([login.authorize!({}, ctx), login.authorize!({}, ctx)]),
		);
		assert.deepEqual(
			both.map(({ auth }) => auth.apiKey),
			["access-1", "access-1"],
		);
		assert.equal(oauth.refreshes, 1);
		const again = await holding(agent, workspace, thing, (login, ctx) => login.authorize!({}, ctx));
		assert.equal(again.auth.apiKey, "access-1");
		assert.equal(oauth.refreshes, 1);
	});

	it("asks for a sign-in again when the provider refuses the refresh", async () => {
		const { workspace, agent } = await session("s1");
		const ann = await person("Ann", workspace);
		// The owner sees every login available where she is; the kind gives nobody else here anything by default.
		await things.setOwner({ person: ann.id, owner: true }, context);
		const thing = await t.root(
			(ctx) =>
				makeLogin(
					{
						name: "OAuth",
						workspace,
						by: BY,
						provider: "oauth-test",
						method: "oauth",
						credential: { type: "oauth", access: "old", refresh: "bad", expires: 0 },
					},
					ctx,
				),
			context,
		);
		await refused(
			holding(agent, workspace, thing, (login, ctx) => login.authorize!({}, ctx)),
			"providers.signInAgain",
		);
		await holding(ann, workspace, thing, (login, ctx) =>
			until(login.login, (now) => now.status === "signInAgain", within("the status", ctx)),
		);
	});
});
