// A provider login belongs to the owner that started it (as in Pi Mobile): only that owner sees its prompts, answers,
// cancels or dismisses it; its staying away (no page holding it, for a while) ends it; another owner's pages do not.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT, follow, whenLive } from "@p2/app/v1";
import { LoginService, ProviderLogin } from "../../plugins/login/contract.ts";
import { loginServerFacet } from "../../plugins/login/server.ts";
import { ModelConfig, ModelResources } from "../../plugins/models/contract.ts";
import { Resources } from "../../plugins/models/resources.ts";
import { nativeFacet, settled, testHost, until } from "./helpers.ts";

const DEVICE = { kind: "owner", access: "local" } as const;
const LAPTOP = { kind: "owner", access: "device", device: "laptop" } as const;
/** How long a login here waits for its owner's pages to come back (the server's `AWAY_MS`, shortened). */
const AWAY_MS = 300;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
		facets: [nativeFacet(ModelResources, { resources }), loginServerFacet(AWAY_MS)],
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
	await sleep(AWAY_MS * 2);
	const still = await until(device.login, (state) => state?.attemptId === attemptId);
	assert.equal(still?.status, "working");
	await device.answer({ attemptId, promptId: prompted!.prompt!.id, value: "account" }, BACKGROUND_CONTEXT);
	await until(device.login, (state) => state?.status === "success");
	await device.dismiss({ attemptId }, BACKGROUND_CONTEXT);
	await until(device.login, (state) => state === null);

	// The laptop's own login survives its connection dropping (a phone's background tab while its owner is in the
	// provider's tab): the laptop's page that comes back in time finds the prompt still waiting.
	laptop = laptopHost.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
	const second = await laptop.start({ providerId: "faux", authType: "oauth" }, BACKGROUND_CONTEXT);
	await until(laptop.login, (state) => state?.attemptId === second.attemptId && state.prompt !== null);
	assert.equal(device.login.value, null, "the device sees nothing of the laptop's login");
	await laptopHost.close(BACKGROUND_CONTEXT);
	const returnedHost = fixture.client(LAPTOP);
	const returned = returnedHost.hold(ProviderLogin, {}, BACKGROUND_CONTEXT);
	await until(returned.login, (state) => state?.attemptId === second.attemptId && state.prompt !== null);
	await sleep(AWAY_MS * 2);
	assert.equal(returned.login.value?.status, "working", "a page back in time keeps the login");
	// Away for longer, it ends and says why; the device may sign in again.
	const service = await fixture.host.get(LoginService, {}, BACKGROUND_CONTEXT);
	t.after(follow(service.login, () => {}));
	await returnedHost.close(BACKGROUND_CONTEXT);
	const ended = await until(
		service.login,
		(state) => state?.attemptId === second.attemptId && state.status !== "working",
	);
	assert.equal(ended?.status, "error");
	assert.match(ended?.message ?? "", /no page of yours was connected/);
	const restarted = (await device.start({ providerId: "faux", authType: "oauth" }, BACKGROUND_CONTEXT)).attemptId;
	assert.notEqual(restarted, second.attemptId);
	await device.cancel({ attemptId: restarted }, BACKGROUND_CONTEXT);
	await until(device.login, (state) => state?.attemptId === restarted && state.status === "cancelled");
});
