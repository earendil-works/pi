import { describe, expect, it, vi } from "vitest";

describe("model selector: built-in + custom model de-duplication", () => {
	it("does not return duplicate entries when models.json defines the same provider+id as a built-in model", async () => {
		vi.resetModules();

		const fakeHome = "/tmp/mu-home";
		const configPath = `${fakeHome}/.mu/agent/models.json`;

		// Mock os.homedir() so model-config reads from our fake path
		vi.doMock("os", () => ({
			homedir: () => fakeHome,
		}));

		// Mock fs so model-config finds and reads a controlled models.json
		vi.doMock("fs", () => ({
			existsSync: (p: string) => p === configPath,
			readFileSync: (p: string) => {
				if (p !== configPath) throw new Error(`unexpected readFileSync(${p})`);
				return JSON.stringify({
					providers: {
						moonshot: {
							baseUrl: "https://api.moonshot.ai/v1",
							apiKey: "MOONSHOT_API_KEY",
							api: "openai-completions",
							models: [
								{
									id: "kimi-k2.5",
									name: "Kimi K2.5 (Moonshot)",
									reasoning: true,
									reasoningFormat: "reasoning_content",
									input: ["text", "image"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 262144,
									maxTokens: 32768,
								},
							],
						},
					},
				});
			},
		}));

		// Mock pi-ai model registry so there is also a built-in moonshot/kimi-k2.5
		vi.doMock("@kennyfrc/mu-ai", () => ({
			getProviders: () => ["moonshot"],
			getModels: () => [
				{
					id: "kimi-k2.5",
					name: "Kimi K2.5 (Moonshot Built-in)",
					api: "openai-completions",
					provider: "moonshot",
					baseUrl: "https://api.moonshot.ai/v1",
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 262144,
					maxTokens: 32768,
				},
			],
			getApiKey: () => "test",
		}));

		const { loadAndMergeModels } = await import("../src/model-config.js");
		const { models, error } = loadAndMergeModels();
		expect(error).toBeNull();

		const moonshot = models.filter((m) => m.provider === "moonshot" && m.id === "kimi-k2.5");
		expect(moonshot.length).toBe(1);
	});
});
