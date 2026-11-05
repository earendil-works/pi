import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";

type WithoutSignal<P = AuthPrompt> = P extends AuthPrompt ? Omit<P, "signal"> : never;
export type LoginPrompt = WithoutSignal & { id: string };
export type LoginEvent =
	| { type: "started"; attemptId: string; providerId: string; authType: AuthType }
	| { type: "prompt"; attemptId: string; prompt: LoginPrompt }
	| { type: "promptClosed"; attemptId: string; promptId: string }
	| { type: "notice"; attemptId: string; event: AuthEvent }
	| { type: "finished"; attemptId: string; status: "success" | "cancelled" | "error"; message?: string };

import { arr, bool, nul, num, obj, opt, type Static, str, union, unknown } from "@earendil-works/pi-schema";
import { literal, local, method, propertiesOf, remote, serverHost, unsafe } from "@p2/app/v1";

const AuthTypeSchema = union([literal("api_key"), literal("oauth")]);

export const ProviderSchema = obj({
	id: str(),
	name: str(),
	loginMethods: arr(obj({ type: AuthTypeSchema, label: str() })),
	/** How the stored credential signs in, or null (environment keys may still apply). */
	signedIn: union([AuthTypeSchema, nul()]),
});

/** The login in progress or just finished (one at a time). Credentials never appear here. */
export const LoginStateSchema = obj({
	attemptId: str(),
	providerId: str(),
	authType: AuthTypeSchema,
	status: union([literal("working"), literal("success"), literal("cancelled"), literal("error")]),
	/** The question the provider's flow is waiting for (text, secret, select, pasted code). */
	prompt: union([unsafe<LoginPrompt>(obj({ id: str(), type: str() })), nul()]),
	/** What the flow told the user so far: a URL to open, a device code, progress. */
	notices: arr(obj({ id: num(), event: unsafe<AuthEvent>(unknown()) })),
	message: opt(str()),
});
export type LoginState = Static<typeof LoginStateSchema>;

const AttemptSchema = obj({ attemptId: str() });
const ProviderIdSchema = obj({ providerId: str() });

/** Who a login belongs to: the principal key of the owner that started it (one device, or the device owner). */
const OwnerSchema = obj({ owner: str({ minLength: 1 }) });

/**
 * Provider logins of the server (host-internal): p2's provider-owned flows over the shared credentials. A login
 * belongs to the owner that started it (as in Pi Mobile): only it sees its prompts and notices, answers, cancels or
 * dismisses it, and only its leaving ends it.
 */
export const LoginService = local("p2.login-service", {
	/** 3: no `abandon` (the service follows who holds `ProviderLogin`). */
	version: 3,
	params: {},
	members: {
		login: union([LoginStateSchema, nul()]),
		/** The owner of `login`. */
		owner: union([str(), nul()]),
		start: method(
			obj({
				...propertiesOf(OwnerSchema),
				providerId: str(),
				authType: AuthTypeSchema,
				remote: bool(),
			}),
			AttemptSchema,
		),
		answer: method(
			obj({
				...propertiesOf(OwnerSchema),
				attemptId: str(),
				promptId: str(),
				value: str(),
			}),
		),
		cancel: method(obj({ ...propertiesOf(OwnerSchema), ...propertiesOf(AttemptSchema) })),
		dismiss: method(obj({ ...propertiesOf(OwnerSchema), ...propertiesOf(AttemptSchema) })),
		logout: method(ProviderIdSchema),
		refresh: method(ProviderIdSchema, obj({ models: num() })),
	},
});

/**
 * Signing in to model providers (any owner, local or remote; never guests).
 * Credentials are stored in `auth.json` and never sent to the browser. Held while the Providers sheet is open: once
 * none of the starting owner's browsers holds it (closed sheets, disconnects), that owner's unfinished login is
 * cancelled. Another owner sees no `login` while one runs, and cannot start, answer or cancel it.
 */
export const ProviderLogin = remote("p2.provider-login", {
	version: 1,
	params: {},
	hostAddress: serverHost,
	variants: {
		owner: {
			state: { providers: arr(ProviderSchema), login: union([LoginStateSchema, nul()]) },
			methods: {
				start: method(obj({ providerId: str(), authType: AuthTypeSchema }), AttemptSchema),
				answer: method(
					obj({
						attemptId: str(),
						promptId: str(),
						value: str({ maxLength: 100_000 }),
					}),
				),
				cancel: method(AttemptSchema),
				/** Clears a finished login. */
				dismiss: method(AttemptSchema),
				logout: method(ProviderIdSchema),
				/** Fetches the provider's current model list; returns how many models it has. */
				refresh: method(ProviderIdSchema, obj({ models: num() })),
			},
		},
	},
});
