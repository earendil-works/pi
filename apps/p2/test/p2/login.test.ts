// Provider login with a fixture provider: prompts and notices reach the browser, credentials never do.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT, follow, type Held, whenLive } from "@p2/app/v1";
import { type LoginState, ProviderLogin } from "../../plugins/login/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import type { Host } from "../../src/runtime/chord.ts";
import type { ServerResourceOptions } from "../../src/runtime/server.ts";
import { type Fixture, startFixture, until } from "./helpers.ts";

/** A faux provider with an API-key login (secret prompt) and an OAuth login (select, URL, device code, code). */
const createFixtureModels: NonNullable<ServerResourceOptions["createModels"]> = (credentials, modelsStore) => {
	const models = createModels({ credentials, modelsStore });
	const faux = fauxProvider({ api: "test-login" });
	let catalog = [...faux.models];
	models.setProvider({
		...faux.provider,
		getModels: () => catalog,
		auth: {
			apiKey: {
				name: "Fixture key",
				login: async (interaction) => ({
					type: "api_key",
					key: await interaction.prompt({ type: "secret", message: "Enter fixture key" }),
				}),
				resolve: async ({ credential }) =>
					credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
			},
			oauth: {
				name: "Fixture OAuth",
				login: async (interaction) => {
					interaction.notify({ type: "auth_url", url: "https://example.test/login", instructions: "Fixture" });
					await interaction.prompt({
						type: "select",
						message: "Select account",
						options: [{ id: "account", label: "Fixture account" }],
					});
					interaction.notify({
						type: "device_code",
						userCode: "CODE-1",
						verificationUri: "https://example.test/v",
					});
					await interaction.prompt({ type: "manual_code", message: "Paste authorization code" });
					return {
						type: "oauth",
						access: "private-access-token",
						refresh: "private-refresh",
						expires: Date.now() + 6e5,
					};
				},
				refresh: async (credential) => credential,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		refreshModels: async (context) => {
			// A reload restores the persisted catalog without network.
			if (context.stored)
				await context.publish({
					update: () => {
						catalog = [...(context.stored?.models ?? [])] as typeof catalog;
					},
				});
			if (!context.allowNetwork) return;
			const extra = { ...faux.models[0], id: "private-model", name: "Private fixture model" };
			await context.publish({
				persist: { models: [...faux.models, extra] },
				update: () => {
					catalog = [...faux.models, extra];
				},
			});
		},
	});
	return models;
};

describe("provider login (fixture provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let login: Held<typeof ProviderLogin>;
	const seen: LoginState[] = [];

	const answer = async (type: string, value: string) => {
		const state = await until(login.login, (current) => current?.prompt?.type === type);
		assert(state?.prompt);
		await login.answer({ attemptId: state.attemptId, promptId: state.prompt.id, value }, BACKGROUND_CONTEXT);
	};

	before(async () => {
		fixture = await startFixture({ resources: { createModels: createFixtureModels } });
		owner = fixture.browser();
		login = owner.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
		await whenLive(login);
		follow(login.login, (state) => {
			if (state) seen.push(state);
		});
	});

	after(async () => {
		await fixture?.close();
	});

	it("lists providers with their login methods", async () => {
		const providers = await until(login.providers, (value) => Boolean(value?.length));
		const faux = providers?.find((provider) => provider.id === "faux");
		assert.deepEqual(faux?.loginMethods.map((method) => method.type).sort(), ["api_key", "oauth"]);
		assert.equal(faux?.signedIn, null);
	});

	it("runs an OAuth flow through prompts and notices", async () => {
		const { attemptId } = await login.start({ providerId: "faux", authType: "oauth" }, BACKGROUND_CONTEXT);
		await assert.rejects(
			login.start({ providerId: "faux", authType: "api_key" }, BACKGROUND_CONTEXT),
			/already in progress/,
		);
		await assert.rejects(
			(async () => {
				const state = await until(login.login, (current) => current?.prompt?.type === "select");
				await login.answer({ attemptId, promptId: state?.prompt?.id ?? "", value: "unlisted" }, BACKGROUND_CONTEXT);
			})(),
			/listed/,
		);
		await answer("select", "account");
		await answer("manual_code", "private-entered-code");
		const done = await until(login.login, (current) => current?.status === "success");
		assert.deepEqual(
			done?.notices.map((notice) => notice.event.type),
			["auth_url", "device_code"],
		);
		assert.equal((await until(login.providers, (value) => Boolean(value?.[0]?.signedIn)))?.[0]?.signedIn, "oauth");
		// Signing in refreshes the provider's catalog.
		const models = owner.hold(Models, {}, BACKGROUND_CONTEXT);
		await until(models.models, (value) => Boolean(value?.some((model) => model.modelId === "private-model")));
		const stored = await readFile(join(fixture.dataDir, "auth.json"), "utf8");
		assert.match(stored, /private-access-token/);
		const published = JSON.stringify(seen);
		assert(!published.includes("private-access-token") && !published.includes("private-entered-code"));
		await login.dismiss({ attemptId }, BACKGROUND_CONTEXT);
		await until(login.login, (value) => value === null);
	});

	it("signs in with an API key, refreshes, and signs out", async () => {
		await login.logout({ providerId: "faux" }, BACKGROUND_CONTEXT);
		await until(login.providers, (value) => value?.[0]?.signedIn === null);
		await login.start({ providerId: "faux", authType: "api_key" }, BACKGROUND_CONTEXT);
		await answer("secret", "private-api-key");
		await until(login.login, (current) => current?.status === "success");
		assert(!JSON.stringify(seen).includes("private-api-key"));
		assert.equal((await until(login.providers, (value) => Boolean(value?.[0]?.signedIn)))?.[0]?.signedIn, "api_key");
		assert.deepEqual(await login.refresh({ providerId: "faux" }, BACKGROUND_CONTEXT), { models: 2 });
	});

	it("cancels an unfinished login, also when the sheet is gone", async () => {
		const first = await login.start({ providerId: "faux", authType: "oauth" }, BACKGROUND_CONTEXT);
		await login.cancel({ attemptId: first.attemptId }, BACKGROUND_CONTEXT);
		await until(login.login, (current) => current?.status === "cancelled");
		const otherBrowser = fixture.browser();
		const other = otherBrowser.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
		const { attemptId } = await other.start({ providerId: "faux", authType: "oauth" }, BACKGROUND_CONTEXT);
		await until(login.login, (current) => current?.attemptId === attemptId && current.prompt !== null);
		// Both browsers share the owner's object; releasing every reference ends the flow. The two releases travel over
		// different sockets: wait until the server has processed the other browser's (a later reference over its socket is
		// ready), else `again` below may arrive first and keep the object, and so the login, alive.
		other.release();
		const probe = otherBrowser.hold(Models, {}, BACKGROUND_CONTEXT);
		await whenLive(probe);
		probe.release();
		login.release();
		const again = owner.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
		const state = await until(
			again.login,
			(current) => current?.attemptId === attemptId && current.status !== "working",
		);
		assert.equal(state?.status, "cancelled");
		login = again;
	});
});
