// The providers plugin's contract: logins at model providers as a kind of thing (`providers.login`: one sign-in, OAuth
// or an API key; made by people only, never an agent, so a credential is always a person's decision) and the sign-in a
// person runs on their page before a login exists (`SignIn`). Who may do what is the things plugin's: Use (agents)
// gives `authorize`, the request auth for one model request, and `catalog`, the login's models. The credential itself
// never appears in any state, argument or result but `authorize`'s, which only the session's worker gets.

import {
	arr,
	bool,
	lit,
	MessageSchema,
	map,
	method,
	nul,
	num,
	OwnerAdmission,
	obj,
	oneOf,
	opt,
	remote,
	Server,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** How a login signs in: an API key (perhaps with provider settings) or OAuth. */
export const SignInMethod = oneOf("api_key", "oauth");

/** How a login signs in (see `SignInMethod`). */
export type SignInMethod = Static<typeof SignInMethod>;

/** One of a login's models, as pickers and the Settings view show it. */
export const ModelInfo = obj({ id: str(), name: str(), reasoning: bool(), contextWindow: num() });

/** One of a login's models (see `ModelInfo`). */
export type ModelInfo = Static<typeof ModelInfo>;

/**
 * A login as everyone admitted sees it: its provider (id and name), how it signs in, whether its credential works
 * (`signInAgain`: its last refresh failed, refused or not reached; shown only, a request a while later tries again),
 * and the models its account has.
 */
export const LoginInfo = obj({
	provider: str(),
	providerName: str(),
	method: SignInMethod,
	status: oneOf("signedIn", "signInAgain"),
	models: arr(ModelInfo),
});

/** A login as everyone admitted sees it (see `LoginInfo`). */
export type LoginInfo = Static<typeof LoginInfo>;

/**
 * The request auth of one model request (pi-ai's `AuthResult`): an API key, headers or a base address, provider
 * settings (`env`) and a label for status lines.
 */
export const RequestAuth = obj({
	auth: obj({ apiKey: opt(str()), headers: opt(map(union([str(), nul()]))), baseUrl: opt(str()) }),
	env: opt(map(str())),
	source: opt(str()),
});

/** The request auth of one model request (see `RequestAuth`). */
export type RequestAuth = Static<typeof RequestAuth>;

/**
 * A login (`providers.login`): its `login` for everyone admitted (`null` while its credential is not stored: made a
 * moment ago, or deleted); Use, for agents, gives `authorize` (the request auth of the login's provider, refreshed on
 * the server when it expired) and `catalog` (the models its account has, as pi-ai's `Model` definitions: plain data,
 * what a worker's requests need; the worker loads no catalog of its own; whatever the status says: after a failed
 * refresh a request tries again, which needs a model). Logins have no model or money limits (decision 89). A new link
 * gives the agents Use, nobody else anything; its maker gets every tick (item 90). Its create step hands over
 * `{ attempt }`: a sign-in its maker finished, never a secret.
 */
export const LoginKind = defineThing("providers.login", {
	version: 1,
	makers: "people",
	state: { login: union([LoginInfo, nul()]), catalog: arr(unknown()) },
	methods: { authorize: method(obj({}), RequestAuth) },
	ticks: { use: { label: messages.message("tickUse"), for: "agents", gives: ["authorize", "catalog"] } },
	defaultGrants: { agents: ["use"] },
	create: { input: obj({ attempt: str() }) },
});

/** One login held in a workspace: `LoginKind`'s contract. */
export const Login = LoginKind.contract;

/** A provider a person may sign in to, and how. */
export const ProviderChoice = obj({
	id: str(),
	name: str(),
	methods: arr(obj({ method: SignInMethod, label: str() })),
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
 * A person's sign-in, tagged by `status`: `working` (perhaps waiting for an answer to `prompt`), `done` (its credential
 * waits on the server for the create step that hands over `attempt`, for a while), or `ended` (failed, expired), with
 * its message.
 */
export const Attempt = union([
	obj({
		status: lit("working"),
		attempt: str(),
		provider: str(),
		method: SignInMethod,
		prompt: union([Prompt, nul()]),
		notices: arr(Notice),
	}),
	obj({ status: lit("done"), attempt: str(), provider: str(), method: SignInMethod, notices: arr(Notice) }),
	obj({
		status: lit("ended"),
		attempt: str(),
		provider: str(),
		method: SignInMethod,
		message: MessageSchema,
		notices: arr(Notice),
	}),
]);

/** A person's sign-in (see `Attempt`). */
export type Attempt = Static<typeof Attempt>;

/**
 * Signing in to a model provider, on the person's own page (the owner only until workspaces decide who may make a
 * login; one sign-in per person at a time): the providers there are, the person's current sign-in, and its steps. A
 * finished sign-in's attempt id is what a login's create step hands over; the credential stays on the server, with the
 * person who signed in, until then.
 */
export const SignIn = remote("providers.sign-in", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	admission: OwnerAdmission,
	state: { providers: arr(ProviderChoice), attempt: union([Attempt, nul()]) },
	methods: {
		/** Starts a sign-in to `provider` by `method`, ending the caller's unfinished one; answers its id. */
		start: method(obj({ provider: str(), method: SignInMethod }), str()),
		/** Answers the current sign-in's question `prompt`. */
		answer: method(obj({ prompt: str(), value: str({ max: 100_000 }) })),
		/** Ends the caller's sign-in `attempt` (a finished one's credential is dropped). */
		cancel: method(obj({ attempt: str() })),
	},
});
