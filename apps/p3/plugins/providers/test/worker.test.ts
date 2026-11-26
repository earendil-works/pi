// The providers plugin on a session's worker (`testPlugin`, beside the faux login's worker facet): each login the
// agent holds with Use gives one provider of its own (`<provider>~<login>`), two logins of one provider two providers,
// its models the login's catalog; a login without Use gives none; a request through it takes its auth from the
// login's `authorize` and reaches the provider's request code (another plugin's, else pi-ai's, loaded on first use)
// with the provider's own id. That `authorize` admits only agents with Use is the server's
// test (`server.test.ts`).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context, defineFacet, LoginProviders, type P3Principal } from "@earendil-works/p3/v1";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { createModels, fauxAssistantMessage, fauxProvider, type Provider } from "@earendil-works/p3/v1/worker";
import { FAUX_MODEL, FAUX_PROVIDER, keyOf, type Step } from "../../../test/plugins/faux-login/contract.ts";
import fauxWorker from "../../../test/plugins/faux-login/worker.ts";
import { type HarnessSession, type HeldThing, ThingHarnessParts } from "../../things/contract.worker.ts";
import { type AuthResult, type Login, type LoginInfo, LoginKind } from "../contract.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The session as the parts get it: its `call` runs the function at once (the login's `authorize` is a fake). */
const SESSION: HarnessSession = { session: "s1", workspace: "w1", call: (fn) => fn({} as never) };

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

/**
 * A login `thing` the agent holds: `authorize` answers `script` as the key, left out without Use; it shows `login` and
 * has the models `catalog`.
 */
function held(
	thing: string,
	script: readonly Step[] | undefined,
	calls: string[] = [],
	login: LoginInfo = FAUX,
	catalog: readonly unknown[] = CATALOG,
): HeldThing<typeof Login> {
	const authorize =
		script === undefined
			? undefined
			: async (): Promise<AuthResult> => {
					calls.push(thing);
					return { auth: { apiKey: keyOf(script) } };
				};
	// The part reads the reference's `login`, `catalog` and `authorize` only.
	const ref = { login: { value: login }, catalog: { value: catalog }, authorize } as unknown as HeldThing<
		typeof Login
	>["ref"];
	return { thing, workspace: "w1", ref };
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
			},
			context,
		);
	});

	afterEach(() => t.close(context));

	/** What the login kind's part gives `things`. */
	function providers(...things: HeldThing<typeof Login>[]): readonly Provider[] {
		const [entry] = t.contributions(ThingHarnessParts);
		assert.equal(entry?.value.kind.name, LoginKind.name);
		// The registry's parts take any kind's held things; the holding gives this one only logins.
		return entry.value.part(things as unknown as readonly HeldThing[], SESSION).providers ?? [];
	}

	it("is one per login with Use, its id the provider's and the login's, its models under that id", () => {
		const given = providers(held("a", SCRIPT), held("b", SCRIPT), held("c", undefined));
		assert.deepEqual(
			given.map(({ id }) => id),
			[`${FAUX_PROVIDER}~a`, `${FAUX_PROVIDER}~b`],
		);
		assert.deepEqual(
			given[0]!.getModels().map(({ id, provider }) => [id, provider]),
			[[FAUX_MODEL, `${FAUX_PROVIDER}~a`]],
		);
	});

	it("loads no request code until a request; one for a provider nobody has fails that request only", async () => {
		const [provider] = providers(held("x", SCRIPT, [], { ...FAUX, provider: "nobody" }));
		assert.equal(provider!.id, "nobody~x");
		const models = createModels();
		models.setProvider(provider!);
		const answer = await models.completeSimple(provider!.getModels()[0]!, {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		});
		assert.equal(answer.stopReason, "error");
		assert.match(answer.errorMessage ?? "", /no request code for the provider nobody/);
	});

	it("hands the request code the model under its provider's own id (request code checks it)", async () => {
		given.length = 0;
		const catalog = fauxProvider({ provider: "rec", api: "rec", models: [{ id: "m" }] }).models;
		const [provider] = providers(held("r", SCRIPT, [], { ...FAUX, provider: "rec" }, catalog));
		const models = createModels();
		models.setProvider(provider!);
		await models.completeSimple(models.getModel("rec~r", "m")!, {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		});
		assert.deepEqual(given, ["rec"]);
	});

	it("answers a request with the login's auth, through the provider's own request code", async () => {
		const calls: string[] = [];
		const [provider] = providers(held("a", SCRIPT, calls));
		const models = createModels();
		models.setProvider(provider!);
		const model = models.getModel(`${FAUX_PROVIDER}~a`, FAUX_MODEL)!;
		const answer = await models.completeSimple(model, {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
		});
		assert.deepEqual(answer.content, [{ type: "text", text: "hi there" }]);
		assert.equal(answer.provider, FAUX_PROVIDER);
		assert.deepEqual(calls, ["a"]);
	});
});
