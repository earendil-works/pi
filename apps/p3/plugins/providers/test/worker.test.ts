// The providers plugin on a session's worker (`testPlugin`, beside the faux login's worker facet): each login the
// agent holds with Use gives one provider of its own (`<provider>~<login>`), two logins of one provider two providers,
// its models the login's catalog; a login without Use gives none; a request through it takes its auth from the
// login's `authorize` and reaches the provider's request code (another plugin's, else pi-ai's, loaded on first use)
// with the provider's own id, at each request the provider contributed then (a plugin replaced while a login is held
// answers with its new code), and nothing sent for a model hidden while the code loads. That `authorize` admits only
// agents with Use is the server's test (`server.test.ts`).

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	allow,
	constant,
	BACKGROUND_CONTEXT as context,
	createHost,
	defineFacet,
	type JsonValue,
	LoginProviders,
	memoryLinkPair,
	openStore,
	type P3Principal,
	type PluginFacet,
	Server,
	Session,
	sqliteBackend,
	until,
	type Watchable,
	type Writable,
	withAbortSignal,
} from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type Provider,
	WorkerRuntime,
} from "@earendil-works/p3/v1/worker";
import { FAUX_MODEL, FAUX_PROVIDER, keyOf, type Step } from "../../../test/plugins/faux-login/contract.ts";
import fauxWorker from "../../../test/plugins/faux-login/worker.ts";
import { eventually, within } from "../../../test/until.ts";
import {
	type HarnessSession,
	type HeldThing,
	ThingHarnessParts,
	type ThingProvider,
} from "../../things/contract.worker.ts";
import thingsWorker from "../../things/worker.ts";
import { type LoginDefinitions, SessionModels } from "../contract.ts";
import { type Login, type LoginInfo, LoginKind, type RequestAuth } from "../kind.ts";
import providersWorker from "../worker.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session as the parts get it: its `call` runs the function at once (the login's `authorize` is a fake). */
const SESSION: HarnessSession = {
	session: "s1",
	workspace: "w1",
	call: (fn) => fn({} as never),
	location: async () => undefined,
	moveLocation: () => Promise.reject(new Error("no move")),
};

/** What a faux login shows. */
const FAUX: LoginInfo = {
	provider: FAUX_PROVIDER,
	providerName: "Faux",
	method: "api_key",
	status: "signedIn",
	models: [],
};

/** The faux provider's models, as the server's catalog has them. */
const CATALOG = fauxProvider({ provider: FAUX_PROVIDER, api: "faux", models: [{ id: FAUX_MODEL }] }).models;

/** The model providers the recording provider's request code was given, in order. */
const given: string[] = [];

/** A provider (`rec`) whose request code records the model's provider, then answers as the faux one. */
const recording = defineFacet((_host, self) => {
	const base = fauxProvider({ provider: "rec", api: "rec", models: [{ id: "m" }] });
	base.setResponses([fauxAssistantMessage("recorded")]);
	self.contribute(LoginProviders, [
		{
			...base.provider,
			streamSimple: (model, context, options) => {
				given.push(model.provider);
				return base.provider.streamSimple(model, context, options);
			},
		},
	]);
});

/** A faux script. */
const SCRIPT: Step[] = [{ when: "hello", reply: [{ kind: "text", text: "hi there" }] }];

/** The models of the logins the tests hold, as the stand-in server's `SessionModels.catalog` lists them. */
const CATALOGS: LoginDefinitions[] = [
	...["a", "b", "c", "x"].map((login) => ({ login, models: [...CATALOG] })),
	{ login: "r", models: [...fauxProvider({ provider: "rec", api: "rec", models: [{ id: "m" }] }).models] },
	{ login: "w", models: [...fauxProvider({ provider: "swap", api: "swap", models: [{ id: "m" }] }).models] },
];

/** The stand-in server's `complete` and catalog of the case running (set by its object). */
let complete: Writable<boolean> | undefined;
let catalog: Writable<JsonValue> | undefined;

/**
 * The stand-in server: `SessionModels` with `CATALOGS`, complete until a case says otherwise, its catalog granted to
 * the session's worker.
 */
const sessionModels = defineFacet((host) =>
	// pi-ai's definitions are JSON: the catalog as the member types it.
	host.serve(
		SessionModels,
		(_params, _principal, _admitted, self) => {
			complete = self.writable(true);
			catalog = self.writable(CATALOGS as unknown as JsonValue);
			const current = self.derive([catalog], ([now]) => now);
			return {
				complete: self.derive([complete], ([now]) => now),
				models: constant([]),
				catalog: () => current as unknown as Watchable<LoginDefinitions[]>,
			};
		},
		{
			admit: () => constant(allow({ granted: ["catalog" as const] })),
		},
	),
);

/**
 * A login `thing` the agent holds: `authorize` answers `script` as the key, left out without Use; it shows `login`.
 * Its models are its entry in `CATALOGS`.
 */
