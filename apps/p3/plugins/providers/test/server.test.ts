// The providers plugin on the server (`testPlugin`, beside the things plugin's server facet, the faux login's, the
// owner's admission and test providers): the owner's sign-in (its questions, its answers, its end, nobody else's), a
// login made from it by its maker only (never by someone else, never twice; a finished sign-in dropped by a cancel),
// what is let in and what only agents get (`authorize`, `catalog`: Use by the kind's default grants; no other person,
// not the owner; a second link's grants decide there), the credential and a provider's error text in no state or
// error, an OAuth token refreshed once for requests at once, a refused one asking for a sign-in again and refused at
// once after, an account's own models, and a deleted login's credential gone.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Ctx,
	constant,
	BACKGROUND_CONTEXT as context,
	defineFacet,
	LoginProviders,
	OwnerAccess,
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
import { LoginStore, SignIns } from "../contract.server.ts";
import { Login, LoginKind, SignIn } from "../contract.ts";
import { ensureLogin, makeLogin, setCredential } from "../logins.ts";

/** A person's principal. */
type Person = Extract<P3Principal, { kind: "person" }>;

/** Who sets things up in the tests. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** A faux script. */
const SCRIPT: Step[] = [{ when: "", reply: [{ kind: "text", text: "hi" }] }];

/** How often the OAuth test provider refreshed. */
const oauth = { refreshes: 0 };

/** A text no state, error or log line may show: what a provider's server answered, a token among it. */
const MARKER = "token-MARKER-0f3a";

/** The `callerKey`s of the owners (the people plugin's answer, stubbed). */
const owners = new Set<string>();

/** The owner's admission (`OwnerAccess`), answering from `owners`. */
const ownerStub = defineFacet((host) =>
	host.serve(OwnerAccess, ({ caller }) => ({ owner: constant(owners.has(caller)) })),
);

/**
 * A failing test provider (`failing`): its sign-in fails, its request auth fails, both with `MARKER` in their error
 * text.
 */
const failingStub = defineFacet((_host, self) => {
	const base = fauxProvider({ provider: "failing", api: "failing", models: [{ id: "m" }] }).provider;
	self.contribute(LoginProviders, [
		{
			...base,
			auth: {
				apiKey: {
					name: "Failing",
					login: async () => {
						throw new Error(`the server answered ${MARKER}`);
					},
					resolve: async () => {
						throw new Error(`the server answered ${MARKER}`);
					},
				},
			},
		},
	]);
});

/**
 * An OAuth test provider (`oauth-test`): its sign-in asks how (one of two options), then for a code, and answers a
 * token that expired; a refresh
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
						await interaction.prompt({
							type: "select",
							message: "how",
							options: [
								{ id: "code", label: "A code" },
								{ id: "browser", label: "A browser" },
							],
						});
						const code = await interaction.prompt({ type: "manual_code", message: "the code" });
						return { type: "oauth", access: `access-${code}`, refresh: code, expires: 0 };
					},
					refresh: async (credential) => {
						oauth.refreshes++;
						// The test's two requests wait here together.
						await new Promise((resolve) => setTimeout(resolve, 20));
						if (credential.refresh === "bad") throw new Error(`invalid_grant: ${MARKER}`);
						return { ...credential, access: `access-${oauth.refreshes}`, expires: Date.now() + 3_600_000 };
					},
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
		},
	]);
});

/** A test provider (`stubborn`) whose sign-in never ends, whatever its abort says. */
const stubbornStub = defineFacet((_host, self) => {
	const base = fauxProvider({ provider: "stubborn", api: "stubborn", models: [{ id: "m" }] }).provider;
	const never = () => new Promise<never>(() => {});
	self.contribute(LoginProviders, [
		{ ...base, auth: { apiKey: { name: "Stubborn", login: never, resolve: async () => undefined } } },
	]);
});

let t: TestedPlugin<P3Principal>;
let things: Reference<typeof ThingsStore>;
let pi: string;

