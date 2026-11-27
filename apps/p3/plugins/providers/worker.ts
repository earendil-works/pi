// The providers plugin on a session's worker: what the logins the agent may use give it. Each login it holds with Use
// gives one model provider of its own (`<provider>~<login>`: two logins of one provider are two providers), whose
// models are the login's entry in the session's `SessionModels.catalog` (from the server, the overrides of the model
// settings that reach the session applied; the worker loads no catalog) and whose requests take their auth from the
// login's `authorize` (as the agent: a grant taken back refuses the next request). Every request waits until the
// session's models are complete (`SessionModels.complete`), and is made on the model as they have it then. The request
// code is, at each request, a provider another plugin adds (`LoginProviders`: a test's faux one), else pi-ai's built-in
// one, loaded on the first request (`loadProvider`), so a worker holds only the providers it uses.

import {
	type Api,
	BACKGROUND_CONTEXT,
	type Context,
	contribute,
	defineFacet,
	type Model,
	PluginError,
	type Provider,
	type Reference,
	type RegistryValue,
	until,
	withAbortSignal,
} from "@earendil-works/p3/v1";
import { lazyStream, loadProvider, WorkerRuntime } from "@earendil-works/p3/v1/worker";
import { type HeldThing, ThingHarnessParts, thingHarnessPart } from "../things/contract.worker.ts";
import { type LoginDefinitions, loginProviderId, SessionModels } from "./contract.ts";
import { type Login, LoginKind } from "./kind.ts";
import { LoginProviders, type ProviderMap, serveLoginProviders } from "./login-providers.ts";

export default defineFacet((host) => {
	serveLoginProviders(host);
	contribute(host, "providers.harness", (self) => {
		const added = self.registry(LoginProviders);
		const runtime = self.registry(WorkerRuntime);
		// The session's models, held as its worker: the one holder its `catalog` is granted to.
		const models = self.open(
			async (context) => runtime.value.host.hold(SessionModels, { session: runtime.value.session }, context),
			(held) => held.release(),
		);
		self.contribute(
			ThingHarnessParts,
			thingHarnessPart(LoginKind, (things) => {
				const session: SessionCatalog = {
					catalog: () => models.value.catalog?.value ?? [],
					complete: () => models.value.complete.value,
					ready: (context) => completed(models.value, things, context),
				};
				return {
					providers: things.flatMap((held) => {
						const shown = held.ref.login.value;
						return held.ref.authorize === undefined || shown === null
							? []
							: [{ thing: held.thing, provider: loginProvider(held, shown.provider, added, session) }];
					}),
					ready: session.ready,
				};
			}),
		);
	});
});

/** The session's models as a login's provider reads them: the catalog, whether it is complete, and the wait for it. */
type SessionCatalog = {
	readonly catalog: () => readonly LoginDefinitions[];
	readonly complete: () => boolean;
	readonly ready: (context: Context) => Promise<void>;
};

/**
 * Resolves once the session's models are complete (`SessionModels.complete`: every login and model settings thing in);
 * cancelled first by `context` (the harness's bound), it fails naming the held logins whose models are still missing.
 */
async function completed(
	models: Reference<typeof SessionModels>,
	logins: readonly HeldThing<typeof Login>[],
	context: Context,
): Promise<void> {
	try {
		await until(models.complete, (complete) => complete, context);
	} catch {
		const listed = new Set((models.catalog?.value ?? []).map(({ login }) => login));
		const loading = logins.filter(({ thing }) => !listed.has(thing)).map(({ thing }) => thing);
		const what = loading.length === 0 ? "the model settings" : `the models of logins ${loading.join(", ")}`;
		throw new PluginError("providers.loading", `providers: ${what} are still loading`, { loading });
	}
}

/**
 * How long a request waits for the session's models to be complete before it fails: the harness's bound for a submit
 * (`READY_MS` in `harness/worker.ts`).
 */
const COMPLETE_MS = 10_000;

/** No models (a login the session's catalog does not list yet). */
const NONE: readonly unknown[] = [];

