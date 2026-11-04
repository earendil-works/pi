import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT, follow, whenLive } from "@p2/app/v1";
import { type LoginState, ProviderLogin } from "../../plugins/login/contract.ts";
import loginServer from "../../plugins/login/server.ts";
import { ModelConfig, ModelResources } from "../../plugins/models/contract.ts";
import { Resources } from "../../plugins/models/resources.ts";
import { expectChord, nativeFacet, testHost, until } from "./helpers.ts";

for (const access of ["local", "relay", "device"] as const)
	for (const method of ["device_code", "device-code", undefined] as const)
		test(`${access} owner login chooses ${method ?? "manual callback"}; guests cannot reach any provider action`, async (t) => {
			const directory = await mkdtemp(join(tmpdir(), "p2-remote-login-"));
			const selected: string[] = [];
			const pasted: string[] = [];
			const resources = new Resources({
				directory,
				createModels: (credentials, modelsStore) => {
					const models = createModels({ credentials, modelsStore });
					const faux = fauxProvider({ api: "test-remote-login" });
					models.setProvider({
						...faux.provider,
						auth: {
							apiKey: {
								name: "Fixture key",
								login: async (interaction) => ({
									type: "api_key",
									key: await interaction.prompt({ type: "secret", message: "Fixture key" }),
								}),
								resolve: async () => undefined,
							},
							oauth: {
								name: "Fixture OAuth",
								login: async (interaction) => {
									if (method) {
										selected.push(
											await interaction.prompt({
												type: "select",
												message: "Login method",
												options: [
													{ id: "browser", label: "Browser" },
													{ id: method, label: "Device code" },
												],
											}),
										);
										interaction.notify({
											type: "device_code",
											userCode: "FIXTURE",
											verificationUri: "https://example.test/verify",
										});
									} else {
										interaction.notify({ type: "auth_url", url: "https://example.test/login" });
										pasted.push(
											await interaction.prompt({
												type: "manual_code",
												message: "Paste code or final redirect URL",
											}),
										);
									}
									await interaction.prompt({
										type: "select",
										message: "Account",
										options: [{ id: "account", label: "Account" }],
									});
									return {
										type: "oauth",
										access: "private-fixture-access",
										refresh: "private-fixture-refresh",
										expires: Date.now() + 600_000,
									};
								},
								refresh: async (credential) => credential,
								toAuth: async (credential) => ({ apiKey: credential.access }),
							},
						},
					});
					return models;
				},
			});
			await resources.start();
			const fixture = await testHost({
				facets: [nativeFacet(ModelResources, { resources }), loginServer],
				stubs: [
					[
						ModelConfig,
						(_input, _principal, self) => {
							const summary = self.state({
								models: [],
								defaultModel: null,
								errors: [],
							});
							const snapshot = self.state(resources.snapshot());
							return { summary, snapshot, setDefault: () => {}, setEnabledModels: () => {} };
						},
					],
				],
			});
			t.after(async () => {
				await fixture.close();
				await resources.close();
				await rm(directory, { recursive: true, force: true });
			});
			const owner = fixture.client(
				access === "device" ? { kind: "owner", access, device: "laptop" } : { kind: "owner", access },
			);
			const login = owner.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
			await whenLive(login);
			const seen: LoginState[] = [];
			const stop = follow(login.login, (state) => {
				if (state) seen.push(state);
			});
			t.after(stop);
			const answer = async (message: string, value: string) => {
				const state = await until(login.login, (current) => current?.prompt?.message === message);
				assert(state?.prompt);
				await login.answer({ attemptId: state.attemptId, promptId: state.prompt.id, value }, BACKGROUND_CONTEXT);
			};
			await login.start({ providerId: "faux", authType: "oauth" }, BACKGROUND_CONTEXT);
			if (method && access === "local") await answer("Login method", method);
			const code =
				access === "relay"
					? "private-pasted-code"
					: "http://localhost:1455/auth/callback?code=private-pasted-code&state=fixture";
			if (!method) await answer("Paste code or final redirect URL", code);
			await answer("Account", "account");
			await until(login.login, (state) => state?.status === "success");
			assert.deepEqual(selected, method ? [method] : []);
			assert.deepEqual(pasted, method ? [] : [code]);
			assert.equal(
				seen.some((state) => state.prompt?.message === "Login method"),
				Boolean(method && access === "local"),
			);
			assert.equal(resources.snapshot().credentials[0]?.type, "oauth");
			await login.refresh({ providerId: "faux" }, BACKGROUND_CONTEXT);
			await login.logout({ providerId: "faux" }, BACKGROUND_CONTEXT);
			assert.equal(resources.snapshot().credentials.length, 0);
			await login.start({ providerId: "faux", authType: "api_key" }, BACKGROUND_CONTEXT);
			await answer("Fixture key", "private-fixture-key");
			await until(login.login, (state) => state?.status === "success");
			assert.equal(resources.snapshot().credentials[0]?.type, "api_key");
			assert(!JSON.stringify(seen).includes("private-fixture"));
			assert(!JSON.stringify(seen).includes("private-pasted-code"));
			const guest = fixture.client({
				kind: "guest",
				id: "g",
				name: "Guest",
				home: "s",
				sessions: { s: "full" },
				revision: 1,
			});
			const denied = guest.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
			await expectChord(whenLive(denied), "forbidden");
			await expectChord(denied.start({ providerId: "faux", authType: "oauth" }, BACKGROUND_CONTEXT), "forbidden");
			await expectChord(
				denied.answer({ attemptId: "none", promptId: "none", value: "none" }, BACKGROUND_CONTEXT),
				"forbidden",
			);
			await expectChord(denied.cancel({ attemptId: "none" }, BACKGROUND_CONTEXT), "forbidden");
			await expectChord(denied.logout({ providerId: "faux" }, BACKGROUND_CONTEXT), "forbidden");
			await expectChord(denied.refresh({ providerId: "faux" }, BACKGROUND_CONTEXT), "forbidden");
			await login.start({ providerId: "faux", authType: "api_key" }, BACKGROUND_CONTEXT);
			const unfinished = await until(
				login.login,
				(state) => state?.status === "working" && state.prompt?.type === "secret",
			);
			assert(unfinished);
			await login.cancel({ attemptId: unfinished.attemptId }, BACKGROUND_CONTEXT);
			await until(login.login, (state) => state?.status === "cancelled");
			assert.equal(
				resources.snapshot().credentials[0]?.type,
				"api_key",
				"cancel preserves the prior stored credential",
			);
		});
