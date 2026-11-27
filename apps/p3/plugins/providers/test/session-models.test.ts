// A session's models (`SessionModels`, decision 118a, b) on the things plugin's test host with the sessions plugin (the
// ERNDL-705 issue's cases 2 to 7): per login the session's agent may Use, its account's models; a second link with Use
// withheld decides there, and a login hidden in the session's workspace gives nothing; a grant changed changes the list
// live, and the entries of a login that did not change keep their identity; `catalog` is the session's worker's, never
// a person's; the overrides of two model settings things merge per field, nearest first, and a hidden model leaves both
// lists; a reload keeps a held one, a released one is collected; an agent changes model settings (`set`, the Edit tick,
// live: withheld, it has no `set`) and is given no Configure where a login is linked.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type Context,
	type Ctx,
	BACKGROUND_CONTEXT as context,
	createHost,
	defineFacet,
	LoginProviders,
	memoryLinkPair,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { fauxProvider } from "@earendil-works/p3/v1/server";
import { FAUX_MODEL, FAUX_PROVIDER, keyOf } from "../../../test/plugins/faux-login/contract.ts";
import { collected, within } from "../../../test/until.ts";
import environmentsServer from "../../environments/server.ts";
import sessionsServer from "../../sessions/server.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import type { Source } from "../../things/contract.ts";
import type { World } from "../../things/test/world.ts";
import { Workspace } from "../../things/workspace.ts";
import { LoginAccount, LoginStore } from "../contract.server.ts";
import { type LoginDefinitions, type LoginModels, type ModelOverride, SessionModels } from "../contract.ts";
import { makeLogin } from "../logins.ts";
import { ModelSettings, ModelSettingsKind } from "../model-settings-kind.ts";
import { PROVIDERS, providersWorld } from "./hosts.ts";

/** Who sets things up. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** A faux login's credential. */
const CREDENTIAL = { type: "api_key", key: keyOf([]) };

/** A second faux provider type, with a model of the same id as the faux login's (Astra, round 2). */
const OTHER_PROVIDER = "faux-other";
const OTHER = defineFacet((_host, self) =>
	self.contribute(LoginProviders, [
		fauxProvider({ provider: OTHER_PROVIDER, api: "faux", models: [{ id: FAUX_MODEL }] }).provider,
	]),
);

let w: World;
let things: Reference<typeof ThingsStore>;
let family: string;
let session: string;
/** The session's agent (its worker). */
let agent: P3Principal;

beforeEach(async () => {
	w = await providersWorld(context, new Set(), [
		{ name: "p3-test-other-faux", facet: OTHER },
		{ name: "@earendil-works/p3-environments", facet: environmentsServer },
		{ name: "@earendil-works/p3-sessions", facet: sessionsServer },
	]);
	things = await w.host.get(ThingsStore, {}, context);
	const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	family = await things.createWorkspace({ kind: "things.workspace", name: "Family", parent: pi, by: BY }, context);
	session = await things.createWorkspace(
		{ kind: "sessions.session", name: "s1", parent: family, by: BY, input: {} },
		context,
	);
	agent = { kind: "worker", session };
});

afterEach(() => w.close(context));

/** Runs `fn` as `principal`. */
function as<T>(principal: P3Principal, fn: (ctx: Ctx<P3Principal>) => Promise<T>): Promise<T> {
	return w.host.root(fn, context, { principal });
}

/** A faux login linked in `workspace`; its id. */
function loginIn(workspace: string, name = "Faux"): Promise<string> {
	return w.host.root(
		(ctx) => makeLogin({ name, workspace, by: BY, provider: FAUX_PROVIDER, credential: CREDENTIAL }, ctx),
		context,
	);
}

/** A model settings thing in `workspace` with `overrides`; its id. */
async function settingsIn(workspace: string, overrides: ModelOverride[]): Promise<string> {
	const thing = await things.create({ kind: ModelSettingsKind.name, name: "m", workspace, by: BY }, context);
	await things.configure({ thing, settings: { overrides } }, context);
	return thing;
}

