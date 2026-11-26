// The providers plugin on a session's worker: what the logins the agent may use give it. Each login it holds with Use
// gives one model provider of its own (`<provider>~<login>`: two logins of one provider are two providers, decision 7
// of ERNDL-705), with the provider's chat models; each request's auth comes from the login's object on the server
// (`authorize`, as the agent: a grant taken back refuses the next request). The providers' request code is the one of
// `LoginProviders` on this worker: pi-ai's built-in ones, and what other plugins add.

import {
	BACKGROUND_CONTEXT,
	contribute,
	defineFacet,
	keyedEntries,
	type Reference,
	type TableItem,
} from "@earendil-works/p3/v1";
import { builtinProviders, type Provider } from "@earendil-works/p3/v1/worker";
import { type HarnessSession, type HeldThing, ThingHarnessParts, thingHarnessPart } from "../things/contract.worker.ts";
import { type Login, LoginKind } from "./contract.ts";
import { LoginProviders } from "./login-providers.ts";

export default defineFacet((host, self) => {
	host.serve(LoginProviders, {
		compose: (table, { report }) =>
			keyedEntries(
				table,
				(offered) => Object.fromEntries(offered.map((provider) => [provider.id, provider])),
				report,
			),
	});
	self.contribute(LoginProviders, builtinProviders());
	contribute(host, "providers.harness", (self) => {
		const offered = self.registry(LoginProviders);
		self.contribute(
			ThingHarnessParts,
			thingHarnessPart(LoginKind, (things, session) => ({
				providers: things.flatMap((held) => {
					const provider = held.ref.authorize === undefined ? undefined : offerOf(offered.value, held.ref);
					return provider === undefined ? [] : [loginProvider(provider, held, session)];
				}),
			})),
		);
	});
});

/** The provider of `login`, if a plugin on this worker offers it. */
function offerOf(
	offered: ReadonlyMap<string, TableItem<Provider>>,
	login: Reference<typeof Login>,
): Provider | undefined {
	return offered.get(login.login.value.provider)?.value;
}

/** The separator of a login's provider id: `<provider>~<login thing>`. */
const SEPARATOR = "~";

/**
 * `base` as login `held`'s own provider: its id `<provider>~<thing>`, its chat models under that id, its requests made
 * by `base` with the model's provider restored (request code checks it: `anthropic`, `github-copilot`), its auth the
 * login's `authorize` on the server.
 */
function loginProvider(base: Provider, { thing, ref }: HeldThing<typeof Login>, session: HarnessSession): Provider {
	const id = `${base.id}${SEPARATOR}${thing}`;
	const restored = <M extends { readonly provider: string }>(model: M): M => ({ ...model, provider: base.id });
	return {
		id,
		name: base.name,
		...(base.baseUrl === undefined ? {} : { baseUrl: base.baseUrl }),
		...(base.headers === undefined ? {} : { headers: base.headers }),
		auth: {
			apiKey: {
				name: base.name,
				resolve: async () => {
					const authorize = ref.authorize;
					if (authorize === undefined) return undefined;
					// The request's own cancellation is pi-ai's; the call ends with the worker's.
					return session.call((ctx) => authorize({}, ctx), BACKGROUND_CONTEXT);
				},
			},
		},
		getModels: () => base.getModels().map((model) => ({ ...model, provider: id })),
		stream: (model, context, options) => base.stream(restored(model), context, options),
		streamSimple: (model, context, options) => base.streamSimple(restored(model), context, options),
		...(base.fetchDeferred === undefined
			? {}
			: { fetchDeferred: (model, handle, options) => base.fetchDeferred!(restored(model), handle, options) }),
		...(base.cancelDeferred === undefined
			? {}
			: { cancelDeferred: (model, handle, options) => base.cancelDeferred!(restored(model), handle, options) }),
	};
}
