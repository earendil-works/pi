// A provider login belongs to the owner that started it (as in Pi Mobile): only that owner sees its prompts, answers,
// cancels or dismisses it; its leaving (closed sheet, disconnect) ends it; another owner's sheet does not.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT, follow, whenLive } from "@p2/app/v1";
import { ProviderLogin } from "../../plugins/login/contract.ts";
import loginServer from "../../plugins/login/server.ts";
import { ModelConfig, ModelResources } from "../../plugins/models/contract.ts";
import { Resources } from "../../plugins/models/resources.ts";
import { nativeFacet, poll, settled, testHost, until } from "./helpers.ts";

const DEVICE = { kind: "owner", access: "local" } as const;
const LAPTOP = { kind: "owner", access: "device", device: "laptop" } as const;

test("a provider login belongs to the owner that started it", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-login-owners-"));
	const resources = new Resources({
		directory,
		createModels: (credentials, modelsStore) => {
			const models = createModels({ credentials, modelsStore });
			const faux = fauxProvider({ api: "test-login-owners" });
			models.setProvider({
				...faux.provider,
				auth: {
					oauth: {
						name: "Fixture OAuth",
						login: async (interaction) => {
							interaction.notify({ type: "auth_url", url: "https://example.test/private-login-url" });
							await interaction.prompt({
								type: "select",
								message: "Account",
								options: [{ id: "account", label: "Account" }],
							});
							return { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 600_000 };
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

	const device = fixture.client(DEVICE).hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
	const laptopHost = fixture.client(LAPTOP);
	let laptop = laptopHost.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
	await Promise.all([whenLive(device), whenLive(laptop)]);
	// Followed throughout (an unsubscribed member keeps only its last value).
	t.after(follow(device.login, () => {}));

	const { attemptId } = await device.start({ providerId: "faux", authType: "oauth" }, BACKGROUND_CONTEXT);
	const prompted = await until(device.login, (state) => state?.prompt?.message === "Account");
	assert.equal(prompted?.notices[0]?.event.type, "auth_url");
	// Another owner sees nothing of it (no URL or prompt), cannot start another, answer or cancel it.
	assert.equal(await settled(laptop.login), null);
	await assert.rejects(
		laptop.start({ providerId: "faux", authType: "oauth" }, BACKGROUND_CONTEXT),
		/Another owner device is signing in/,
	);
	await assert.rejects(
		laptop.answer({ attemptId, promptId: prompted!.prompt!.id, value: "account" }, BACKGROUND_CONTEXT),
		/no longer active for this connection/,
	);
	await assert.rejects(laptop.cancel({ attemptId }, BACKGROUND_CONTEXT), /no longer active for this connection/);
	// The other owner closing its sheet (its last hold) does not abandon the login.
	laptop.release();
	await new Promise((resolve) => setTimeout(resolve, 100));
	const still = await until(device.login, (state) => state?.attemptId === attemptId);
	assert.equal(still?.status, "working");
	await device.answer({ attemptId, promptId: prompted!.prompt!.id, value: "account" }, BACKGROUND_CONTEXT);
	await until(device.login, (state) => state?.status === "success");
	await device.dismiss({ attemptId }, BACKGROUND_CONTEXT);
	await until(device.login, (state) => state === null);

	// The laptop's own login ends when it disconnects (its connection's holds go), and the device may sign in again.
	laptop = laptopHost.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
	const second = await laptop.start({ providerId: "faux", authType: "oauth" }, BACKGROUND_CONTEXT);
	await until(laptop.login, (state) => state?.attemptId === second.attemptId && state.prompt !== null);
	assert.equal(device.login.value, null, "the device sees nothing of the laptop's login");
	await laptopHost.close(BACKGROUND_CONTEXT);
	let again: { attemptId: string } | undefined;
	await poll(
		async () => {
			again = await device
				.start({ providerId: "faux", authType: "oauth" }, BACKGROUND_CONTEXT)
				.catch(() => undefined);
			return again !== undefined;
		},
		10_000,
		"the laptop's login to end with its connection",
	);
	const restarted = again!.attemptId;
	assert.notEqual(restarted, second.attemptId);
	await device.cancel({ attemptId: restarted }, BACKGROUND_CONTEXT);
	await until(device.login, (state) => state?.attemptId === restarted && state.status === "cancelled");
});
