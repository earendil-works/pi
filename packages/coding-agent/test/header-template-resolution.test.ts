import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("resolveHeaderTemplates", () => {
	beforeEach(() => {
		process.env.MU_SESSION_ID = "session-abc-123";
		process.env.MU_RUN_ID = "run-xyz-456";
	});

	afterEach(() => {
		delete process.env.MU_SESSION_ID;
		delete process.env.MU_RUN_ID;
		delete process.env.CUSTOM_VAR;
	});

	it("resolves ${MU_SESSION_ID} in header values", async () => {
		vi.resetModules();
		vi.doMock("@kennyfrc/mu-ai", () => ({
			getProviders: () => [] as string[],
			getModels: () => [] as unknown[],
			getApiKey: () => undefined,
		}));
		vi.doMock("../../ai/src/utils/oauth/index.js", () => ({
			getOAuthApiKey: async () => null,
			getOAuthProviderForModelProvider: () => undefined,
			loadOAuthCredentials: () => null,
		}));

		const { loadAndMergeModels } = await import("../src/model-config.js");

		// Temporarily write a models.json with header templates
		const fs = await import("fs");
		const os = await import("os");
		const path = await import("path");
		const configPath = path.join(os.homedir(), ".mu", "agent", "models.json");

		const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : null;

		const testConfig = {
			providers: {
				testprovider: {
					baseUrl: "https://api.test.com/v1",
					apiKey: "test-key",
					api: "openai-completions",
					headers: {
						"x-session-affinity": "${MU_SESSION_ID}",
						"x-run-id": "${MU_RUN_ID}",
						"x-static": "fixed-value",
					},
					models: [
						{
							id: "test-model",
							name: "Test Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				},
			},
		};

		fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

		try {
			const { models } = loadAndMergeModels();
			expect(models).toBeDefined();

			const testModel = models.find((m) => m.provider === "testprovider" && m.id === "test-model");
			expect(testModel).toBeDefined();
			expect(testModel!.headers).toEqual({
				"x-session-affinity": "session-abc-123",
				"x-run-id": "run-xyz-456",
				"x-static": "fixed-value",
			});
		} finally {
			if (original !== null) {
				fs.writeFileSync(configPath, original);
			} else {
				fs.unlinkSync(configPath);
			}
		}
	});

	it("resolves model-level headers that override provider-level", async () => {
		vi.resetModules();
		vi.doMock("@kennyfrc/mu-ai", () => ({
			getProviders: () => [] as string[],
			getModels: () => [] as unknown[],
			getApiKey: () => undefined,
		}));
		vi.doMock("../../ai/src/utils/oauth/index.js", () => ({
			getOAuthApiKey: async () => null,
			getOAuthProviderForModelProvider: () => undefined,
			loadOAuthCredentials: () => null,
		}));

		const { loadAndMergeModels } = await import("../src/model-config.js");

		const fs = await import("fs");
		const os = await import("os");
		const path = await import("path");
		const configPath = path.join(os.homedir(), ".mu", "agent", "models.json");

		const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : null;

		const testConfig = {
			providers: {
				testprovider: {
					baseUrl: "https://api.test.com/v1",
					apiKey: "test-key",
					api: "openai-completions",
					headers: {
						"x-session-affinity": "${MU_SESSION_ID}",
					},
					models: [
						{
							id: "test-model-a",
							name: "Test A",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
							headers: {
								"x-session-id": "${MU_SESSION_ID}",
							},
						},
						{
							id: "test-model-b",
							name: "Test B",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				},
			},
		};

		fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

		try {
			const { models } = loadAndMergeModels();
			const modelA = models.find((m) => m.id === "test-model-a");
			const modelB = models.find((m) => m.id === "test-model-b");

			// Model A: provider header + model-level header override
			expect(modelA!.headers).toEqual({
				"x-session-affinity": "session-abc-123",
				"x-session-id": "session-abc-123",
			});

			// Model B: only provider-level header
			expect(modelB!.headers).toEqual({
				"x-session-affinity": "session-abc-123",
			});
		} finally {
			if (original !== null) {
				fs.writeFileSync(configPath, original);
			} else {
				fs.unlinkSync(configPath);
			}
		}
	});

	it("leaves unresolved env vars as-is", async () => {
		vi.resetModules();
		vi.doMock("@kennyfrc/mu-ai", () => ({
			getProviders: () => [] as string[],
			getModels: () => [] as unknown[],
			getApiKey: () => undefined,
		}));
		vi.doMock("../../ai/src/utils/oauth/index.js", () => ({
			getOAuthApiKey: async () => null,
			getOAuthProviderForModelProvider: () => undefined,
			loadOAuthCredentials: () => null,
		}));

		const { loadAndMergeModels } = await import("../src/model-config.js");

		const fs = await import("fs");
		const os = await import("os");
		const path = await import("path");
		const configPath = path.join(os.homedir(), ".mu", "agent", "models.json");

		const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : null;

		const testConfig = {
			providers: {
				testprovider: {
					baseUrl: "https://api.test.com/v1",
					apiKey: "test-key",
					api: "openai-completions",
					headers: {
						"x-custom": "${NONEXISTENT_VAR}",
						"x-mixed": "prefix-${MU_SESSION_ID}-suffix",
					},
					models: [
						{
							id: "test-model",
							name: "Test Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				},
			},
		};

		fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

		try {
			const { models } = loadAndMergeModels();
			const testModel = models.find((m) => m.id === "test-model");

			// Unresolved var stays as template literal
			expect(testModel!.headers).toEqual({
				"x-custom": "${NONEXISTENT_VAR}",
				"x-mixed": "prefix-session-abc-123-suffix",
			});
		} finally {
			if (original !== null) {
				fs.writeFileSync(configPath, original);
			} else {
				fs.unlinkSync(configPath);
			}
		}
	});
});
