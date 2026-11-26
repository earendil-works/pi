// The providers plugin on a session's worker: what the logins the agent may use give it. Each login it holds with Use
// gives one model provider of its own (`<provider>~<login>`: two logins of one provider are two providers), whose
// models are the login's `catalog` (from the server: the worker loads no catalog) and whose requests take their auth
// from the login's `authorize` (as the agent: a grant taken back refuses the next request). The request code is a
// provider another plugin added (`LoginProviders`: a test's faux one) or pi-ai's built-in one, loaded on the first
// request (`loadProvider`), so a worker holds only the providers it uses.

import {
	BACKGROUND_CONTEXT,
	contribute,
	defineFacet,
	keyedEntries,
	type RegistryValue,
	type TableItem,
} from "@earendil-works/p3/v1";
import { type Api, lazyStream, loadProvider, type Model, type Provider } from "@earendil-works/p3/v1/worker";
import { type HarnessSession, type HeldThing, ThingHarnessParts, thingHarnessPart } from "../things/contract.worker.ts";
import { type Login, LoginKind } from "./contract.ts";
import { LoginProviders } from "./login-providers.ts";

/** The providers other plugins added, by id. */
type Providers = ReadonlyMap<string, TableItem<Provider>>;

export default defineFacet((host) => {
	host.serve(LoginProviders, {
		compose: (table, { report }) =>
			keyedEntries(
				table,
				(offered) => Object.fromEntries(offered.map((provider) => [provider.id, provider])),
				report,
			),
	});
	contribute(host, "providers.harness", (self) => {
		const added = self.registry(LoginProviders);
		self.contribute(
			ThingHarnessParts,
			thingHarnessPart(LoginKind, (things, session) => ({
				providers: things.flatMap((held) =>
					held.ref.authorize === undefined ? [] : [loginProvider(held, added, session)],
				),
			})),
		);
	});
});

/** The separator of a login's provider id: `<provider>~<login thing>`. */
const SEPARATOR = "~";

/**
 * Login `held`'s own provider: its id `<provider>~<thing>`, the login's catalog under that id, its requests made by the
 * provider's request code with the model's provider restored (request code checks it: `anthropic`,
 * `github-copilot`), its auth the login's `authorize` on the server.
 */
function loginProvider(
	{ thing, ref }: HeldThing<typeof Login>,
	added: RegistryValue<Providers>,
	session: HarnessSession,
): Provider {
	const { provider: base, providerName } = ref.login.value;
	const id = `${base}${SEPARATOR}${thing}`;
	let loaded: Promise<Provider> | undefined;
	/** The request code: another plugin's provider of the id, else pi-ai's, loaded once, on the first request. */
	const code = (): Promise<Provider> => {
		loaded ??= (async () => {
			const found = added.value.get(base)?.value ?? (await loadProvider(base));
			if (found === undefined) throw new Error(`providers: no request code for the provider ${base}`);
			return found;
		})();
		return loaded;
	};
	const restored = <M extends Model<Api>>(model: M): M => ({ ...model, provider: base });
	return {
		id,
		name: providerName,
		auth: {
			apiKey: {
				name: providerName,
				resolve: async () => {
					const authorize = ref.authorize;
					if (authorize === undefined) return undefined;
					// The request's own cancellation is pi-ai's; the call ends with the worker's.
					return session.call((ctx) => authorize({}, ctx), BACKGROUND_CONTEXT);
				},
			},
		},
		// The server's catalog is pi-ai's own definitions of the provider's models.
		getModels: () =>
			((ref.catalog?.value ?? []) as unknown as Model<Api>[]).map((model) => ({ ...model, provider: id })),
		stream: (model, context, options) =>
			lazyStream(
				model,
				async () => (await code()).stream(restored(model), context, options),
				undefined,
				options?.signal,
			),
		streamSimple: (model, context, options) =>
			lazyStream(
				model,
				async () => (await code()).streamSimple(restored(model), context, options),
				undefined,
				options?.signal,
			),
	};
}
