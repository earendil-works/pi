// The built-in provider types' catalogs (`builtin-catalogs.ts`) against a fake pi.dev, with the login's models: every
// built-in type but Radius requests its catalog once at the start, as the bundled pi-ai, without `?types`; a newer
// catalog's model reaches a login of the type (its `login` and its `catalog`) with the shipped endpoint and headers, an
// older one doesn't; a reload starts the types again from their stored catalogs: one checked a moment ago requests
// nothing, one due revalidates by its ETag and a 304 keeps its body; a failed answer, a malformed body, one too large
// (streamed: the reader stops early; declared: not read at all) keep the stored catalog, and the failure's retry waits
// across a reload; without network no type requests anything. On a mocked clock, the loop itself: four hours after an
// answer, a quarter of an hour after a failure, a request given ten seconds, a store that fails waited out (Opus, Astra
// and Fable, rounds 1 and 2 of the catalog).

import assert from "node:assert/strict";
import { afterEach, describe, it, type TestContext } from "node:test";
import { type Api, BACKGROUND_CONTEXT as context, type Model, type P3Principal, until } from "@earendil-works/p3/v1";
import { builtinProviders, formatUserAgent, getBuiltinModelDataGeneratedAt } from "@earendil-works/p3/v1/server";
import { eventually, within } from "../../../test/until.ts";
import { ThingsStore } from "../../things/contract.server.ts";
import type { Source } from "../../things/contract.ts";
import type { World } from "../../things/test/world.ts";
import { builtinCatalogs } from "../builtin-catalogs.ts";
import { CHECK_EVERY_MS, RETRY_AFTER_MS } from "../catalog.ts";
import { type CatalogEntry, type CatalogStatus, CatalogStore, LoginAccount } from "../contract.server.ts";
import { Login } from "../kind.ts";
import type { CatalogContext } from "../login-catalogs.ts";
import { makeLogin } from "../logins.ts";
import { type FakeAnswer, type FakePiDev, fakePiDev } from "./fake-pi-dev.ts";
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
	const world = await providersWorld(context, [], fake.baseUrl);
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
				// The account's models, as `SessionModels` gets them: pi-ai's definitions, as the worker gets them.
				const account = (await ctx.get(LoginAccount, { thing })).account;
				const found = await until(
					account,
					(now) => now !== null && done(now.models.map((model) => (model as { id: string }).id)),
					within("the login's account", ctx, 10_000),
				);
				const shown = await until(login.login, (now) => now !== null, within("the login", ctx));
				const full = found!.models as Model<Api>[];
				return { catalog: full.map(({ id }) => id), shown: shown!.models.map(({ id }) => id), full };
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
	const catalogs = () => world.host.get(CatalogStore, {}, context);
	/** Anthropic's stored timing. */
	const status = async () => (await catalogs()).status({ provider: "anthropic" }, context);
	return { world, models, stored, status };
}