function held(
	thing: string,
	script: readonly Step[] | undefined,
	calls: string[] = [],
	login: LoginInfo = FAUX,
): HeldThing<typeof Login> {
	const authorize =
		script === undefined
			? undefined
			: async (): Promise<RequestAuth> => {
					calls.push(thing);
					return { auth: { apiKey: keyOf(script) } };
				};
	// The part reads the reference's `login` and `authorize` only.
	const ref = { login: { value: login }, authorize } as unknown as HeldThing<typeof Login>["ref"];
	return { thing, workspace: "w1", depth: 0, ref };
}

describe("the providers of the logins the agent holds", () => {
	let t: TestedPlugin<P3Principal>;

	beforeEach(async () => {
		t = await testPlugin(
			ROOT,
			{
				kind: "worker",
				session: "s1",
				stubs: [
					{ name: "p3-test-faux-login", facet: fauxWorker },
					{ name: "recording", facet: recording },
				],
				server: [{ name: "p3-session-models", facet: sessionModels }],
			},
			context,
		);
	});

	/** Waits until the worker has the stand-in server's catalog (its hold of `SessionModels` is live). */
	async function catalogued(): Promise<void> {
		await eventually(
			async () => providers(held("a", SCRIPT))[0]!.provider.getModels().length,
			(count) => count > 0,
			5_000,
		);
	}

	afterEach(() => t.close(context));

	/** What the login kind's part gives `things`. */
	function providers(...things: HeldThing<typeof Login>[]): readonly ThingProvider[] {
		const [entry] = t.contributions(ThingHarnessParts);
		assert.equal(entry?.value.kind.name, LoginKind.name);
		// The registry's parts take any kind's held things; the holding gives this one only logins.
		return entry.value.part(things as unknown as readonly HeldThing[], SESSION).providers ?? [];
	}

	it("is one per login with Use, its id the provider's and the login's, its models the session's for it", async () => {
		await catalogued();
		const given = providers(held("a", SCRIPT), held("b", SCRIPT), held("c", undefined));
		assert.deepEqual(
			given.map(({ thing, provider }) => [thing, provider.id]),
			[
				["a", `${FAUX_PROVIDER}~a`],
				["b", `${FAUX_PROVIDER}~b`],
			],
		);
		assert.deepEqual(
			given[0]!.provider.getModels().map(({ id, provider }) => [id, provider]),
			[[FAUX_MODEL, `${FAUX_PROVIDER}~a`]],
		);
	});

	it("is ready once the session's models are complete; cut off before, it names the logins still missing", async () => {
		await catalogued();
		const [entry] = t.contributions(ThingHarnessParts);
		const things = [held("a", SCRIPT), held("missing", SCRIPT)] as unknown as readonly HeldThing[];
		const given = entry!.value.part(things, SESSION);
		await given.ready!(context);
		complete!.set(false);
		// Once the worker has the change, a `ready` cut off by its context fails.
		const failure = await eventually(
			() =>
				given.ready!(withAbortSignal(AbortSignal.timeout(50), context)).then(
					() => "ready",
					(error: Error) => error.message,
				),
			(message) => message !== "ready",
			5_000,
		);
		assert.match(failure, /the models of logins missing are still loading/);
	});

	it("loads no request code until a request; one for a provider nobody has fails that request only", async () => {
		await catalogued();
		const [{ provider }] = providers(held("x", SCRIPT, [], { ...FAUX, provider: "nobody" }));
		assert.equal(provider.id, "nobody~x");
		const models = createModels();
		models.setProvider(provider);
		const answer = await models.completeSimple(provider.getModels()[0]!, {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		});
		assert.equal(answer.stopReason, "error");
		assert.match(answer.errorMessage ?? "", /no request code for the provider nobody/);
	});

	it("hands the request code the model under its provider's own id (request code checks it)", async () => {
		given.length = 0;
		await catalogued();
		const [{ provider }] = providers(held("r", SCRIPT, [], { ...FAUX, provider: "rec" }));
		const models = createModels();
		models.setProvider(provider);
		await models.completeSimple(models.getModel("rec~r", "m")!, {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		});
		assert.deepEqual(given, ["rec"]);
	});

	it("sends nothing for a model hidden while its built-in request code still loads (Astra, round 2 recheck)", async () => {
		await catalogued();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const sent: string[] = [];
		const faux = fauxProvider({ provider: "openai", api: "faux", models: [{ id: FAUX_MODEL }] });
		faux.setResponses([fauxAssistantMessage("received")]);
		const recording: Provider = {
			...faux.provider,
			streamSimple: (model, context, options) => {
				sent.push(model.id);
				return faux.provider.streamSimple(model, context, options);
			},
		};
		// pi-ai's OpenAI module, loaded on the first request, stands in by a module that waits until released.
		const slow = { entered, release, provider: recording };
		Object.assign(globalThis, { __slowProvider: slow });
		const module = [
			"const slow = globalThis.__slowProvider;",
			"slow.entered.resolve();",
			"await slow.release.promise;",
			"export const openaiProvider = () => slow.provider;",
		].join("\n");
		const hooks = registerHooks({
			resolve: (specifier, hookContext, next) =>
				specifier === "@earendil-works/pi-ai/providers/openai"
					? { url: `data:text/javascript,${encodeURIComponent(module)}`, shortCircuit: true }
					: next(specifier, hookContext),
		});
		try {
			const [{ provider }] = providers(held("a", SCRIPT, [], { ...FAUX, provider: "openai" }));
			const models = createModels();
			models.setProvider(provider);
			const asked = models.completeSimple(provider.getModels()[0]!, {
				messages: [{ role: "user", content: "hello", timestamp: 0 }],
			});
			await entered.promise;
			// The model leaves the complete catalog while the code loads; the worker has the change before the load ends.
			catalog!.set([]);
			await eventually(
				() => provider.getModels().length,
				(count) => count === 0,
				5_000,
			);
			release.resolve();
			const answer = await asked;
			assert.equal(answer.stopReason, "error");
			assert.deepEqual(sent, []);
		} finally {
			release.resolve();
			hooks.deregister();
			Reflect.deleteProperty(globalThis, "__slowProvider");
		}
	});

	it("answers a request with the login's auth, through the provider's own request code", async () => {
		const calls: string[] = [];
		await catalogued();
		const [{ provider }] = providers(held("a", SCRIPT, calls));
		const models = createModels();
		models.setProvider(provider);
		const model = models.getModel(`${FAUX_PROVIDER}~a`, FAUX_MODEL)!;
		const answer = await models.completeSimple(model, {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		});
		assert.deepEqual(answer.content, [{ type: "text", text: "hi there" }]);
		assert.equal(answer.provider, FAUX_PROVIDER);
		assert.deepEqual(calls, ["a"]);
	});
});

