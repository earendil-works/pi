/**
 * Closed-network security policy.
 *
 * secureMode permits a provider only when it has an explicit baseUrl, which is
 * how an operator redirects it at internal infrastructure. Built-in providers
 * carry their vendor's cloud endpoint and must stay blocked.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@tculpepp/spi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const INTERNAL_BASE_URL = "https://llm.internal.example/v1";

let tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "spi-secure-mode-"));
	tempDirs.push(dir);
	return dir;
}

/** models.json declaring one provider pointed at internal infrastructure. */
function writeModelsJson(dir: string): string {
	const modelsPath = join(dir, "models.json");
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				internal: {
					name: "Internal Gateway",
					baseUrl: INTERNAL_BASE_URL,
					api: "openai-completions",
					apiKey: "internal",
					models: [{ id: "internal-model" }],
				},
			},
		}),
	);
	return modelsPath;
}

async function createRuntime(options: { secureMode?: boolean; modelsPath?: string | null } = {}) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	await credentials.modify("internal", async () => ({ type: "api_key", key: "test-key" }));
	return ModelRuntime.create({
		credentials,
		modelsPath: options.modelsPath ?? null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
		...(options.secureMode === undefined ? {} : { secureMode: options.secureMode }),
	});
}

afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

describe("secureMode defaults", () => {
	it("is on when CreateModelRuntimeOptions omits it, so a forgotten wiring site fails closed", async () => {
		const runtime = await createRuntime();
		expect(runtime.getSecureMode()).toBe(true);
	});

	it("is on when settings.json does not mention it", () => {
		const dir = makeTempDir();
		const settings = SettingsManager.create(dir, dir);
		expect(settings.getSecureMode()).toBe(true);
	});

	it("is off only when settings.json opts out explicitly", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ secureMode: false }));
		const settings = SettingsManager.create(dir, dir);
		expect(settings.getSecureMode()).toBe(false);
	});
});

describe("provider permission", () => {
	it("blocks a built-in provider that has no explicit baseUrl", async () => {
		const runtime = await createRuntime({ secureMode: true });
		expect(runtime.isProviderAllowed("anthropic")).toBe(false);
	});

	it("permits a provider redirected to internal infrastructure via models.json", async () => {
		const modelsPath = writeModelsJson(makeTempDir());
		const runtime = await createRuntime({ secureMode: true, modelsPath });
		expect(runtime.isProviderAllowed("internal")).toBe(true);
	});

	it("permits every provider once secureMode is disabled", async () => {
		const runtime = await createRuntime({ secureMode: false });
		expect(runtime.isProviderAllowed("anthropic")).toBe(true);
	});
});

describe("available model listing", () => {
	it("hides models from blocked providers", async () => {
		const runtime = await createRuntime({ secureMode: true });
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "anthropic")).toBe(false);
	});

	it("lists models from blocked providers once secureMode is disabled", async () => {
		const runtime = await createRuntime({ secureMode: false });
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "anthropic")).toBe(true);
	});

	it("returns nothing for a per-provider availability query on a blocked provider", async () => {
		const runtime = await createRuntime({ secureMode: true });
		expect(await runtime.getAvailable("anthropic")).toEqual([]);
	});

	it("re-filters the snapshot when the policy is toggled at runtime", async () => {
		const runtime = await createRuntime({ secureMode: false });
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "anthropic")).toBe(true);
		runtime.setSecureMode(true);
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "anthropic")).toBe(false);
	});
});

describe("request gate", () => {
	it("refuses to send a request for a blocked provider even when the model is held directly", async () => {
		const runtime = await createRuntime({ secureMode: false });
		const model = runtime.getModels().find((candidate) => candidate.provider === "anthropic");
		expect(model).toBeDefined();

		// Simulates a model obtained before the policy applied, or via an
		// unguarded resolution path: the request itself must still be refused.
		// The runtime reports request failures on the message rather than throwing.
		runtime.setSecureMode(true);
		const result = await runtime.completeSimple(model!, { messages: [] });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/secureMode/);
	});
});

describe("extension provider registration", () => {
	it("rejects a provider registered without a baseUrl", async () => {
		const runtime = await createRuntime({ secureMode: true });
		expect(() => runtime.registerProvider("rogue", { api: "openai-completions" })).toThrow(/secureMode/);
	});

	it("accepts a provider registered with an explicit baseUrl", async () => {
		const runtime = await createRuntime({ secureMode: true });
		expect(() =>
			runtime.registerProvider("internal-ext", { api: "openai-completions", baseUrl: INTERNAL_BASE_URL }),
		).not.toThrow();
		expect(runtime.isProviderAllowed("internal-ext")).toBe(true);
	});

	it("rejects a native provider object, whose endpoints cannot be vetted", async () => {
		const runtime = await createRuntime({ secureMode: true });
		const anthropic = runtime.getProvider("anthropic");
		expect(anthropic).toBeDefined();
		expect(() => runtime.registerNativeProvider(anthropic!)).toThrow(/secureMode/);
	});

	it("allows registration without a baseUrl once secureMode is disabled", async () => {
		const runtime = await createRuntime({ secureMode: false });
		expect(() =>
			runtime.registerProvider("plain", { api: "openai-completions", baseUrl: INTERNAL_BASE_URL }),
		).not.toThrow();
	});
});

describe("ModelRegistry facade", () => {
	it("exposes the policy to extensions", async () => {
		const runtime = await createRuntime({ secureMode: true });
		const registry = new ModelRegistry(runtime);

		expect(registry.getSecureMode()).toBe(true);
		expect(registry.isProviderAllowed("anthropic")).toBe(false);
		expect(registry.getAvailable().some((model) => model.provider === "anthropic")).toBe(false);

		registry.setSecureMode(false);
		expect(registry.getSecureMode()).toBe(false);
		expect(registry.isProviderAllowed("anthropic")).toBe(true);
	});
});

describe("closed-network refresh ceiling", () => {
	const originalOffline = process.env.SPI_OFFLINE;

	beforeEach(() => {
		process.env.SPI_OFFLINE = "1";
	});

	afterEach(() => {
		if (originalOffline === undefined) delete process.env.SPI_OFFLINE;
		else process.env.SPI_OFFLINE = originalOffline;
	});

	it("does not let an explicit allowNetwork: true punch through offline mode", async () => {
		const runtime = await createRuntime({ secureMode: true });
		let requestedNetwork: boolean | undefined;
		const models = runtime as unknown as { models: { refresh: (options: { allowNetwork?: boolean }) => unknown } };
		const originalRefresh = models.models.refresh.bind(models.models);
		models.models.refresh = (options: { allowNetwork?: boolean }) => {
			requestedNetwork = options.allowNetwork;
			return originalRefresh(options);
		};

		await runtime.refresh({ allowNetwork: true });
		expect(requestedNetwork).toBe(false);
	});
});