/** Makes `entry` Anthropic's catalog answered five hours ago (due), and reloads the providers plugin: it requests. */
async function dueAgain(world: World, entry: CatalogEntry): Promise<void> {
	const catalogs = await world.host.get(CatalogStore, {}, context);
	await catalogs.write({ provider: "anthropic", entry, at: Date.now() - 5 * 3_600_000 }, context);
	await world.reload(PROVIDERS, context);
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
		// An absence (testing.md 2): a request after the reload would come at once, the loops start with it.
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(hitsOf("anthropic").length, 1);
	});

	it("revalidate a due entry by its ETag after a reload; a 304 keeps its models", async () => {
		const { world, stored, models, status } = await served((hit) =>
			hit.ifNoneMatch === '"e1"'
				? { status: 304 }
				: { status: 200, headers: { "last-modified": AFTER, etag: '"e1"' }, body: { [NEWER.id]: NEWER } },
		);
		const first = await stored();
		await dueAgain(world, first);
		await eventually(
			async () => hitsOf("anthropic").length,
			(count) => count === 2,
			10_000,
		);
		assert.equal(hitsOf("anthropic")[1]!.ifNoneMatch, '"e1"');
		await eventually(status, (now) => now !== null && now.checkedAt > Date.now() - 60_000, 10_000);
		assert.deepEqual(await stored(), first, "the body stays");
		assert.ok((await models((ids) => ids.includes(NEWER.id))).catalog.includes(NEWER.id));
	});

	it("keep the stored entry when pi.dev fails, its retry a quarter of an hour away after a reload (Astra)", async () => {
		let failing = false;
		const { world, stored, status } = await served(() =>
			failing
				? { status: 503 }
				: { status: 200, headers: { "last-modified": AFTER, etag: '"e1"' }, body: { [NEWER.id]: NEWER } },
		);
		const first = await stored();
		failing = true;
		await dueAgain(world, first);
		await eventually(status, (now) => now !== null && now.failedAt > 0, 10_000);
		assert.equal(hitsOf("anthropic").length, 2);
		assert.deepEqual(await stored(), first);
		// The failure is stored: a reload does not request again at once.
		await world.reload(PROVIDERS, context);
		// An absence (testing.md 2): a request after the reload would come at once.
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(hitsOf("anthropic").length, 2);
	});

	it("keep the stored entry for a body that is malformed or too large (Astra)", async () => {
		let answer: "good" | "array" | "huge" = "good";
		const { world, stored, status } = await served(() => {
			const headers = { "last-modified": AFTER, etag: '"e1"' };
			if (answer === "array") return { status: 200, headers, body: [NEWER] };
			if (answer === "huge")
				return { status: 200, headers, body: { [NEWER.id]: { ...NEWER, padding: "x".repeat(5 * 1024 * 1024) } } };
			return { status: 200, headers, body: { [NEWER.id]: NEWER } };
		});
		const first = await stored();
		for (const bad of ["array", "huge"] as const) {
			answer = bad;
			const before = hitsOf("anthropic").length;
			await dueAgain(world, first);
			await eventually(
				async () => [hitsOf("anthropic").length, (await status())?.failedAt ?? 0] as const,
				([count, failedAt]) => count === before + 1 && failedAt > 0,
				10_000,
			);
			assert.deepEqual(await stored(), first, bad);
		}
	});

	it("stop reading a body over 4 MiB streamed without a Content-Length (Opus, round 2)", async () => {
		let streaming = false;
		const total = 16 * 1024 * 1024;
		const { world, stored, status } = await served(
			(): FakeAnswer =>
				streaming
					? {
							status: 200,
							headers: { "last-modified": AFTER },
							stream: {
								prefix: '{"big":{"id":"big","padding":"',
								chunk: "x".repeat(64 * 1024),
								count: total / (64 * 1024),
							},
						}
					: { status: 200, headers: { "last-modified": AFTER, etag: '"e1"' }, body: { [NEWER.id]: NEWER } },
		);
		const first = await stored();
		streaming = true;
		await dueAgain(world, first);
		await eventually(status, (now) => now !== null && now.failedAt > 0, 10_000);
		const [, big] = hitsOf("anthropic");
		assert.ok(big!.sent < total / 2, `the reader stopped early: ${big!.sent} bytes sent`);
		assert.deepEqual(await stored(), first);
	});

	it("refuse a body that declares a Content-Length over 4 MiB, without reading it (Opus, round 2)", async () => {
		let declaring = false;
		const { world, stored, status } = await served(
			(): FakeAnswer =>
				declaring
					? { status: 200, headers: { "content-length": String(5 * 1024 * 1024) }, body: {}, open: true }
					: { status: 200, headers: { "last-modified": AFTER, etag: '"e1"' }, body: { [NEWER.id]: NEWER } },
		);
		const first = await stored();
		declaring = true;
		const started = Date.now();
		await dueAgain(world, first);
		await eventually(status, (now) => now !== null && now.failedAt > 0, 10_000);
		// At once, not at the request's ten seconds: the declared length alone refuses it.
		assert.ok(Date.now() - started < 5_000);
		assert.deepEqual(await stored(), first);
	});

	it("serve a catalog model with the shipped endpoint and headers, never its own (Astra, Opus)", async () => {
		const foreign = { ...NEWER, baseUrl: "https://elsewhere.invalid/v1", headers: { "x-catalog": "1" } };
		const { models } = await served(() => ({
			status: 200,
			headers: { "last-modified": AFTER },
			body: { [foreign.id]: foreign },
		}));
		const { full } = await models((ids) => ids.includes(NEWER.id));
		const found = full.find(({ id }) => id === NEWER.id)!;
		assert.equal(found.baseUrl, SHIPPED.baseUrl);
		assert.deepEqual(found.headers, SHIPPED.headers);
		assert.equal(found.api, SHIPPED.api);
	});

	it("request nothing without network", async () => {
		const original = globalThis.fetch;
		const requested: string[] = [];
		globalThis.fetch = (input, init) => {
			requested.push(String(input));
			return original(input, init);
		};
		try {
			w = await providersWorld(context);
			// An absence (testing.md 2): the loops start with the host, a request would come at once.
			await new Promise((resolve) => setTimeout(resolve, 300));
		} finally {
			globalThis.fetch = original;
		}
		assert.deepEqual(requested, []);
	});
});

