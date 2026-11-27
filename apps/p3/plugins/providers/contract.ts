// The providers plugin's contract, for every plugin that shows a sign-in or a model (this plugin's page, the model
// picker, the harness): how a login signs in (`SignInMethod`), the sign-in a person runs on their own page before a
// login exists (`SignIn`: the providers there are, the person's current attempt, its questions and notices), and the
// models a session may use (`SessionModels`, decision 118). A finished sign-in's credential stays on the server; only
// its attempt id reaches a login's create step. The login kind is `kind.ts`, the model settings kind `model-settings-kind.ts`.

import {
	arr,
	bool,
	grantable,
	int,
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

/** How a login signs in: an API key (perhaps with provider settings) or OAuth. */
export const SignInMethod = oneOf("api_key", "oauth");

/** How a login signs in (see `SignInMethod`). */
export type SignInMethod = Static<typeof SignInMethod>;

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

/** One of a login's models, as pickers and the Settings view show it. */
export const ModelInfo = obj({ id: str(), name: str(), reasoning: bool(), contextWindow: num() });

/** One of a login's models (see `ModelInfo`). */
export type ModelInfo = Static<typeof ModelInfo>;

/** A login's models as a session's picker lists them: the login, its provider (id and name) and its models. */
export const LoginModels = obj({ login: str(), provider: str(), providerName: str(), models: arr(ModelInfo) });

/** A login's models as a session's picker lists them (see `LoginModels`). */
export type LoginModels = Static<typeof LoginModels>;

/** A login's models as its session's worker asks them: pi-ai's definitions (plain data, typed `unknown` here). */
export const LoginDefinitions = obj({ login: str(), models: arr(unknown()) });

/** A login's models as its session's worker asks them (see `LoginDefinitions`). */
export type LoginDefinitions = Static<typeof LoginDefinitions>;

/**
 * The models a session may use (decision 118a), on the server, for everyone the session gives anything: per login its
 * agent may Use there (`models`, for the picker), each login's models being its type's catalog cut to its account,
 * with the overrides of the model settings things that reach the session applied (the nearest wins per field;
 * hidden models are left out). `catalog`, the same models as pi-ai's full definitions, is the session's own worker's
 * alone: the registry its agent asks. `complete` says that every login the agent may Use has its models in and every
 * model settings thing its overrides; while it is `false` (just held, a login or settings thing just given) the lists
 * hold only the logins listed before, as they are now (what takes away applies at once), so a login or a model is
 * never offered before its models and overrides are in; the worker waits for it before it picks a model and before
 * every request (rounds 1 and 2). A login's entries keep their identity while its
 * account and the overrides naming its models are unchanged. Computed once per session (`SessionModelSet`).
 */
export const SessionModels = remote("providers.session-models", {
	version: 1,
	params: { session: str() },
	hostAddress: () => Server(),
	admission: obj({}),
	state: { complete: bool(), models: arr(LoginModels), catalog: grantable(arr(LoginDefinitions)) },
});

/** The separator of a login's provider id on a session's worker (`loginProviderId`). */
const LOGIN_SEPARATOR = "~";

/**
 * The id of login `login`'s model provider on a session's worker: `<provider>~<login thing>`, so two logins of one
 * provider are two providers.
 */
export function loginProviderId(provider: string, login: string): string {
	return `${provider}${LOGIN_SEPARATOR}${login}`;
}

/** The provider and the login a model provider's id names (`loginProviderId`'s inverse); none: not a login's. */
export function loginOfProvider(id: string): { readonly provider: string; readonly login: string } | undefined {
	const at = id.indexOf(LOGIN_SEPARATOR);
	return at <= 0 ? undefined : { provider: id.slice(0, at), login: id.slice(at + 1) };
}

/**
 * One override of a model's metadata, in a model settings thing (`providers.models`, decision 118b): the model's id
 * (`model`), of one provider type only (`provider`) or of every one, and the fields it sets: its name, costs, context
 * window, output limit, thinking levels (pi-ai's `thinkingLevelMap`: a level's value at the provider, `null`:
 * unsupported), largest request, and whether it is hidden (left out of the picker and the worker's registry). A field
 * left out is the next one's, else the catalog's.
 */
export const ModelOverride = obj({
	provider: opt(str({ max: 200 })),
	model: str({ min: 1, max: 200 }),
	name: opt(str({ max: 200 })),
	// Prices are never negative (Astra, round 1): a usage cost below zero is no product feature.
	cost: opt(
		obj({ input: num({ min: 0 }), output: num({ min: 0 }), cacheRead: num({ min: 0 }), cacheWrite: num({ min: 0 }) }),
	),
	contextWindow: opt(int({ min: 1 })),
	maxTokens: opt(int({ min: 1 })),
	thinkingLevelMap: opt(map(union([str({ max: 200 }), nul()]))),
	maxRequestBytes: opt(int({ min: 1 })),
	hidden: opt(bool()),
});

/** One override of a model's metadata (see `ModelOverride`). */
export type ModelOverride = Static<typeof ModelOverride>;