describe("a provider replaced while a login is held", () => {
	it("answers the next request with its new code", async () => {
		const answering = (text: string) =>
			defineFacet((_host, self) => {
				const base = fauxProvider({ provider: "swap", api: "swap", models: [{ id: "m" }] });
				base.setResponses([fauxAssistantMessage(text), fauxAssistantMessage(text)]);
				self.contribute(LoginProviders, [base.provider]);
			});
		const store = await openStore(sqliteBackend(new NodeSqliteDatabase(new DatabaseSync(":memory:"))), context);
		const host = createHost<P3Principal>({
			address: Session({ id: "s1" }),
			principal: { kind: "worker", session: "s1" },
			store,
			onError: (error) => assert.fail(error.kind),
		});
		// The stand-in server, linked: the session's models a request waits for.
		const server = createHost<P3Principal>({
			address: Server(),
			principal: { kind: "server" },
			onError: (error) => assert.fail(error.kind),
		});
		await server.load([{ name: "p3-session-models", facet: sessionModels }], context);
		const [up, down] = memoryLinkPair();
		server.accept(down, { principal: { kind: "worker", session: "s1" } }, context);
		host.connect(up, { principal: { kind: "server" } }, context);
		let facets: PluginFacet<P3Principal>[] = [
			{ name: "@earendil-works/p3-providers", facet: providersWorker },
			{ name: "@earendil-works/p3-things", facet: thingsWorker },
			{ name: "swap", facet: answering("first") },
			// The worker's runtime as far as the providers plugin reads it: the session and its host.
			{
				name: "p3-base",
				facet: defineFacet((facetHost) =>
					facetHost.serve(WorkerRuntime, { compose: () => ({ session: "s1", host }) as unknown as WorkerRuntime }),
				),
			},
		];
		try {
			await host.load(facets, context);
			const login = held("w", SCRIPT, [], { ...FAUX, provider: "swap" });
			// The part is contributed once the plugin's contributing object is live.
			const parts = await until(
				await host.registry(ThingHarnessParts, context),
				(found) => found.has(LoginKind.name),
				within("the login kind's part", context),
			);
			const part = parts.get(LoginKind.name);
			const [{ provider }] = part!.value.part([login as unknown as HeldThing], SESSION).providers ?? [];
			const models = createModels();
			models.setProvider(provider);
			// No server here: the model as the session's catalog would give it, under the login's provider id.
			const [shipped] = fauxProvider({ provider: "swap", api: "swap", models: [{ id: "m" }] }).models;
			const model = { ...shipped!, provider: "swap~w" };
			const ask = async () =>
				(
					await models.completeSimple(model, {
						messages: [{ role: "user", content: "hello", timestamp: 0 }],
					})
				).content;
			assert.deepEqual(await ask(), [{ type: "text", text: "first" }]);
			facets = facets.map((plugin) => (plugin.name === "swap" ? { ...plugin, facet: answering("second") } : plugin));
			await host.reload(facets, context);
			assert.deepEqual(await ask(), [{ type: "text", text: "second" }]);
		} finally {
			await host.close(context);
			await server.close(context);
			await store.close(context);
		}
	});
});
