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
	type Ctx,
	BACKGROUND_CONTEXT as context,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { FAUX_MODEL, FAUX_PROVIDER, keyOf } from "../../../test/plugins/faux-login/contract.ts";
import { collected, within } from "../../../test/until.ts";
import environmentsServer from "../../environments/server.ts";
import sessionsServer from "../../sessions/server.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import type { Source } from "../../things/contract.ts";
import type { World } from "../../things/test/world.ts";
import { Workspace } from "../../things/workspace.ts";
import { type LoginModels, type ModelOverride, SessionModels } from "../contract.ts";
import { makeLogin } from "../logins.ts";
import { ModelSettings, ModelSettingsKind } from "../models-kind.ts";
import { PROVIDERS, providersWorld } from "./hosts.ts";

/** Who sets things up. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** A faux login's credential. */
const CREDENTIAL = { type: "api_key", key: keyOf([]) };

let w: World;
let things: Reference<typeof ThingsStore>;
let family: string;
let session: string;
/** The session's agent (its worker). */
let agent: P3Principal;

beforeEach(async () => {
	w = await providersWorld(context, new Set(), [
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