/** `principal`'s `SessionModels` of the session, held while `fn` runs. */
function holding<T>(
	principal: P3Principal,
	fn: (models: Reference<typeof SessionModels>, ctx: Ctx<P3Principal>) => Promise<T>,
) {
	return as(principal, async (ctx) => fn(await ctx.get(SessionModels, { session }), ctx));
}

/** The models listed for `login` once `done` holds for the list. */
async function listed(
	models: Reference<typeof SessionModels>,
	done: (list: LoginModels[]) => boolean,
	ctx: Ctx<P3Principal>,
) {
	return until(models.models, done, within("the session's models", ctx));
}

describe("a session's models", () => {
	it("list each login the agent may Use with its account's models; the catalog is the worker's alone", async () => {
		const login = await loginIn(family);
		await holding(agent, async (models, ctx) => {
			const [entry] = await listed(models, (list) => list.length === 1, ctx);
			assert.deepEqual(
				[entry!.login, entry!.provider, entry!.models.map(({ id }) => id)],
				[login, FAUX_PROVIDER, [FAUX_MODEL]],
			);
			const catalog = await until(models.catalog!, (list) => list.length === 1, within("the catalog", ctx));
			assert.equal((catalog[0]!.models[0] as { id: string }).id, FAUX_MODEL);
		});
		// A person the session gives anything (the owner here) gets the list, never the catalog.
		const owner: P3Principal = {
			kind: "person",
			id: await things.createPerson({ name: "Ann", madeBy: BY }, context),
			name: "Ann",
		};
		await things.setOwner({ person: owner.id, owner: true }, context);
		await holding(owner, async (models, ctx) => {
			await listed(models, (list) => list.length === 1, ctx);
			assert.equal(models.catalog, undefined);
			assert.ok(!models.granted.has("catalog"));
		});
	});

	it("are computed once for every holder: the worker and a person get the same entries (118a)", async () => {
		await loginIn(family);
		const owner: P3Principal = {
			kind: "person",
			id: await things.createPerson({ name: "Ann", madeBy: BY }, context),
			name: "Ann",
		};
		await things.setOwner({ person: owner.id, owner: true }, context);
		await holding(agent, async (models, ctx) => {
			const [mine] = await listed(models, (list) => list.length === 1, ctx);
			await holding(owner, async (theirs, theirCtx) => {
				const [same] = await listed(theirs, (list) => list.length === 1, theirCtx);
				assert.equal(same, mine, "one computation per session, not one per holder");
			});
		});
	});

	it("follow a second link withholding Use, and a login hidden in the session, live", async () => {
		const login = await loginIn(family);
		await holding(agent, async (models, ctx) => {
			await listed(models, (list) => list.length === 1, ctx);
			// Linked in the session too, Use withheld from the agents there: that link decides.
			await things.link({ workspace: session, thing: login }, context);
			await things.setGrants(
				{
					source: BY,
					grants: [{ workspace: session, thing: login, party: { kind: "agents" }, tick: "use", gives: false }],
				},
				context,
			);
			await listed(models, (list) => list.length === 0, ctx);
			await things.unlink({ workspace: session, thing: login }, context);
			await listed(models, (list) => list.length === 1, ctx);
			await things.setSwitch({ workspace: session, item: { kind: "thing", thing: login }, shown: false }, context);
			await listed(models, (list) => list.length === 0, ctx);
		});
	});

	it("keep a login's entries while it does not change, when another one comes", async () => {
		await loginIn(family, "One");
		await holding(agent, async (models, ctx) => {
			const [first] = await listed(models, (list) => list.length === 1, ctx);
			const catalog = await until(models.catalog!, (list) => list.length === 1, within("the catalog", ctx));
			await loginIn(family, "Two");
			const both = await listed(models, (list) => list.length === 2, ctx);
			assert.ok(both.includes(first!), "the unchanged login's entry is the same object");
			const again = await until(models.catalog!, (list) => list.length === 2, within("the catalog", ctx));
			assert.ok(again.includes(catalog[0]!));
		});
	});
});

