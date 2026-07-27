import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { ExtensionFactory } from "../src/core/sdk.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function nativeAnthropicProvider(baseUrl: string): Provider {
	const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, baseUrl };
	return {
		id: "anthropic",
		name: "Native Anthropic",
		baseUrl,
		auth: {
			apiKey: {
				name: "Test API key",
				resolve: async () => ({ auth: { apiKey: "test-key" }, source: "test" }),
			},
		},
		getModels: () => [model],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

describe("AgentSession dynamic provider registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dynamic-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(extensionFactories: ExtensionFactory[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			modelRuntime,
			resourceLoader,
		});

		return session;
	}

	async function capturePromptBaseUrl(
		session: Awaited<ReturnType<typeof createSession>>,
	): Promise<string | undefined> {
		let baseUrl: string | undefined;
		session.agent.streamFunction = async (model) => {
			baseUrl = model.baseUrl;
			throw new Error("stop");
		};
		await session.prompt("hello");
		return baseUrl;
	}

	it("applies top-level registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/top-level" });
			},
		]);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/top-level");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/top-level");

		session.dispose();
	});

	it("applies session_start registerProvider overrides to the active model", async () => {
		const session = await createSession([
			(pi) => {
				pi.on("session_start", () => {
					pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/session-start" });
				});
			},
		]);

		await session.bindExtensions({});

		expect(session.model?.baseUrl).toBe("http://localhost:8080/session-start");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/session-start");

		session.dispose();
	});

	it("registers native pi-ai providers during extension loading", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerProvider(nativeAnthropicProvider("http://localhost:8080/native-top-level"));
			},
		]);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/native-top-level");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/native-top-level");

		session.dispose();
	});

	it("applies command-time registerProvider overrides without reload", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerCommand("use-proxy", {
					description: "Use proxy",
					handler: async () => {
						pi.registerProvider("anthropic", { baseUrl: "http://localhost:8080/command" });
					},
				});
			},
		]);

		await session.bindExtensions({});
		await session.prompt("/use-proxy");

		expect(session.model?.baseUrl).toBe("http://localhost:8080/command");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/command");

		session.dispose();
	});

	it("registers native pi-ai providers at command time", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerCommand("use-native", {
					description: "Use native provider",
					handler: async () => {
						pi.registerProvider(nativeAnthropicProvider("http://localhost:8080/native-command"));
					},
				});
			},
		]);

		await session.bindExtensions({});
		await session.prompt("/use-native");

		expect(session.model?.baseUrl).toBe("http://localhost:8080/native-command");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/native-command");

		session.dispose();
	});

	it("replays duplicate provider registrations from a clean extension layer", async () => {
		let generation = 1;
		const session = await createSession([
			(pi) => {
				pi.registerProvider("reload-provider", {
					baseUrl: `https://generation-${generation}.test`,
					apiKey: "test-key",
					api: "openai-completions",
					...(generation === 1 ? { headers: { "x-stale": "yes" } } : {}),
					models: [
						{
							id: `model-${generation}`,
							name: `Model ${generation}`,
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				});
			},
			(pi) => {
				pi.registerProvider("reload-provider", { name: `Winner ${generation}` });
			},
		]);
		await session.modelRuntime.refresh({ allowNetwork: false });

		expect(session.modelRuntime.getRegisteredProviderConfig("reload-provider")).toMatchObject({
			name: "Winner 1",
			headers: { "x-stale": "yes" },
		});
		expect(session.modelRuntime.getModel("reload-provider", "model-1")).toBeDefined();

		generation = 2;
		await session.reload();

		expect(session.modelRuntime.getRegisteredProviderConfig("reload-provider")).toMatchObject({
			name: "Winner 2",
			baseUrl: "https://generation-2.test",
		});
		expect(session.modelRuntime.getRegisteredProviderConfig("reload-provider")?.headers).toBeUndefined();
		expect(session.modelRuntime.getModel("reload-provider", "model-1")).toBeUndefined();
		expect(session.modelRuntime.getModel("reload-provider", "model-2")).toBeDefined();
		session.dispose();
	});

	it("removes disabled providers and falls back when their model was active", async () => {
		let enabled = true;
		const session = await createSession([
			(pi) => {
				if (!enabled) return;
				pi.registerProvider("temporary-provider", {
					baseUrl: "https://temporary.test",
					apiKey: "test-key",
					api: "openai-completions",
					models: [
						{
							id: "temporary-model",
							name: "Temporary Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				});
			},
		]);
		await session.modelRuntime.refresh({ allowNetwork: false });
		const temporaryModel = session.modelRuntime.getModel("temporary-provider", "temporary-model")!;
		await session.setModel(temporaryModel);

		enabled = false;
		const result = await session.reload();

		expect(session.modelRuntime.getProvider("temporary-provider")).toBeUndefined();
		expect(session.modelRuntime.getModel("temporary-provider", "temporary-model")).toBeUndefined();
		expect(session.model).toBeDefined();
		expect(session.model?.provider).not.toBe("temporary-provider");
		expect(result.modelFallbackMessage).toContain(
			'Active model "temporary-provider/temporary-model" is no longer available after reload.',
		);
		session.dispose();
	});

	it("clears a removed active model when reload has no fallback", async () => {
		let enabled = true;
		const session = await createSession([
			(pi) => {
				if (!enabled) return;
				pi.registerProvider("temporary-provider", {
					baseUrl: "https://temporary.test",
					apiKey: "test-key",
					api: "openai-completions",
					models: [
						{
							id: "temporary-model",
							name: "Temporary Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				});
			},
		]);
		await session.modelRuntime.refresh({ allowNetwork: false });
		await session.setModel(session.modelRuntime.getModel("temporary-provider", "temporary-model")!);
		vi.spyOn(session.modelRuntime, "getAvailableSnapshot").mockReturnValue([]);

		enabled = false;
		const result = await session.reload();

		expect(session.model).toBeUndefined();
		expect(session.thinkingLevel).toBe("off");
		expect(result.modelFallbackMessage).toContain("No configured model is available");
		session.dispose();
	});
});
