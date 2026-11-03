// Provider login: p2's Logins (provider-owned api-key and OAuth flows) as chord2 objects.

import { nul, obj, str, union } from "@earendil-works/pi-schema";
import {
	BACKGROUND_CONTEXT,
	defineFacet,
	defineTypedState,
	deriveTyped,
	forbidden,
	isChordError,
	isOwner,
	nativeOf,
	principalKey,
} from "@p2/app/v1";
import { processLogs } from "@p2/app/v1/node";
import { serverOf } from "@p2/app/v1/server";
import { ModelConfig, ModelResources } from "../models/contract.ts";
import { type LoginEvent, LoginService, type LoginState, LoginStateSchema, ProviderLogin } from "./contract.ts";
import { Logins } from "./logins.ts";

/** The next state of the current login after `event`. */
function reduce(state: LoginState | null, event: LoginEvent): LoginState | null {
	if (event.type === "started")
		return {
			attemptId: event.attemptId,
			providerId: event.providerId,
			authType: event.authType,
			status: "working",
			prompt: null,
			notices: [],
		};
	if (state === null || state.attemptId !== event.attemptId) return state;
	switch (event.type) {
		case "prompt":
			return { ...state, prompt: event.prompt };
		case "promptClosed":
			return state.prompt?.id === event.promptId ? { ...state, prompt: null } : state;
		case "notice":
			return { ...state, notices: [...state.notices, { id: state.notices.length, event: event.event }] };
		case "finished":
			return {
				...state,
				status: event.status,
				prompt: null,
				...(event.message === undefined ? {} : { message: event.message }),
			};
	}
}

/** The current login and the owner that started it (in memory). */
const Current = defineTypedState("p2.login-service", {
	schema: obj({ login: union([LoginStateSchema, nul()]), owner: union([str(), nul()]) }),
	version: 1,
	initial: () => ({ login: null, owner: null }),
});

export default defineFacet((host) => {
	host.serve(LoginService, (_params, self) => {
		// Declared, so the configuration is open before the logins are.
		self.get(ModelConfig, {});
		const resources = nativeOf(self, ModelResources, "The model configuration");
		const current = self.state(Current);
		// Login flows run outside Chord calls: each event changes the state on its own.
		const apply = (owner: string, event: LoginEvent) =>
			void current
				.change((draft) => {
					if (event.type === "started") draft.owner = owner;
					// A draft's arrays are mutable; the reduced state (readonly prompt options) is the same JSON.
					draft.login = reduce(current.value.login, event) as typeof draft.login;
				}, BACKGROUND_CONTEXT)
				.catch(() => {});
		const loginsResource = self.open(
			async () =>
				new Logins(resources().resources, (owner, event) => {
					if (event.type === "notice" && event.event.type === "device_code")
						processLogs.redactor.addSecret(event.event.userCode);
					if (event.type === "notice" && event.event.type === "auth_url")
						processLogs.redactor.addSecret(event.event.url);
					apply(owner, event);
				}),
			(logins) => logins.close(),
		);
		const logins = (): Logins => loginsResource.value;
		/** The current login, if `owner` started it. */
		const mine = (owner: string): LoginState | null => (current.value.owner === owner ? current.value.login : null);
		return {
			login: deriveTyped(self, [current], ([value]) => value.login),
			owner: self.derive([current], ([value]) => value.owner),
			start: async ({ owner, providerId, authType, remote }) => ({
				attemptId: logins().start(owner, providerId, authType, remote),
			}),
			answer: async ({ owner, attemptId, promptId, value }) => {
				const current = mine(owner);
				if (
					current?.attemptId === attemptId &&
					current.prompt?.id === promptId &&
					(current.prompt.type === "secret" || current.prompt.type === "manual_code")
				)
					processLogs.redactor.addSecret(value);
				logins().answer(owner, attemptId, promptId, value);
				return null;
			},
			cancel: async ({ owner, attemptId }) => {
				logins().cancel(owner, attemptId);
				return null;
			},
			abandon: async ({ owner }) => {
				logins().disconnect(owner);
				return null;
			},
			dismiss: async ({ owner, attemptId }, ctx) => {
				const login = mine(owner);
				if (login?.attemptId === attemptId && login.status !== "working")
					await current.change((draft) => {
						draft.login = null;
					}, ctx);
				return null;
			},
			logout: async ({ providerId }) => {
				await logins().logout(providerId);
				return null;
			},
			refresh: async ({ providerId }) => {
				await logins().refresh(providerId);
				return {
					models: resources()
						.resources.models.getModels()
						.filter((model) => model.provider === providerId).length,
				};
			},
		};
	});

	host.serve(ProviderLogin, (_params, principal, self) => {
		if (!isOwner(principal)) throw forbidden("Provider login is only available to owners");
		const config = self.get(ModelConfig, {});
		const service = self.get(LoginService, {});
		// This owner's logins: one device's (its cookie), the Radius owner's, or the device owner's (every local tab).
		const owner = principalKey(principal);
		// This owner leaving the sheet everywhere (release, disconnect) ends its unfinished login; another owner's
		// sheet coming and going does not.
		const server = serverOf(self);
		self.open(
			async () => service,
			async (held) => {
				try {
					await server().root((ctx) => held.abandon({ owner }, ctx));
				} catch (error) {
					// The host is closing (no root starts any more): the login service ends with it.
					if (!isChordError(error, "released")) throw error;
				}
			},
		);
		// Prompts and notices (an auth URL, a device code) only for the owner that started the login.
		const loginView = deriveTyped(self, [service.login, service.owner], ([login, started]) =>
			started === owner ? login : null,
		);
		const providers = deriveTyped(self, [config.snapshot], ([snapshot]) => {
			const stored = new Map(snapshot.credentials.map((credential) => [credential.providerId, credential.type]));
			return snapshot.providers
				.filter((provider) => provider.loginMethods.length > 0)
				.map(({ id, name, loginMethods }) => ({ id, name, loginMethods, signedIn: stored.get(id) ?? null }));
		});
		return {
			variant: "owner",
			members: {
				providers,
				login: loginView,
				start: (args, ctx) => service.start({ ...args, owner, remote: principal.access !== "local" }, ctx),
				answer: (args, ctx) => service.answer({ ...args, owner }, ctx),
				cancel: (args, ctx) => service.cancel({ ...args, owner }, ctx),
				dismiss: (args, ctx) => service.dismiss({ ...args, owner }, ctx),
				logout: (args, ctx) => service.logout(args, ctx),
				refresh: (args, ctx) => service.refresh(args, ctx),
			},
		};
	});
});
