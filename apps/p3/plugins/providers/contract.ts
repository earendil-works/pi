// The providers plugin's contract: logins at model providers as a kind of thing (`providers.login`: one sign-in, OAuth
// or an API key; made by people only, never an agent, so a credential is always a person's decision) and the sign-in a
// person runs on their page before a login exists (`SignIn`). Who may do what is the things plugin's: Use (agents)
// gives `authorize`, the request auth for one model request. Signing in again and signing out will configure the login,
// with Configure where it is linked (decisions 80, 86), once the things plugin has a configure hook (slice 2). The credential itself never appears in any
// state, argument or result but `authorize`'s, which only the session's worker gets.

import {
	arr,
	bool,
	lit,
	MessageSchema,
	map,
	method,
	nul,
	num,
	obj,
	oneOf,
	opt,
	remote,
	type Schema,
	Server,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** How a login signs in: an API key (perhaps with provider settings) or OAuth. */
export const Method = oneOf("api_key", "oauth");

/** How a login signs in (see `Method`). */
export type Method = Static<typeof Method>;

/** One of a login's models, as pickers and the Settings view show it. */
export const ModelInfo = obj({ id: str(), name: str(), reasoning: bool(), contextWindow: num() });

/** One of a login's models (see `ModelInfo`). */
export type ModelInfo = Static<typeof ModelInfo>;

/**
 * A login as everyone admitted sees it: its provider (id and name), how it signs in, whether its credential works
 * (`signInAgain`: signed out, or the provider refused its refresh; someone with Configure signs it in again), and the
 * provider's models.
 */
export const LoginInfo = obj({
	provider: str(),
	providerName: str(),
	method: Method,
	status: oneOf("signedIn", "signInAgain"),
	models: arr(ModelInfo),
});

/**
 * One of a provider's models as pi-ai defines it (`Model`): plain data, what a worker's requests need. Unchecked:
 * the server's own catalogs fill it.
 */
export const ModelDefinition: Schema<unknown> = unknown();

/** A provider's models as pi-ai defines them (see `ModelDefinition`). */
export const Catalog: Schema<unknown[]> = arr(ModelDefinition);

/** A login as everyone admitted sees it (see `LoginInfo`). */
export type LoginInfo = Static<typeof LoginInfo>;

/**
 * The request auth of one model request (pi-ai's `AuthResult`): an API key, headers or a base address, provider
 * settings (`env`) and a label for status lines.
 */
export const AuthResult = obj({
	auth: obj({ apiKey: opt(str()), headers: opt(map(union([str(), nul()]))), baseUrl: opt(str()) }),
	env: opt(map(str())),
	source: opt(str()),
});

/** The request auth of one model request (see `AuthResult`). */
export type AuthResult = Static<typeof AuthResult>;

/** What a login's create step hands over: the id of a sign-in its maker finished, never a secret. */
export const LoginInput = obj({ signIn: str() });

/** What a login's create step hands over (see `LoginInput`). */
export type LoginInput = Static<typeof LoginInput>;

/**
 * A login (`providers.login`): its `login` for everyone admitted; Use, for agents, gives `authorize` (the request auth
 * of the login's provider, refreshed on the server when it expired) and `catalog` (the provider's chat models as
 * pi-ai's `Model` definitions, what a worker's requests need: the worker loads no catalog of its own). Logins have no
 * model or money limits (decision 89). A new link gives the agents Use; its maker gets every tick (item 90).
 */
export const LoginKind = defineThing("providers.login", {
	version: 1,
	makers: "people",
	state: { login: LoginInfo, catalog: Catalog },
	methods: { authorize: method(obj({}), AuthResult) },
	ticks: { use: { label: messages.message("tickUse"), for: "agents", gives: ["authorize", "catalog"] } },
	defaultGrants: { agents: ["use"] },
});

/** One login held in a workspace: `LoginKind`'s contract. */
export const Login = LoginKind.contract;

/** A provider a person may sign in to, and how. */
export const ProviderChoice = obj({
	id: str(),
	name: str(),
	methods: arr(obj({ method: Method, label: str() })),
});

/** A provider a person may sign in to (see `ProviderChoice`). */
export type ProviderChoice = Static<typeof ProviderChoice>;

/** A question a sign-in waits for: text, a secret, one of some options, or a code pasted from the provider's page. */
export const Prompt = union([
	obj({ id: str(), type: lit("text"), message: str(), placeholder: opt(str()) }),
	obj({ id: str(), type: lit("secret"), message: str(), placeholder: opt(str()) }),
	obj({
		id: str(),
		type: lit("select"),
		message: str(),
		options: arr(obj({ id: str(), label: str(), description: opt(str()) })),
	}),
	obj({ id: str(), type: lit("manual_code"), message: str(), placeholder: opt(str()) }),
]);

/** A question a sign-in waits for (see `Prompt`). */
export type Prompt = Static<typeof Prompt>;

/** What a sign-in told the person so far: information, an address to open, a device code, progress. */
export const Notice = union([
	obj({ type: lit("info"), message: str(), links: opt(arr(obj({ url: str(), label: opt(str()) }))) }),
	obj({ type: lit("auth_url"), url: str(), instructions: opt(str()) }),
	obj({
		type: lit("device_code"),
		userCode: str(),
		verificationUri: str(),
		intervalSeconds: opt(num()),
		expiresInSeconds: opt(num()),
	}),
	obj({ type: lit("progress"), message: str() }),
]);

/** What a sign-in told the person so far (see `Notice`). */
export type Notice = Static<typeof Notice>;

/**
 * A person's sign-in, tagged by `status`: `working` (perhaps waiting for an answer to `prompt`), `done` (`signIn` is
 * the id the create step or a sign-in again hands over, good for a while), or `ended` (cancelled, failed, expired), with its message.
 */
export const Attempt = union([
	obj({
		status: lit("working"),
		attempt: str(),
		provider: str(),
		method: Method,
		prompt: union([Prompt, nul()]),
		notices: arr(Notice),
	}),
	obj({ status: lit("done"), attempt: str(), provider: str(), method: Method, signIn: str(), notices: arr(Notice) }),
	obj({
		status: lit("ended"),
		attempt: str(),
		provider: str(),
		method: Method,
		message: MessageSchema,
		notices: arr(Notice),
	}),
]);

/** A person's sign-in (see `Attempt`). */
export type Attempt = Static<typeof Attempt>;

/**
 * Signing in to a model provider, on the person's own page (people only; one sign-in per person at a time): the
 * providers there are, the person's current sign-in, and its steps. A finished sign-in's id is what a login's create
 * step (or a sign-in again) hands over; the credential stays on the server, bound to the person who signed in.
 */
export const SignIn = remote("providers.sign-in", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	state: { providers: arr(ProviderChoice), attempt: union([Attempt, nul()]) },
	methods: {
		/** Starts a sign-in to `provider` by `method`, ending the caller's unfinished one; answers its id. */
		start: method(obj({ provider: str(), method: Method }), str()),
		/** Answers the current sign-in's question `prompt`. */
		answer: method(obj({ attempt: str(), prompt: str(), value: str({ max: 100_000 }) })),
		/** Ends the caller's sign-in `attempt` (a finished one's credential is dropped). */
		cancel: method(obj({ attempt: str() })),
	},
});
