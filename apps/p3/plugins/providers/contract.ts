// The providers plugin's contract, for every plugin that shows a sign-in (this plugin's page, later the model
// picker): how a login signs in (`SignInMethod`) and the sign-in a person runs on their own page before a login exists
// (`SignIn`: the providers there are, the person's current attempt, its questions and notices). A finished sign-in's
// credential stays on the server; only its attempt id reaches a login's create step. The login kind is `kind.ts`.

import {
	arr,
	lit,
	MessageSchema,
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
