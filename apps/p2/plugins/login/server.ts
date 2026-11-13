// Provider login: the server's `Logins` (provider-owned api-key and OAuth flows) followed by `LoginService`, and its
// view per owner.

import { defineFacet, deriveTyped, followNative, forbidden, isOwner, nativeOf, principalKey } from "@p2/app/v1";
import { ModelConfig, ModelResources } from "../models/contract.ts";
import { LoginService, ProviderLogin } from "./contract.ts";
import { Logins } from "./logins.ts";

export default defineFacet((host) => {
	const holders = host.references(ProviderLogin);
	host.serve(LoginService, (_params, self) => {
		// Declared, so the configuration is open before the logins are.
		self.get(ModelConfig, {});
		const resources = nativeOf(self, ModelResources, "The model configuration");
		const logins = self.open(
			async () => new Logins(resources().resources),
			(opened) => opened.close(),
		);
		// The flow's state as the logins hold it: each method's change is made before it returns.
		const state = followNative(
			self,
			(changed) => logins.value.subscribe(changed),
			() => logins.value.state,
		);
		// An owner leaving the Providers sheet everywhere (no reference of theirs left: closed sheets, disconnects) ends
		// their unfinished login; another owner's sheet coming and going does not.
		const abandoned = self.derive([holders, state], ([references, { login, owner }]) =>
			login?.status === "working" &&
			owner !== null &&
			!references.some(({ principal }) => principal !== undefined && principalKey(principal) === owner)
				? owner
				: null,
		);
		self.on(abandoned, async ({ value: owner }) => {
			if (owner !== null) logins.value.disconnect(owner);
		});
		return {
			login: deriveTyped(self, [state], ([value]) => value.login),
			owner: self.derive([state], ([value]) => value.owner),
			start: async ({ owner, providerId, authType, remote }) => ({
				attemptId: logins.value.start(owner, providerId, authType, remote),
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