/** A stored catalog in memory, as a type's run gets it, and what was written to it. */
function memoryStore() {
	const kept: { status: CatalogStatus | null; entry: CatalogEntry | undefined; failing: number } = {
		status: null,
		entry: undefined,
		failing: 0,
	};
	const store: CatalogContext["store"] = {
		status: async () => {
			if (kept.failing > 0 && kept.failing--) throw new Error("the store failed");
			return kept.status;
		},
		read: async () => kept.entry,
		write: async (entry, at) => {
			kept.entry = entry;
			kept.status = { checkedAt: at, failedAt: 0 };
		},
		checked: async (at) => {
			kept.status = { checkedAt: at, failedAt: 0 };
		},
		failed: async (at) => {
			kept.status = { checkedAt: kept.status?.checkedAt ?? 0, failedAt: at };
		},
	};
	return { kept, store };
}

/** Lets every pending promise settle (mocked timers leave `setImmediate` real). */
async function settled(): Promise<void> {
	for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
}

describe("a built-in type's loop, on a mocked clock (Opus, Fable)", () => {
	/** Runs Anthropic's loop with `answers` for its requests in turn (a function: the request's signal). */
	async function looping(t: TestContext, answers: ((signal: AbortSignal) => Promise<Response>)[], failing = 0) {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000_000 });
		const calls: number[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = async (_input, init) => {
			calls.push(Date.now());
			return answers.shift()!(init!.signal!);
		};
		const stop = new AbortController();
		t.after(() => {
			stop.abort();
			globalThis.fetch = original;
		});
		const { kept, store } = memoryStore();
		kept.failing = failing;
		const [catalog] = builtinCatalogs(
			builtinProviders().filter(({ id }) => id === "anthropic"),
			{ baseUrl: "https://pi.example", userAgent: "pi/test" },
		);
		void catalog!.run({ store, signal: stop.signal });
		/** Moves the clock by `ms`, then lets the loop react. */
		const tick = async (ms: number) => {
			await settled();
			t.mock.timers.tick(ms);
			await settled();
		};
		return { calls, kept, tick };
	}

	const answered = () => async () => Response.json({}, { headers: { "last-modified": AFTER, etag: '"e1"' } });

	it("requests at once, then again four hours after the answer, not before", async (t) => {
		const { calls, kept, tick } = await looping(t, [answered(), answered()]);
		await tick(0);
		assert.equal(calls.length, 1);
		assert.ok(kept.status !== null && kept.status.failedAt === 0);
		await tick(CHECK_EVERY_MS - 1);
		assert.equal(calls.length, 1);
		await tick(1);
		assert.equal(calls.length, 2);
	});

	it("requests again a quarter of an hour after a failure", async (t) => {
		const { calls, kept, tick } = await looping(t, [async () => new Response(null, { status: 503 }), answered()]);
		await tick(0);
		assert.equal(calls.length, 1);
		assert.ok((kept.status?.failedAt ?? 0) > 0);
		await tick(RETRY_AFTER_MS - 1);
		assert.equal(calls.length, 1);
		await tick(1);
		assert.equal(calls.length, 2);
		assert.equal(kept.status?.failedAt, 0, "the answer clears the failure");
	});

	it("gives a request ten seconds, then counts it failed and retries a quarter of an hour later", async (t) => {
		const never = (signal: AbortSignal) =>
			new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
		const { calls, kept, tick } = await looping(t, [never, answered()]);
		await tick(0);
		assert.equal(calls.length, 1);
		await tick(10_000 - 1);
		assert.equal(kept.status, null, "still waiting");
		await tick(1);
		assert.ok(((kept.status as CatalogStatus | null)?.failedAt ?? 0) > 0);
		await tick(RETRY_AFTER_MS);
		assert.equal(calls.length, 2);
	});

	it("waits as after a failure when its store fails, and goes on (Opus)", async (t) => {
		const { calls, kept, tick } = await looping(t, [answered()], 1);
		await tick(0);
		assert.equal(calls.length, 0, "the status read failed: no request yet");
		await tick(RETRY_AFTER_MS - 1);
		assert.equal(calls.length, 0);
		await tick(1);
		assert.equal(calls.length, 1);
		assert.ok(kept.status !== null);
	});
});