/** Every value `member` of `models` takes while `fn` runs, from its first, mapped by `seen`. */
async function traced<V, T>(
	member: Reference<typeof SessionModels>["models"] | NonNullable<Reference<typeof SessionModels>["catalog"]>,
	seen: (value: V) => T,
	fn: () => Promise<void>,
	ctx: Ctx<P3Principal>,
): Promise<T[]> {
	const trace: T[] = [];
	const watch = await member.watch(ctx);
	trace.push(seen(watch.value as V));
	watch.start(async (call) => {
		if (call.kind === "value") trace.push(seen(call.value as V));
	});
	await fn();
	return trace;
}

describe("a session's models while they load (round 1 of model settings)", () => {
	it("are complete only with every login's models: the first complete catalog has the login linked (Opus M1)", async () => {
		await loginIn(family);
		await holding(agent, async (models, ctx) => {
			await until(models.complete, (complete) => complete, within("complete", ctx));
			assert.deepEqual([models.models.value.length, models.catalog!.value.length], [1, 1]);
		});
	});

	it("never list one login of two while the other's models load (Astra 2)", async () => {
		const a = await loginIn(family, "A");
		await loginIn(family, "B");
		// A's account is read already (another session holds it); B's is not.
		const warm = await w.host.get(LoginAccount, { thing: a }, context);
		try {
			await holding(agent, async (models, ctx) => {
				const lengths = await traced(
					models.catalog!,
					(list: LoginDefinitions[]) => list.length,
					() => until(models.catalog!, (list) => list.length === 2, within("both", ctx)).then(() => undefined),
					ctx,
				);
				assert.ok(!lengths.includes(1), `catalog lengths ${lengths.join(", ")}`);
			});
		} finally {
			warm.release();
		}
	});

	it("never list a model before the overrides that hide it (Astra 2)", async () => {
		const a = await loginIn(family);
		const warm = await w.host.get(LoginAccount, { thing: a }, context);
		await settingsIn(session, [{ model: FAUX_MODEL, hidden: true }]);
		try {
			await holding(agent, async (models, ctx) => {
				const counts = await traced(
					models.catalog!,
					(list: LoginDefinitions[]) => list[0]?.models.length ?? 0,
					() => until(models.complete, (complete) => complete, within("complete", ctx)).then(() => undefined),
					ctx,
				);
				assert.ok(!counts.includes(1), `model counts ${counts.join(", ")}`);
				assert.equal(models.catalog!.value[0]?.models.length, 0);
			});
		} finally {
			warm.release();
		}
	});

	it("reach a worker over a link, a second login too: the definitions are plain JSON (Astra 3)", async () => {
		await loginIn(family, "One");
		await holding(agent, async (local, ctx) => {
			await listed(local, (list) => list.length === 1, ctx);
			const [up, down] = memoryLinkPair();
			const peer = createHost<P3Principal>({ onError: (error) => assert.fail(error.kind) });
			w.host.accept(down, { principal: agent }, ctx);
			peer.connect(up, { principal: { kind: "server" } }, ctx);
			await peer.load([], ctx);
			try {
				const models = await peer.get(SessionModels, { session }, ctx);
				await until(models.catalog!, (list) => list.length === 1, within("one", ctx));
				await loginIn(family, "Two");
				await until(models.catalog!, (list) => list.length === 2, within("the second login", ctx));
			} finally {
				await peer.close(ctx);
			}
		});
		assert.deepEqual(w.errors, []);
	});
});

/**
 * Runs `fn` while a login newly linked in the session has its account not in yet: its `LoginAccount`'s first value
 * waits until `fn` calls `release` (the only way to hold one value back on one host; everything else is real).
 */
async function withPending(fn: (release: () => void) => Promise<void>): Promise<void> {
	const sibling = await things.createWorkspace(
		{ kind: "things.workspace", name: "Sibling", parent: family, by: BY },
		context,
	);
	const slow = await loginIn(sibling, "Slow");
	const gate = Promise.withResolvers<void>();
	const hold = w.host.hold.bind(w.host);
	// The test's stand-in for a slow first read: the session's holding reads only `account` of a `LoginAccount`.
	const delayed = ((contract: unknown, params: { thing?: string }, holding: Context) => {
		const ref = hold(contract as typeof LoginAccount, params as { thing: string }, holding);
		if (contract !== LoginAccount || params.thing !== slow) return ref;
		const { account } = ref;
		return {
			release: () => ref.release(),
			account: {
				watch: async (watching: Context) => {
					await gate.promise;
					return account.watch(watching);
				},
			},
		};
	}) as unknown as typeof w.host.hold;
	w.host.hold = delayed;
	try {
		await things.link({ workspace: session, thing: slow }, context);
		await fn(() => gate.resolve());
	} finally {
		gate.resolve();
		w.host.hold = hold;
	}
}

