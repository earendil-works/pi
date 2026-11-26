// The built-in provider types' catalogs (`builtin-catalogs.ts`) against a fake pi.dev, with the login's models: every
// built-in type but Radius requests its catalog once at the start, as the bundled pi-ai, without `?types`; a newer
// catalog's model reaches a login of the type (its `login` and its `catalog`), an older one doesn't; a reload starts
// the types again from their stored entries: one checked a moment ago requests nothing, one due revalidates by its
// ETag and a 304 keeps its models; a failed answer keeps the stored entry; without network no type requests anything.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, type P3Principal, until } from "@earendil-works/p3/v1";
import { builtinProviders, formatUserAgent, getBuiltinModelDataGeneratedAt } from "@earendil-works/p3/v1/server";
import { eventually, within } from "../../../test/until.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import type { Source } from "../../things/contract.ts";
import type { World } from "../../things/test/world.ts";
import { type CatalogEntry, CatalogStore } from "../contract.server.ts";
import { Login } from "../kind.ts";
import { makeLogin } from "../logins.ts";
import { type FakePiDev, fakePiDev } from "./fake-pi-dev.ts";
import { PROVIDERS, providersWorld } from "./hosts.ts";

/** Who sets things up. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** The session's agent, who holds the login. */
const AGENT: P3Principal = { kind: "worker", session: "s1" };

/** Anthropic's first shipped model, as the base of the catalog's new one. */
const SHIPPED = builtinProviders()
	.find(({ id }) => id === "anthropic")!
	.getModels()[0]!;

/** A model the shipped data doesn't have. */
const NEWER = { ...SHIPPED, id: "claude-from-pi-dev", name: "Claude from pi.dev" };

/** A Last-Modified after the shipped data's date, and one before it. */
const AFTER = new Date((getBuiltinModelDataGeneratedAt() ?? 0) + 86_400_000).toUTCString();
const BEFORE = new Date((getBuiltinModelDataGeneratedAt() ?? 0) - 86_400_000).toUTCString();

let fake: FakePiDev | undefined;
let w: World | undefined;

afterEach(async () => {
	await w?.close(context);
	await fake?.close();
	w = undefined;
	fake = undefined;
});

/** A host whose types request their catalogs at a fake pi.dev, `answer` for Anthropic's; an Anthropic login there. */
async function served(answer: Parameters<FakePiDev["answer"]>[1]) {
	fake = await fakePiDev();
	fake.answer("anthropic", answer);
	const world = await providersWorld(context, new Set(), [], fake.baseUrl);
	w = world;
	const things = await world.host.get(ThingsStore, {}, context);
	const pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	const workspace = await things.createWorkspace(
		{ kind: "things.workspace", name: "s1", parent: pi, by: BY },
		context,
	);
	await things.putParty({ workspace, party: { kind: "agent", session: "s1" }, source: BY }, context);
	const credential = { type: "api_key", key: "test-only" };
	const thing = await world.host.root(
		(ctx) => makeLogin({ name: "Anthropic", workspace, by: BY, provider: "anthropic", credential }, ctx),
		context,
	);
	/** The login's model ids, as the agent holding it sees them once `done` holds for them. */
	const models = (done: (ids: readonly string[]) => boolean) =>
		world.host.root(
			async (ctx) => {
				const login = await ctx.get(Login, { workspace, thing });
				const catalog = await until(
					login.catalog!,
					(now) => done(now.map((found) => (found as { id: string }).id)),
					within("the login's catalog", ctx, 10_000),
				);
				const shown = await until(login.login, (now) => now !== null, within("the login", ctx));
				return {
					catalog: catalog.map((found) => (found as { id: string }).id),
					shown: shown!.models.map(({ id }) => id),
				};
			},
			context,
			{ principal: AGENT },
		);
	/** Anthropic's stored entry, once there. */
	const stored = () =>
		eventually(
			async () =>
				(
					await (
						await world.host.get(CatalogStore, {}, context)
					).catalogs.one.page({ provider: "anthropic" }, 1, context)
				).items,
			(rows) => rows.length > 0,
			10_000,
		).then((rows) => rows[0]!.entry);
	return { world, models, stored };
}

/** The requests for `provider` the fake got. */
const hitsOf = (provider: string) => fake!.hits.filter((hit) => hit.provider === provider);

