// Provider login: the server's `Logins` (provider-owned api-key and OAuth flows) followed by `LoginService`, and its
// view per owner.

import {
	defineFacet,
	deriveTyped,
	type Facet,
	followNative,
	forbidden,
	isOwner,
	nativeOf,
	principalKey,
} from "@p2/app/v1";
import { ModelConfig, ModelResources } from "../models/contract.ts";
import { LoginService, ProviderLogin } from "./contract.ts";
import { AWAY_MS, Logins } from "./logins.ts";

export default loginServerFacet(AWAY_MS);

/** The facet, ending a login `awayMs` after no page of its owner holds it (tests shorten it). */
export function loginServerFacet(awayMs: number): Facet {
	return defineFacet((host) => {
		const holders = host.references(ProviderLogin);
		host.serve(LoginService, (_params, self) => {
			// Declared, so the configuration is open before the logins are.
			self.get(ModelConfig, {});
			const resources = nativeOf(self, ModelResources, "The model configuration");
			const logins = self.open(
				async () => new Logins(resources().resources, awayMs),
				(opened) => opened.close(),
			);
			// The flow's state as the logins hold it: each method's change is made before it returns.
			const state = followNative(
				self,
				(changed) => logins.value.subscribe(changed),
				() => logins.value.state,
			);
			// An owner with no page holding `ProviderLogin` (closed tabs, dropped connections) is away: their unfinished
			// login ends unless a page of theirs holds it again in time. Another owner's pages coming and going do not
			// count.
			const away = self.derive([holders, state], ([references, { login, owner }]) =>
				login?.status === "working" &&
				owner !== null &&
				!references.some(({ principal }) => principal !== undefined && principalKey(principal) === owner)
					? owner
					: null,
			);
			self.on(away, async ({ value: owner }) => {
				if (owner === null) logins.value.back();
				else logins.value.away(owner);
			});
			return {
				login: deriveTyped(self, [state], ([value]) => value.login),
				owner: self.derive([state], ([value]) => value.owner),
				start: async ({ owner, providerId, authType, remote }) => ({
					attemptId: await logins.value.start(owner, providerId, authType, remote),
				}),
				answer: async ({ owner, attemptId, promptId, value }) => {
					logins.value.answer(owner, attemptId, promptId, value);
					return null;
				},
				cancel: async ({ owner, attemptId }) => {
					await logins.value.cancel(owner, attemptId);
					return null;
				},
				dismiss: async ({ owner, attemptId }) => {
					logins.value.dismiss(owner, attemptId);
					return null;
				},
				logout: async ({ providerId }) => {
					await logins.value.logout(providerId);
					return null;
				},
				refresh: async ({ providerId }) => {
					await logins.value.refresh(providerId);
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
				providers,
				login: loginView,
				start: (args, ctx) => service.start({ ...args, owner, remote: principal.access !== "local" }, ctx),
				answer: (args, ctx) => service.answer({ ...args, owner }, ctx),
				cancel: (args, ctx) => service.cancel({ ...args, owner }, ctx),
				dismiss: (args, ctx) => service.dismiss({ ...args, owner }, ctx),
				logout: (args, ctx) => service.logout(args, ctx),
				refresh: (args, ctx) => service.refresh(args, ctx),
			};
		});
	});
}