describe("a session's models while another login loads (Astra, round 2)", () => {
	for (const change of ["a hidden model", "a grant taken back", "a credential removed"] as const) {
		it(`take ${change} of a login listed already away at once`, async () => {
			const fast = await loginIn(family, "Fast");
			const settings = await settingsIn(session, []);
			await holding(agent, async (models, ctx) => {
				await until(models.complete, (complete) => complete, within("complete", ctx));
				await withPending(async (release) => {
					await until(models.complete, (complete) => !complete, within("pending", ctx));
					if (change === "a hidden model") {
						await things.configure(
							{ thing: settings, settings: { overrides: [{ model: FAUX_MODEL, hidden: true }] } },
							context,
						);
					} else if (change === "a grant taken back") {
						await things.setSwitch(
							{ workspace: session, item: { kind: "thing", thing: fast }, shown: false },
							context,
						);
					} else {
						await (await w.host.get(LoginStore, {}, context)).remove({ thing: fast }, context);
					}
					const shown = (list: readonly { login: string; models: readonly unknown[] }[]) =>
						list.find(({ login }) => login === fast)?.models.length ?? 0;
					await until(models.models, (list) => shown(list) === 0, within("gone from the picker", ctx));
					assert.equal(shown(models.catalog!.value), 0);
					assert.equal(models.complete.value, false, "still loading the other login");
					release();
					await until(models.complete, (complete) => complete, within("complete again", ctx));
				});
			});
		});
	}
});

describe("a login's entries", () => {
	it("keep their identity when another login comes, whatever overrides name other models (Astra 5)", async () => {
		const a = await loginIn(family, "A");
		await settingsIn(session, [{ model: "absent", name: "X" }]);
		await holding(agent, async (models, ctx) => {
			await until(models.complete, (complete) => complete, within("complete", ctx));
			const [slim] = models.models.value;
			const [full] = models.catalog!.value;
			await loginIn(session, "B");
			const both = await listed(models, (list) => list.length === 2, ctx);
			assert.equal(
				both.find(({ login }) => login === a),
				slim,
			);
			assert.equal(
				models.catalog!.value.find(({ login }) => login === a),
				full,
			);
		});
	});

	it("keep their identity when an override of another provider type's model of the same id changes (Astra, round 2)", async () => {
		const a = await loginIn(family);
		const b = await w.host.root(
			(ctx) =>
				makeLogin(
					{ name: "Other", workspace: family, by: BY, provider: OTHER_PROVIDER, credential: CREDENTIAL },
					ctx,
				),
			context,
		);
		const settings = await settingsIn(session, []);
		await holding(agent, async (models, ctx) => {
			await until(models.complete, (complete) => complete, within("complete", ctx));
			const slim = models.models.value.find(({ login }) => login === a);
			const full = models.catalog!.value.find(({ login }) => login === a);
			const overrides = [{ provider: OTHER_PROVIDER, model: FAUX_MODEL, name: "Changed" }];
			await things.configure({ thing: settings, settings: { overrides } }, context);
			const list = await listed(
				models,
				(now) => now.find(({ login }) => login === b)?.models[0]?.name === "Changed",
				ctx,
			);
			assert.equal(
				list.find(({ login }) => login === a),
				slim,
			);
			assert.equal(
				models.catalog!.value.find(({ login }) => login === a),
				full,
			);
		});
	});

	it("keep their identity when a model settings thing without overrides of theirs comes (Opus S1)", async () => {
		await loginIn(family);
		await settingsIn(family, [{ model: "other-model", name: "X" }]);
		await holding(agent, async (models, ctx) => {
			await until(models.complete, (complete) => complete, within("complete", ctx));
			const [slim] = models.models.value;
			await settingsIn(session, []);
			// A login linked after it: once it is listed, the new settings thing was taken in before it.
			await loginIn(session, "B");
			const both = await listed(models, (list) => list.length === 2, ctx);
			assert.ok(both.includes(slim!));
		});
	});
});