beforeEach(async () => {
	oauth.refreshes = 0;
	owners.clear();
	t = await testPlugin(
		fileURLToPath(new URL("../", import.meta.url)),
		{
			kind: "server",
			stubs: [
				{ name: "@earendil-works/p3-things", facet: thingsServer },
				{ name: "p3-test-faux-login", facet: fauxServer },
				{ name: "oauth-test", facet: oauthStub },
				{ name: "failing", facet: failingStub },
				{ name: "stubborn", facet: stubbornStub },
				{ name: "@earendil-works/p3-people", facet: ownerStub },
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

/** Makes owner `name` (the people plugin's owner: who may sign in), put into `workspace`; their principal. */
async function owner(name: string, workspace = pi): Promise<Person> {
	const made = await person(name, workspace);
	owners.add(`person:${made.id}`);
	return made;
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

/**
 * Signs `principal` in to the faux provider with `script` and runs `fn` with the finished sign-in's attempt id while
 * the sign-in is held (its credential waits in the person's object as long as their page holds it).
 */
function signedIn<T>(
	principal: P3Principal,
	fn: (attempt: string, flow: Reference<typeof SignIn>, ctx: Ctx<P3Principal>) => Promise<T>,
	script: readonly Step[] = SCRIPT,
): Promise<T> {
	return signingIn(principal, async (flow, ctx) => {
		const attempt = await flow.start({ provider: FAUX_PROVIDER, method: "api_key" }, ctx);
		const asked = await until(
			flow.attempt,
			(now) => now?.status === "working" && now.prompt !== null,
			within("the question", ctx),
		);
		assert.ok(asked?.status === "working" && asked.prompt !== null);
		await flow.answer({ prompt: asked.prompt.id, value: keyOf(script) }, ctx);
		await until(flow.attempt, (now) => now?.status === "done", within("the end", ctx));
		return fn(attempt, flow, ctx);
	});
}

/** Makes a login in `workspace` from finished sign-in `attempt`, made by `by` (a person's create step, an agent's). */
function create(by: Source, workspace: string, attempt: string): Promise<string> {
	return things.create({ kind: LoginKind.name, name: "Mine", workspace, by, input: { attempt } }, context);
}

/** `person` as a maker. */
const madeBy = (person: Person): Source => ({ kind: "person", person: person.id });

/** A login of `principal`'s sign-in with `script`, made by them in `workspace`. */
const loginOf = (principal: Person, workspace: string, script: readonly Step[] = SCRIPT) =>
	signedIn(principal, (attempt) => create(madeBy(principal), workspace, attempt), script);

/** A login made by the server in `workspace`, of `provider` with `credential`. */
const serverLogin = (workspace: string, provider: string, credential: unknown) =>
	t.root((ctx) => makeLogin({ name: provider, workspace, by: BY, provider, credential }, ctx), context);

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
	it("offers the providers with how to sign in; the owner's sign-in asks, takes the answer and ends done", async () => {
		const ann = await owner("Ann");
		const offered = await signingIn(ann, async (flow) => flow.providers.value);
		assert.deepEqual(
			offered.find(({ id }) => id === FAUX_PROVIDER),
			{ id: FAUX_PROVIDER, name: "Faux", methods: [{ method: "api_key", label: "Faux script" }] },
		);
		assert.ok(
			offered.some(({ id }) => id === "anthropic"),
			"pi-ai's built-in providers are offered",
		);
		await signedIn(ann, async (attempt, flow) => {
			assert.match(attempt, /^[0-9a-f-]{36}$/);
			assert.equal(flow.attempt.value?.status, "done");
		});
	});

	it("is the owner's only, until workspaces decide who may make a login: no other person, no agent", async () => {
		await owner("Ann");
		const bob = await person("Bob");
		await refused(
			signingIn(bob, async (flow) => flow.providers.value),
			"forbidden",
		);
		const { agent } = await session("s1");
		await refused(
			signingIn(agent, async (flow) => flow.providers.value),
			"forbidden",
		);
	});

	it("is the person's own: another owner sees none of it", async () => {
		const [ann, eve] = [await owner("Ann"), await owner("Eve")];
		await signedIn(ann, async () => {
			assert.equal(await signingIn(eve, async (flow) => flow.attempt.value), null);
		});
	});

	it("ends cancelled; a new start replaces the running one; an answer to another question is refused", async () => {
		const ann = await owner("Ann");
		await signingIn(ann, async (flow, ctx) => {
			const first = await flow.start({ provider: "oauth-test", method: "oauth" }, ctx);
			await until(flow.attempt, (now) => now?.status === "working" && now.prompt !== null, within("asked", ctx));
			await refused(flow.answer({ prompt: "nope", value: "x" }, ctx), "invalid");
			const second = await flow.start({ provider: "oauth-test", method: "oauth" }, ctx);
			assert.notEqual(second, first);
			await until(flow.attempt, (now) => now?.attempt === second && now.status === "working", within("second", ctx));
			await flow.cancel({ attempt: second }, ctx);
			assert.equal(flow.attempt.value, null);
		});
	});

	it("outlives its person's last page: a page that lost its socket finds its sign-in again (Fable)", async () => {
		const ann = await owner("Ann");
		await signingIn(ann, async (flow, ctx) => {
			await flow.start({ provider: FAUX_PROVIDER, method: "api_key" }, ctx);
			await until(flow.attempt, (now) => now?.status === "working" && now.prompt !== null, within("asked", ctx));
		});
		// No page holds it now; the next one finds the question still asked.
		const again = await signingIn(ann, async (flow) => flow.attempt.value);
		assert.equal(again?.status, "working");
	});

	it("starts anew even when the flow it replaces ignores its end, after a bound (Opus)", async () => {
		const ann = await owner("Ann");
		await signingIn(ann, async (flow, ctx) => {
			await flow.start({ provider: "stubborn", method: "api_key" }, ctx);
			await until(flow.attempt, (now) => now?.status === "working", within("the first", ctx));
			// Real time: the bound (5 s) passes, then the new flow starts.
			const started = Date.now();
			assert.match(await flow.start({ provider: FAUX_PROVIDER, method: "api_key" }, ctx), /^[0-9a-f-]{36}$/);
			assert.ok(Date.now() - started >= 4_900);
		});
	});

	it("takes only one of a question's options; then asks the next", async () => {
		const ann = await owner("Ann");
		await signingIn(ann, async (flow, ctx) => {
			await flow.start({ provider: "oauth-test", method: "oauth" }, ctx);
			const how = await until(
				flow.attempt,
				(now) => now?.status === "working" && now.prompt !== null,
				within("how", ctx),
			);
			assert.ok(how?.status === "working" && how.prompt?.type === "select");
			await refused(flow.answer({ prompt: how.prompt.id, value: "zzz" }, ctx), "invalid");
			await flow.answer({ prompt: how.prompt.id, value: "code" }, ctx);
			const code = await until(
				flow.attempt,
				(now) => now?.status === "working" && now.prompt?.type === "manual_code",
				within("the code", ctx),
			);
			assert.ok(code?.status === "working" && code.prompt !== null);
			await flow.answer({ prompt: code.prompt.id, value: "c1" }, ctx);
			await until(flow.attempt, (now) => now?.status === "done", within("done", ctx));
		});
	});

	it("never shows the secret: not in the attempt, not in the login", async () => {
		const ann = await owner("Ann");
		const secret: Step[] = [{ when: MARKER, reply: [] }];
		const thing = await signedIn(
			ann,
			async (attempt, flow) => {
				assert.ok(!JSON.stringify(flow.attempt.value).includes(MARKER));
				return create(madeBy(ann), pi, attempt);
			},
			secret,
		);
		const login = await holding(ann, pi, thing, async (held) => JSON.stringify(held.login.value));
		assert.ok(!login.includes(MARKER));
	});

	it("ends failed with a fixed message when the provider's flow fails: its error text is nowhere", async () => {
		const ann = await owner("Ann");
		const lines = await logged(() =>
			signingIn(ann, async (flow, ctx) => {
				await flow.start({ provider: "failing", method: "api_key" }, ctx);
				const ended = await until(flow.attempt, (now) => now?.status === "ended", within("the end", ctx));
				assert.ok(ended?.status === "ended");
				assert.equal(ended.message.key, "failed");
				assert.ok(!JSON.stringify(ended).includes(MARKER));
			}),
		);
		assert.ok(!lines.includes(MARKER), lines);
	});
});

describe("making a login", () => {
	it("takes its maker's finished sign-in: signed in, its provider and models", async () => {
		const ann = await owner("Ann");
		const thing = await loginOf(ann, pi);
		const login = await holding(ann, pi, thing, async (held) => held.login.value);
		assert.ok(login !== null);
		assert.deepEqual(login, {
			provider: FAUX_PROVIDER,
			providerName: "Faux",
			method: "api_key",
			status: "signedIn",
			models: [login.models[0]!],
		});
		assert.equal(login.models[0]!.id, FAUX_MODEL);
	});

	it("refuses someone else's sign-in, a session's agent as maker, and a sign-in used once already", async () => {
		const ann = await owner("Ann");
		await signedIn(ann, async (attempt) => {
			const bob = await owner("Bob");
			await refused(create(madeBy(bob), pi, attempt), "invalid");
			await refused(create({ kind: "agent", session: "s1" }, pi, attempt), "invalid");
			await create(madeBy(ann), pi, attempt);
			await refused(create(madeBy(ann), pi, attempt), "invalid");
		});
		const linked = (await things.links.here.page({ workspace: pi }, 100, context)).items;
		assert.equal(linked.filter(({ of }) => of === LoginKind.name).length, 1);
	});

	it("never lets a session's agent make one, not with a sign-in the server holds", async () => {
		const flows = await t.host.get(SignIns, { owner: "server" }, context);
		const attempt = await flows.hold({ provider: FAUX_PROVIDER, credential: { type: "api_key", key: "k" } }, context);
		await refused(create({ kind: "agent", session: "s1" }, pi, attempt), "invalid");
	});

	it("takes nothing of a finished sign-in a new start replaced", async () => {
		const ann = await owner("Ann");
		await signedIn(ann, async (attempt, flow, ctx) => {
			await flow.start({ provider: "oauth-test", method: "oauth" }, ctx);
			await refused(create(madeBy(ann), pi, attempt), "invalid");
		});
	});

	it("takes nothing of a finished sign-in left waiting longer than fifteen minutes", async () => {
		const ann = await owner("Ann");
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			await signedIn(ann, async (attempt, flow) => {
				mock.timers.tick(15 * 60_000);
				assert.equal(flow.attempt.value, null);
				await refused(create(madeBy(ann), pi, attempt), "invalid");
			});
		} finally {
			mock.timers.reset();
		}
	});

	it("takes nothing of a finished sign-in that was cancelled", async () => {
		const ann = await owner("Ann");
		await signedIn(ann, async (attempt, flow, ctx) => {
			await flow.cancel({ attempt }, ctx);
			assert.equal(flow.attempt.value, null);
			await refused(create(madeBy(ann), pi, attempt), "invalid");
		});
	});

	it("is made once by server code that runs at every start (in Pi), and left as it is after", async () => {
		const pi1 = await session("s1");
		const login = (key: string) =>
			t.root(
				(ctx) =>
					ensureLogin(
						{ name: "Deployment", by: BY, provider: FAUX_PROVIDER, credential: { type: "api_key", key } },
						ctx,
					),
				context,
			);
		const first = await login("one");
		assert.equal(await login("two"), first);
		const linked = (await things.links.here.page({ workspace: pi }, 100, context)).items;
		assert.deepEqual(
			linked.filter(({ of }) => of === LoginKind.name).map(({ thing }) => thing),
			[first],
		);
		// The session below Pi has it, as every login linked above (the agents' Use comes down with it).
		const auth = await holding(pi1.agent, pi1.workspace, first, (held, ctx) => held.authorize!({}, ctx));
		assert.equal(auth.auth.apiKey, "one");
	});

	it("is made once by calls at once (Astra), and never taken for a person's login of the same name (Opus)", async () => {
		const ann = await owner("Ann");
		const persons = await signedIn(ann, (attempt) =>
			things.create(
				{ kind: LoginKind.name, name: "Deploy", workspace: pi, by: madeBy(ann), input: { attempt } },
				context,
			),
		);
		const one = () =>
			t.root(
				(ctx) =>
					ensureLogin(
						{ name: "Deploy", by: BY, provider: FAUX_PROVIDER, credential: { type: "api_key", key: "k" } },
						ctx,
					),
				context,
			);
		const [a, b] = await Promise.all([one(), one()]);
		assert.equal(a, b);
		assert.notEqual(a, persons);
	});

	it("takes a new credential only of its own provider, and never comes back once deleted (Astra)", async () => {
		const thing = await serverLogin(pi, FAUX_PROVIDER, { type: "api_key", key: "one" });
		const set = (provider: string, key: string) =>
			t.root((ctx) => setCredential(thing, { provider, credential: { type: "api_key", key } }, ctx), context);
		await refused(set("anthropic", "theirs"), "invalid");
		await set(FAUX_PROVIDER, "two");
		await things.unlink({ workspace: pi, thing }, context);
		const store = await t.host.get(LoginStore, {}, context);
		await eventually(
			async () => (await store.logins.one.page({ thing }, 1, context)).items,
			(rows) => rows.length === 0,
			2000,
		);
		await refused(set(FAUX_PROVIDER, "three"), "invalid");
		assert.deepEqual((await store.logins.one.page({ thing }, 1, context)).items, []);
	});

	it("drops its credential when it goes with its last link", async () => {
		const ann = await owner("Ann");
		const thing = await loginOf(ann, pi);
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
	it("gives the agents Use: authorize and catalog; no other person, not its maker, not the owner", async () => {
		const { workspace, agent } = await session("s1");
		const ann = await owner("Ann", workspace);
		const thing = await loginOf(ann, workspace);
		const auth = await holding(agent, workspace, thing, (login, ctx) => login.authorize!({}, ctx));
		assert.deepEqual(auth, { auth: { apiKey: keyOf(SCRIPT) }, source: "faux script" });
		const catalog = await holding(agent, workspace, thing, async (login) => login.catalog!.value);
		assert.deepEqual(
			catalog.map((model) => (model as { id: string }).id),
			[FAUX_MODEL],
		);
		assert.equal(await holding(ann, workspace, thing, async (login) => login.authorize), undefined);
		assert.equal(await holding(ann, workspace, thing, async (login) => login.catalog), undefined);
		// Anyone else here is not let in at all: people see the models through the session's model picker.
		const bob = await person("Bob", workspace);
		await refused(
			holding(bob, workspace, thing, async (login) => login.login.value),
			"forbidden",
		);
		await things.setOwner({ person: ann.id, owner: true }, context);
		assert.equal(await holding(ann, workspace, thing, async (login) => login.authorize), undefined);
	});

	it("is decided where it is held: a second link withholding Use gives the agent nothing there", async () => {
		const first = await session("s1");
		const second = await session("s2");
		const thing = await serverLogin(first.workspace, FAUX_PROVIDER, { type: "api_key", key: keyOf(SCRIPT) });
		await things.link({ workspace: second.workspace, thing, by: BY }, context);
		await things.setGrants(
			{
				source: BY,
				grants: [{ workspace: second.workspace, thing, party: { kind: "agents" }, tick: "use", gives: false }],
			},
			context,
		);
		const s2: P3Principal = { kind: "worker", session: "s2" };
		assert.equal(await holding(s2, second.workspace, thing, async (login) => login.authorize), undefined);
		const s1 = first.agent;
		assert.ok(await holding(s1, first.workspace, thing, async (login) => login.authorize !== undefined));
	});

	it("resolves only what the login stored, never the server's environment; refused at once after", async () => {
		const { workspace, agent } = await session("s1");
		const thing = await serverLogin(workspace, "anthropic", { type: "api_key" });
		const before = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "the-servers-own-key";
		try {
			await refused(
				holding(agent, workspace, thing, (login, ctx) => login.authorize!({}, ctx)),
				"providers.signInAgain",
			);
		} finally {
			if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = before;
		}
		const shown = await holding(agent, workspace, thing, async (login) => login.catalog!.value);
		assert.deepEqual(shown, [], "a login that needs a sign-in again offers no model");
	});

	it("refreshes an expired OAuth token once for requests at once, and keeps the new one", async () => {
		const { workspace, agent } = await session("s1");
		const thing = await serverLogin(workspace, "oauth-test", {
			type: "oauth",
			access: "old",
			refresh: "good",
			expires: 0,
		});
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

	it("asks for a sign-in again when the refresh is refused, without its text; refused at once after", async () => {
		const { workspace, agent } = await session("s1");
		const ann = await person("Ann", workspace);
		// The owner sees every login available where she is; the kind gives nobody else here anything by default.
		await things.setOwner({ person: ann.id, owner: true }, context);
		const thing = await serverLogin(workspace, "oauth-test", {
			type: "oauth",
			access: "old",
			refresh: "bad",
			expires: 0,
		});
		const lines = await logged(async () => {
			const error = await holding(agent, workspace, thing, (login, ctx) => login.authorize!({}, ctx)).catch(
				(caught: unknown) => caught as Error & { code?: string },
			);
			assert.equal((error as { code?: string }).code, "providers.signInAgain");
			assert.ok(!(error as Error).message.includes(MARKER));
		});
		assert.ok(!lines.includes(MARKER), lines);
		await holding(ann, workspace, thing, (login, ctx) =>
			until(login.login, (now) => now?.status === "signInAgain", within("the status", ctx)),
		);
		await refused(
			holding(agent, workspace, thing, (login, ctx) => login.authorize!({}, ctx)),
			"providers.signInAgain",
		);
		assert.equal(oauth.refreshes, 1, "no second refresh of a refused credential");
	});

	it("fails a request auth that fails otherwise with a fixed error, the login still signed in", async () => {
		const { workspace, agent } = await session("s1");
		const thing = await serverLogin(workspace, "failing", { type: "api_key", key: "k" });
		const lines = await logged(async () => {
			const error = await holding(agent, workspace, thing, (login, ctx) => login.authorize!({}, ctx)).catch(
				(caught: unknown) => caught as Error & { code?: string },
			);
			assert.equal((error as { code?: string }).code, "providers.authFailed");
			assert.ok(!(error as Error).message.includes(MARKER));
		});
		assert.ok(!lines.includes(MARKER), lines);
		const store = await t.host.get(LoginStore, {}, context);
		assert.equal((await store.logins.one.page({ thing }, 1, context)).items[0]?.status, "signedIn");
	});

	it("offers only the models the account has (Copilot's account list), none of the rest of the catalog", async () => {
		const { workspace, agent } = await session("s1");
		const credential = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };
		const none = await serverLogin(workspace, "github-copilot", { ...credential, availableModelIds: [] });
		assert.deepEqual(await holding(agent, workspace, none, async (login) => login.catalog!.value), []);
		const all = await serverLogin(workspace, "github-copilot", credential);
		const some = await holding(agent, workspace, all, async (login) => login.catalog!.value.length);
		const one = (await holding(agent, workspace, all, async (login) => login.catalog!.value))[0] as { id: string };
		const just = await serverLogin(workspace, "github-copilot", { ...credential, availableModelIds: [one.id] });
		const ids = await holding(agent, workspace, just, async (login) =>
			login.catalog!.value.map((model) => (model as { id: string }).id),
		);
		assert.ok(some > 1);
		assert.deepEqual(ids, [one.id]);
	});
});

/** What `fn` wrote to stderr (the log), while it ran. */
async function logged(fn: () => Promise<void>): Promise<string> {
	const lines: string[] = [];
	const write = console.error;
	console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
	try {
		await fn();
	} finally {
		console.error = write;
	}
	return lines.join("\n");
}