/**
 * Login `held`'s own provider: its id `<provider>~<thing>`, its models the login's entry in the session's catalog
 * (`session`) under that id, its requests made by the provider's request code with the model's provider restored
 * (request code checks it: `anthropic`, `github-copilot`), its auth the login's `authorize` on the server.
 */
function loginProvider(
	{ thing, ref }: HeldThing<typeof Login>,
	base: string,
	added: RegistryValue<ProviderMap>,
	session: SessionCatalog,
): Provider {
	const id = loginProviderId(base, thing);
	/** pi-ai's built-in request code, loaded on the first request that needs it; a failed load is tried again. */
	let builtIn: Promise<Provider | undefined> | undefined;
	const code = async (): Promise<Provider> => {
		const live = added.value.get(base)?.value;
		if (live !== undefined) return live;
		builtIn ??= loadProvider(base).catch((error: unknown) => {
			builtIn = undefined;
			throw error;
		});
		const found = await builtIn;
		if (found === undefined) throw new Error(`providers: no request code for the provider ${base}`);
		return found;
	};
	/**
	 * Waits until the session's models are complete, bounded (`COMPLETE_MS`) and cancelled with the request: no request
	 * is made on models that are not, not in a run under way either, since a model settings thing just given may hide
	 * its model (round 2 of model settings, Astra; decided by the main session).
	 */
	const complete = async (signal: AbortSignal | undefined): Promise<void> => {
		const bound = AbortSignal.timeout(COMPLETE_MS);
		const waiting = withAbortSignal(
			signal === undefined ? bound : AbortSignal.any([signal, bound]),
			BACKGROUND_CONTEXT,
		);
		// Complete again when the wait ends: the lists may have changed once more meanwhile.
		while (!session.complete()) await session.ready(waiting);
	};
	/**
	 * A request of `model` made by the request code once it is there and the models are complete: the model as the
	 * complete catalog has it now, under its provider's own id; refused when the catalog no longer has it (hidden).
	 */
	const later = (
		model: Model<Api>,
		signal: AbortSignal | undefined,
		run: (provider: Provider, model: Model<Api>) => ReturnType<Provider["streamSimple"]>,
	) =>
		lazyStream(
			model,
			async () => {
				// The request code first: its first load may take a while, and the catalog may change meanwhile. Then the
				// complete catalog's model, read and sent with nothing awaited in between (Astra, round 2 recheck).
				const provider = await code();
				await complete(signal);
				const now = models().find(({ id: offered }) => offered === model.id);
				if (now === undefined)
					throw new PluginError("providers.hidden", `providers: ${id} offers no model ${model.id}`);
				return run(provider, { ...now, provider: base });
			},
			undefined,
			signal,
		);
	let catalog: { readonly from: unknown; readonly models: readonly Model<Api>[] } | undefined;
	/** The login's models in the session's catalog now, under this provider's id. */
	const models = (): readonly Model<Api>[] => {
		// A session holds few logins: its entry is found by a look over them.
		const from = session.catalog().find(({ login }) => login === thing)?.models ?? NONE;
		// Mapped once per entry the server sent (it keeps its identity while unchanged): a request asks more than once.
		if (catalog?.from !== from) {
			// The server's catalog is pi-ai's own definitions of the account's models.
			catalog = { from, models: (from as unknown as Model<Api>[]).map((model) => ({ ...model, provider: id })) };
		}
		return catalog.models;
	};
	return {
		id,
		name: ref.login.value?.providerName ?? base,
		auth: {
			apiKey: {
				name: ref.login.value?.providerName ?? base,
				resolve: async ({ signal }) => {
					// The request's auth only for a request that will be made: once the models are complete (`later`).
					await complete(signal);
					const authorize = ref.authorize;
					if (authorize === undefined) return undefined;
					// On the agent's held reference (decision 120); the request's own cancellation is pi-ai's.
					return authorize({}, BACKGROUND_CONTEXT);
				},
			},
		},
		getModels: () => models(),
		stream: (model, context, options) =>
			later(model, options?.signal, (provider, restored) => provider.stream(restored, context, options)),
		streamSimple: (model, context, options) =>
			later(model, options?.signal, (provider, restored) => provider.streamSimple(restored, context, options)),
	};
}