describe("a reload of the providers plugin", () => {
	it("keeps a held session's models on the same hold, following the model settings after", async () => {
		await loginIn(family);
		const settings = await settingsIn(family, []);
		await holding(agent, async (models, ctx) => {
			await listed(models, (list) => list.length === 1, ctx);
			await w.reload(PROVIDERS, context);
			await things.configure(
				{ thing: settings, settings: { overrides: [{ model: FAUX_MODEL, name: "After" }] } },
				context,
			);
			await listed(models, (list) => list[0]?.models[0]?.name === "After", ctx);
		});
		assert.deepEqual(w.errors, []);
	});
});

describe("a released session's models", () => {
	it("are collected, and a model settings change after the release reports nothing", async () => {
		await loginIn(family);
		const settings = await settingsIn(family, []);
		const refs: WeakRef<object>[] = [];
		await holding(agent, async (models, ctx) => {
			await listed(models, (list) => list.length === 1, ctx);
			refs.push(new WeakRef(models), new WeakRef(models.models));
		});
		await things.configure(
			{ thing: settings, settings: { overrides: [{ model: FAUX_MODEL, name: "Later" }] } },
			context,
		);
		assert.ok(await collected(refs));
		assert.deepEqual(w.errors, []);
	});
});

describe("the model settings", () => {
	it("merge per field, the nearest first, into the list and the catalog; hidden leaves both", async () => {
		await loginIn(family);
		const cost = { input: 7, output: 7, cacheRead: 0, cacheWrite: 0 };
		await settingsIn(family, [
			{ model: FAUX_MODEL, contextWindow: 4242, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
		]);
		const nearer = await settingsIn(session, [{ model: FAUX_MODEL, cost, name: "Nearer" }]);
		await holding(agent, async (models, ctx) => {
			const [entry] = await listed(models, (list) => list[0]?.models[0]?.name === "Nearer", ctx);
			assert.equal(entry!.models[0]!.contextWindow, 4242);
			const catalog = await until(models.catalog!, (list) => list.length === 1, within("the catalog", ctx));
			const full = catalog[0]!.models[0] as { cost: unknown; contextWindow: number };
			assert.deepEqual([full.cost, full.contextWindow], [cost, 4242]);
			await things.configure(
				{ thing: nearer, settings: { overrides: [{ model: FAUX_MODEL, hidden: true }] } },
				context,
			);
			await listed(models, (list) => list[0]?.models.length === 0, ctx);
			await until(models.catalog!, (list) => list[0]?.models.length === 0, within("the hidden model", ctx));
		});
	});

	it("refuse a negative price (Astra, round 1)", async () => {
		const settings = await settingsIn(session, []);
		await as(agent, async (ctx) => {
			const held = await ctx.get(ModelSettings, { workspace: session, thing: settings });
			const cost = { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 };
			await assert.rejects(held.set!({ overrides: [{ model: FAUX_MODEL, cost }] }, ctx));
		});
	});

	it("are changed by the agent through Edit; it has no Configure where a login is linked (118d)", async () => {
		await loginIn(session);
		const settings = await settingsIn(session, []);
		await as(agent, async (ctx) => {
			const held = await ctx.get(ModelSettings, { workspace: session, thing: settings });
			await held.set!({ overrides: [{ model: FAUX_MODEL, name: "By the agent" }] }, ctx);
			const workspace = await ctx.get(Workspace, { workspace: session });
			assert.equal(workspace.configure, undefined);
			// Edit withheld from the agents: the same hold loses `set`.
			await things.setGrants(
				{
					source: BY,
					grants: [{ workspace: session, thing: settings, party: { kind: "agents" }, tick: "edit", gives: false }],
				},
				context,
			);
			await until(
				held.state,
				(state) => state.kind === "live" && held.set === undefined,
				within("set withheld", ctx),
			);
		});
		await holding(agent, async (models, ctx) => {
			await listed(models, (list) => list[0]?.models[0]?.name === "By the agent", ctx);
		});
	});
});
