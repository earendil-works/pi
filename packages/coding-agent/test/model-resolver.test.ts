import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, test } from "vitest";
import {
	defaultModelPerProvider,
	findInitialModel,
	parseModelPattern,
	resolveCliModel,
} from "../src/core/model-resolver.js";

// Mock models for testing
const mockModels: Model<"anthropic-messages">[] = [
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		id: "gpt-4o",
		name: "GPT-4o",
		api: "anthropic-messages", // Using same type for simplicity
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

// Mock OpenRouter models with colons in IDs
const mockOpenRouterModels: Model<"anthropic-messages">[] = [
	{
		id: "qwen/qwen3-coder:exacto",
		name: "Qwen3 Coder Exacto",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	},
	{
		id: "openai/gpt-4o:extended",
		name: "GPT-4o Extended",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

const allModels = [...mockModels, ...mockOpenRouterModels];

describe("parseModelPattern", () => {
	describe("simple patterns without colons", () => {
		test("exact match returns model with undefined thinking level", () => {
			const result = parseModelPattern("claude-sonnet-4-5", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});

		test("partial match returns best model with undefined thinking level", () => {
			const result = parseModelPattern("sonnet", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});

		test("no match returns undefined model and thinking level", () => {
			const result = parseModelPattern("nonexistent", allModels);
			expect(result.model).toBeUndefined();
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});
	});

	describe("patterns with valid thinking levels", () => {
		test("sonnet:high returns sonnet with high thinking level", () => {
			const result = parseModelPattern("sonnet:high", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBe("high");
			expect(result.warning).toBeUndefined();
		});

		test("gpt-4o:medium returns gpt-4o with medium thinking level", () => {
			const result = parseModelPattern("gpt-4o:medium", allModels);
			expect(result.model?.id).toBe("gpt-4o");
			expect(result.thinkingLevel).toBe("medium");
			expect(result.warning).toBeUndefined();
		});

		test("all valid thinking levels work", () => {
			for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
				const result = parseModelPattern(`sonnet:${level}`, allModels);
				expect(result.model?.id).toBe("claude-sonnet-4-5");
				expect(result.thinkingLevel).toBe(level);
				expect(result.warning).toBeUndefined();
			}
		});
	});

	describe("patterns with invalid thinking levels", () => {
		test("sonnet:random returns sonnet with undefined thinking level and warning", () => {
			const result = parseModelPattern("sonnet:random", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});

		test("gpt-4o:invalid returns gpt-4o with undefined thinking level and warning", () => {
			const result = parseModelPattern("gpt-4o:invalid", allModels);
			expect(result.model?.id).toBe("gpt-4o");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toContain("Invalid thinking level");
		});
	});

	describe("OpenRouter models with colons in IDs", () => {
		test("qwen3-coder:exacto matches the model with undefined thinking level", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});

		test("openrouter/qwen/qwen3-coder:exacto matches with provider prefix", () => {
			const result = parseModelPattern("openrouter/qwen/qwen3-coder:exacto", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.model?.provider).toBe("openrouter");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});

		test("qwen3-coder:exacto:high matches model with high thinking level", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto:high", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBe("high");
			expect(result.warning).toBeUndefined();
		});

		test("openrouter/qwen/qwen3-coder:exacto:high matches with provider and thinking level", () => {
			const result = parseModelPattern("openrouter/qwen/qwen3-coder:exacto:high", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.model?.provider).toBe("openrouter");
			expect(result.thinkingLevel).toBe("high");
			expect(result.warning).toBeUndefined();
		});

		test("gpt-4o:extended matches the extended model with undefined thinking level", () => {
			const result = parseModelPattern("openai/gpt-4o:extended", allModels);
			expect(result.model?.id).toBe("openai/gpt-4o:extended");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toBeUndefined();
		});
	});

	describe("invalid thinking levels with OpenRouter models", () => {
		test("qwen3-coder:exacto:random returns model with undefined thinking level and warning", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto:random", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});

		test("qwen3-coder:exacto:high:random returns model with undefined thinking level and warning", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto:high:random", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});
	});

	describe("edge cases", () => {
		test("empty pattern matches via partial matching", () => {
			// Empty string is included in all model IDs, so partial matching finds a match
			const result = parseModelPattern("", allModels);
			expect(result.model).not.toBeNull();
			expect(result.thinkingLevel).toBeUndefined();
		});

		test("pattern ending with colon treats empty suffix as invalid", () => {
			const result = parseModelPattern("sonnet:", allModels);
			// Empty string after colon is not a valid thinking level
			// So it tries to match "sonnet:" which won't match, then tries "sonnet"
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.warning).toContain("Invalid thinking level");
		});
	});
});

describe("resolveCliModel", () => {
	test("resolves --model provider/id without --provider", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openai/gpt-4o",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("resolves fuzzy patterns within an explicit provider", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "4o",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("supports --model <pattern>:<thinking> (without explicit --thinking)", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "sonnet:high",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe("high");
	});

	test("prefers exact model id match over provider inference (OpenRouter-style ids)", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openai/gpt-4o:extended",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/gpt-4o:extended");
	});

	test("does not strip invalid :suffix as thinking level in --model (treat as raw id)", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o:extended",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o:extended");
	});

	test("allows custom model ids for explicit providers without double prefixing", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openrouter",
			cliModel: "openrouter/openai/ghost-model",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/ghost-model");
	});

	test("returns a clear error when there are no models", () => {
		const registry = {
			getAll: () => [],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o",
			modelRegistry: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("No models available");
	});

	test("prefers provider/model split over gateway model with matching id", () => {
		// When a user writes "zai/glm-5", and both a zai provider model (id: "glm-5")
		// and a gateway model (id: "zai/glm-5") exist, prefer the zai provider model.
		const zaiModel: Model<"anthropic-messages"> = {
			id: "glm-5",
			name: "GLM-5",
			api: "anthropic-messages",
			provider: "zai",
			baseUrl: "https://open.bigmodel.cn/api/paas/v4",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const gatewayModel: Model<"anthropic-messages"> = {
			id: "zai/glm-5",
			name: "GLM-5",
			api: "anthropic-messages",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			getAll: () => [...allModels, zaiModel, gatewayModel],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "zai/glm-5",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("zai");
		expect(result.model?.id).toBe("glm-5");
	});

	test("resolves provider-prefixed fuzzy patterns (openrouter/qwen -> openrouter model)", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openrouter/qwen",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
	});
});

describe("default model selection", () => {
	test("openai defaults track current models", () => {
		expect(defaultModelPerProvider.openai).toBe("gpt-5.4");
		expect(defaultModelPerProvider["openai-codex"]).toBe("gpt-5.5");
	});

	test("zai, minimax, and cerebras defaults track current models", () => {
		expect(defaultModelPerProvider.zai).toBe("glm-5.1");
		expect(defaultModelPerProvider.minimax).toBe("MiniMax-M2.7");
		expect(defaultModelPerProvider["minimax-cn"]).toBe("MiniMax-M2.7");
		expect(defaultModelPerProvider.cerebras).toBe("zai-glm-4.7");
	});

	test("ai-gateway default tracks current model", () => {
		expect(defaultModelPerProvider["vercel-ai-gateway"]).toBe("zai/glm-5.1");
	});

	test("findInitialModel accepts explicit provider custom model ids", async () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];

		const result = await findInitialModel({
			cliProvider: "openrouter",
			cliModel: "openrouter/openai/ghost-model",
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registry,
		});

		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/ghost-model");
	});

	test("findInitialModel selects ai-gateway default when available", async () => {
		const aiGatewayModel: Model<"anthropic-messages"> = {
			id: "anthropic/claude-opus-4-6",
			name: "Claude Opus 4.6",
			api: "anthropic-messages",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
			contextWindow: 200000,
			maxTokens: 8192,
		};

		const registry = {
			getAvailable: async () => [aiGatewayModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registry,
		});

		expect(result.model?.provider).toBe("vercel-ai-gateway");
		expect(result.model?.id).toBe("anthropic/claude-opus-4-6");
	});
});
