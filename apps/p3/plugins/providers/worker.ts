// The providers plugin on a session's worker: what the logins the agent may use give it. Each login it holds with Use
// gives one model provider of its own (`<provider>~<login>`: two logins of one provider are two providers), whose
// models are the login's `catalog` (from the server: the worker loads no catalog) and whose requests take their auth
// from the login's `authorize` (as the agent: a grant taken back refuses the next request). The request code is, at
// each request, a provider another plugin adds (`LoginProviders`: a test's faux one), else pi-ai's built-in one,
// loaded on the first request (`loadProvider`), so a worker holds only the providers it uses.

import {
	type Api,
	BACKGROUND_CONTEXT,
	contribute,
	defineFacet,
	type Model,
	type Provider,
	type RegistryValue,
} from "@earendil-works/p3/v1";
import { lazyStream, loadProvider } from "@earendil-works/p3/v1/worker";
import { type HeldThing, ThingHarnessParts, thingHarnessPart } from "../things/contract.worker.ts";
import { type Login, LoginKind } from "./kind.ts";
import { LoginProviders, type ProviderMap, serveLoginProviders } from "./login-providers.ts";

export default defineFacet((host) => {
	serveLoginProviders(host);
	contribute(host, "providers.harness", (self) => {
		const added = self.registry(LoginProviders);
		self.contribute(
			ThingHarnessParts,
			thingHarnessPart(LoginKind, (things) => ({
				providers: things.flatMap((held) => {
					const shown = held.ref.login.value;
					return held.ref.authorize === undefined || shown === null
						? []
						: [loginProvider(held, shown.provider, added)];
				}),
			})),
		);
	});
});

/** The separator of a login's provider id: `<provider>~<login thing>`. */
const SEPARATOR = "~";

/**
 * Login `held`'s own provider: its id `<provider>~<thing>`, the login's catalog under that id, its requests made by
 * the provider's request code with the model's provider restored (request code checks it: `anthropic`,
 * `github-copilot`), its auth the login's `authorize` on the server.
 */
function loginProvider(
	{ thing, ref }: HeldThing<typeof Login>,
	base: string,
	added: RegistryValue<ProviderMap>,
): Provider {
	const id = `${base}${SEPARATOR}${thing}`;
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
	/** A request of `model` made by the request code once it is there; the model under its provider's own id. */
	const later = (
		model: Model<Api>,
		signal: AbortSignal | undefined,
		run: (provider: Provider, model: Model<Api>) => ReturnType<Provider["streamSimple"]>,
	) => lazyStream(model, async () => run(await code(), { ...model, provider: base }), undefined, signal);
	let catalog: { readonly from: unknown; readonly models: readonly Model<Api>[] } | undefined;
	return {
		id,
		name: ref.login.value?.providerName ?? base,
		auth: {
			apiKey: {
				name: ref.login.value?.providerName ?? base,
				resolve: async () => {
					const authorize = ref.authorize;
					if (authorize === undefined) return undefined;
					// On the agent's held reference (decision 120); the request's own cancellation is pi-ai's.
					return authorize({}, BACKGROUND_CONTEXT);
				},
			},
		},
		getModels: () => {
			const from = ref.catalog?.value ?? [];
			// Mapped once per catalog the server sent: a request asks for the models more than once.
			if (catalog?.from !== from) {
				// The server's catalog is pi-ai's own definitions of the account's models.
				catalog = { from, models: (from as unknown as Model<Api>[]).map((model) => ({ ...model, provider: id })) };
			}
			return catalog.models;
		},
		stream: (model, context, options) =>
			later(model, options?.signal, (provider, restored) => provider.stream(restored, context, options)),
		streamSimple: (model, context, options) =>
			later(model, options?.signal, (provider, restored) => provider.streamSimple(restored, context, options)),
	};
}
