// The login kind (`providers.login`): one sign-in at a model provider, OAuth or an API key. Made by people only, never
// an agent, so a credential is always a person's decision; linked in any number of workspaces. Its one tick, Use
// (agents only), gives `authorize`, the request auth for one model request; `login` (its provider, status and models)
// is for everyone let in. Its models for a session's agent are `SessionModels`' (decision 118a). A new link gives the
// agents Use and nobody else anything (decision 116). The credential appears in no state, argument or result but
// `authorize`'s, which only the session's worker gets.

import { arr, map, method, nul, obj, oneOf, opt, type Static, str, union } from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { ModelInfo, SignInMethod } from "./contract.ts";
import { messages } from "./messages.ts";

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
 * the server when it expired). Its models, as the session's worker asks them, are `SessionModels`' (version 2: the
 * login gives no `catalog` of its own). Logins have no model or money limits (decision 89). A new link gives the
 * agents Use, nobody else anything; its maker gets every tick (item 90). Its create step hands over `{ attempt }`: a
 * sign-in its maker finished, never a secret.
 */
export const LoginKind = defineThing("providers.login", {
	version: 2,
	makers: "people",
	state: { login: union([LoginInfo, nul()]) },
	methods: { authorize: method(obj({}), RequestAuth) },
	ticks: {
		// `login`, which no tick gives, is for everyone let in: reading.
		use: { label: messages.message("tickUse"), for: "agents", gives: ["authorize"] },
	},
	// No `everyone` and no `guests` key: only its maker, the owner and the agents are let in (decision 116).
	defaultGrants: { agents: ["use"] },
	create: { input: obj({ attempt: str() }) },
});

/** One login held in a workspace: `LoginKind`'s contract. */
export const Login = LoginKind.contract;