describe("the built-in types' catalogs", () => {
	it("request once each at the start, as the bundled pi-ai, without types; never Radius", async () => {
		await served(() => ({ status: 404 }));
		const expected = builtinProviders()
			.map(({ id }) => id)
			.filter((id) => id !== "radius")
			.sort();
		await eventually(
			async () => [...new Set(fake!.hits.map(({ provider }) => provider))].sort(),
			(requested) => requested.length === expected.length,
			10_000,
		);
		assert.deepEqual([...new Set(fake!.hits.map(({ provider }) => provider))].sort(), expected);
		assert.equal(fake!.hits.length, expected.length, "one request each");
		for (const hit of fake!.hits) {
			assert.equal(hit.userAgent, formatUserAgent());
			assert.equal(hit.search, "");
		}
		assert.match(formatUserAgent(), /^pi\/\d+\.\d+\.\d+/);
	});

	it("bring a newer catalog's model to a login of the type, in its catalog and its models", async () => {
		const { models } = await served(() => ({
			status: 200,
			headers: { "last-modified": AFTER, etag: '"e1"' },
			body: { [NEWER.id]: NEWER },
		}));
		const seen = await models((ids) => ids.includes(NEWER.id));
		assert.ok(seen.catalog.includes(SHIPPED.id), "the shipped models stay");
		assert.ok(seen.shown.includes(NEWER.id));
	});

	it("leave a catalog older than the shipped data out", async () => {
		const { models, stored } = await served(() => ({
			status: 200,
			headers: { "last-modified": BEFORE },
			body: { [NEWER.id]: NEWER },
		}));
		assert.equal((await stored()).models.length, 1);
		const seen = await models(() => true);
		assert.ok(!seen.catalog.includes(NEWER.id));
	});

	it("start again from the stored entries after a reload: nothing for one checked a moment ago", async () => {
		const { world, stored } = await served(() => ({
			status: 200,
			headers: { "last-modified": AFTER, etag: '"e1"' },
			body: { [NEWER.id]: NEWER },
		}));
		await stored();
		await world.reload(PROVIDERS, context);
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(hitsOf("anthropic").length, 1);
	});

	it("revalidate a due entry by its ETag after a reload; a 304 keeps its models", async () => {
		const { world, stored, models } = await served((hit) =>
			hit.ifNoneMatch === '"e1"'
				? { status: 304 }
				: { status: 200, headers: { "last-modified": AFTER, etag: '"e1"' }, body: { [NEWER.id]: NEWER } },
		);
		const first = await stored();
		// Checked five hours ago: due.
		const due: CatalogEntry = { ...first, checkedAt: Date.now() - 5 * 3_600_000 };
		await (await world.host.get(CatalogStore, {}, context)).write({ provider: "anthropic", entry: due }, context);
		await world.reload(PROVIDERS, context);
		await eventually(
			async () => hitsOf("anthropic").length,
			(count) => count === 2,
			10_000,
		);
		assert.equal(hitsOf("anthropic")[1]!.ifNoneMatch, '"e1"');
		const after = await eventually(stored, (entry) => entry.checkedAt > due.checkedAt, 10_000);
		assert.equal(after.models.length, 1);
		assert.ok((await models((ids) => ids.includes(NEWER.id))).catalog.includes(NEWER.id));
	});

	it("keep the stored entry when pi.dev fails", async () => {
		let failing = false;
		const { world, stored } = await served(() =>
			failing
				? { status: 503 }
				: { status: 200, headers: { "last-modified": AFTER, etag: '"e1"' }, body: { [NEWER.id]: NEWER } },
		);
		const first = await stored();
		failing = true;
		const due: CatalogEntry = { ...first, checkedAt: Date.now() - 5 * 3_600_000 };
		await (await world.host.get(CatalogStore, {}, context)).write({ provider: "anthropic", entry: due }, context);
		await world.reload(PROVIDERS, context);
		await eventually(
			async () => hitsOf("anthropic").length,
			(count) => count === 2,
			10_000,
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.deepEqual(await stored(), due);
	});

	it("request nothing without network", async () => {
		const original = globalThis.fetch;
		const requested: string[] = [];
		globalThis.fetch = (input, init) => {
			requested.push(String(input));
			return original(input, init);
		};
		try {
			w = await providersWorld(context, new Set());
			await new Promise((resolve) => setTimeout(resolve, 300));
		} finally {
			globalThis.fetch = original;
		}
		assert.deepEqual(requested, []);
	});
});
