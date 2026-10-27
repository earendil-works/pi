import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	defaultModelPerProvider,
	findInitialModel,
	type ModelReferenceRequest,
	resolveCliModel,
	resolveModelReference,
	resolveModelScope,
	resolveModelScopeWithDiagnostics,
} from "../src/core/model-resolver.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

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

function referenceModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

const referenceCatalog = [
	referenceModel("anthropic", "claude-sonnet-4-5"),
	referenceModel("anthropic", "claude-sonnet-4-5-20250929"),
	referenceModel("anthropic", "claude-opus-4-8"),
	referenceModel("anthropic", "exact"),
	// Fuzzy-matches "shared"; an ambiguous exact "shared" must not fall through to it.
	referenceModel("anthropic", "shared-pro"),
	referenceModel("openai", "gpt-4o"),
	referenceModel("openrouter", "qwen/qwen3-coder:exacto"),
	referenceModel("openrouter", "openai/gpt-4o:extended"),
	referenceModel("gw-a", "shared"),
	referenceModel("gw-a", "anthropic/future"),
	referenceModel("gw-a", "anthropic/exact"),
	referenceModel("gw-a", "anthropic/claude-opus-4.8"),
	referenceModel("gw-a", "anthropic/claude-opus"),
	referenceModel("gw-b", "shared"),
	referenceModel("gw-b", "anthropic/future"),
	referenceModel("gw-b", "claude-opus-4-8"),
	referenceModel("gw-b", "gw-b/free"),
	referenceModel("gw-b", "zz:free"),
	// URL-derived provider id containing "/" (#11394)
	referenceModel("llama=http://host:10800", "unsloth/qwen-gguf:BF16"),
];

type ReferenceExpected =
	| { model: string; thinkingLevel?: string; warning?: string }
	| { ambiguous: string[]; usableCount: number }
	| "not-found";

interface ReferenceCase {
	name: string;
	text: string;
	expected: ReferenceExpected;
	usable?: string[];
	provider?: string;
	thinkingSuffix?: ModelReferenceRequest["thinkingSuffix"];
	fuzzy?: boolean;
}

const referenceCases: ReferenceCase[] = [
	// Reference syntax
	{ name: "exact id", text: "claude-sonnet-4-5", expected: { model: "anthropic/claude-sonnet-4-5" } },
	{ name: "exact id is case-insensitive", text: "GPT-4O", expected: { model: "openai/gpt-4o" } },
	{ name: "fuzzy prefers aliases over dated ids", text: "sonnet", expected: { model: "anthropic/claude-sonnet-4-5" } },
	{
		name: "thinking suffix",
		text: "sonnet:high",
		expected: { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "high" },
	},
	{
		name: "colon in a literal id is not a thinking suffix",
		text: "qwen/qwen3-coder:exacto",
		expected: { model: "openrouter/qwen/qwen3-coder:exacto" },
	},
	{
		name: "provider prefix, colon id, and thinking suffix",
		text: "openrouter/qwen/qwen3-coder:exacto:high",
		expected: { model: "openrouter/qwen/qwen3-coder:exacto", thinkingLevel: "high" },
	},
	{
		name: "provider id containing a slash",
		text: "llama=http://host:10800/unsloth/qwen-gguf:BF16",
		expected: { model: "llama=http://host:10800/unsloth/qwen-gguf:BF16" },
	},
	{
		name: "provider id containing a slash, with thinking suffix",
		text: "llama=http://host:10800/unsloth/qwen-gguf:BF16:high",
		expected: { model: "llama=http://host:10800/unsloth/qwen-gguf:BF16", thinkingLevel: "high" },
	},
	{
		name: "raw id wins when the provider prefix names no matching model",
		text: "openai/gpt-4o:extended",
		expected: { model: "openrouter/openai/gpt-4o:extended" },
	},
	{
		name: "fuzzy searches the prefixed provider first",
		text: "openrouter/qwen",
		expected: { model: "openrouter/qwen/qwen3-coder:exacto" },
	},
	{ name: "strict keeps an invalid suffix in the id", text: "gpt-4o:random", expected: "not-found" },
	{
		name: "lenient drops an invalid suffix with a warning",
		text: "gpt-4o:random",
		thinkingSuffix: "lenient",
		expected: { model: "openai/gpt-4o", warning: 'Invalid thinking level "random"' },
	},
	{
		name: "lenient invalid outer suffix discards the inner thinking level",
		text: "qwen/qwen3-coder:exacto:high:random",
		thinkingSuffix: "lenient",
		expected: { model: "openrouter/qwen/qwen3-coder:exacto", warning: 'Invalid thinking level "random"' },
	},
	{ name: "none keeps the suffix in the id", text: "gpt-4o:high", thinkingSuffix: "none", expected: "not-found" },
	{ name: "exact-only skips fuzzy matches", text: "sonnet", fuzzy: false, expected: "not-found" },
	{ name: "empty text", text: "  ", expected: "not-found" },

	// Exact matches across providers
	// #7327
	{ name: "sole usable provider wins", text: "shared", usable: ["gw-b"], expected: { model: "gw-b/shared" } },
	{
		name: "no usable provider is ambiguous instead of falling through to fuzzy",
		text: "shared",
		expected: { ambiguous: ["gw-a/shared", "gw-b/shared"], usableCount: 0 },
	},
	{
		name: "several usable providers are ambiguous",
		text: "shared",
		usable: ["gw-a", "gw-b"],
		expected: { ambiguous: ["gw-a/shared", "gw-b/shared"], usableCount: 2 },
	},
	{
		name: "thinking suffix does not change provider selection",
		text: "shared:high",
		usable: ["gw-b"],
		expected: { model: "gw-b/shared", thinkingLevel: "high" },
	},
	{
		name: "thinking suffix does not bypass ambiguity",
		text: "shared:high",
		usable: ["gw-a", "gw-b"],
		expected: { ambiguous: ["gw-a/shared", "gw-b/shared"], usableCount: 2 },
	},
	{
		// #10160
		name: "provider prefix without a direct model selects the usable raw id",
		text: "anthropic/future",
		usable: ["gw-b"],
		expected: { model: "gw-b/anthropic/future" },
	},
	{
		// #5823
		name: "usable qualified match beats a usable raw id",
		text: "anthropic/exact",
		usable: ["anthropic", "gw-a"],
		expected: { model: "anthropic/exact" },
	},
	{
		// #5643
		name: "usable raw id beats an unusable qualified match",
		text: "anthropic/exact",
		usable: ["gw-a"],
		expected: { model: "gw-a/anthropic/exact" },
	},
	{
		name: "unusable qualified match is kept when nothing is usable",
		text: "anthropic/exact",
		expected: { model: "anthropic/exact" },
	},

	{
		// Like `mistral/codestral` -> mistral/codestral-latest despite gateway id `mistral/codestral`
		name: "named provider's usable fuzzy match beats a raw id elsewhere",
		text: "anthropic/claude-opus",
		usable: ["anthropic"],
		expected: { model: "anthropic/claude-opus-4-8" },
	},
	{
		name: "usable raw id beats the named provider's unusable fuzzy match",
		text: "anthropic/claude-opus",
		usable: ["gw-a"],
		expected: { model: "gw-a/anthropic/claude-opus" },
	},
	{
		name: "named provider's fuzzy match is kept when nothing is usable",
		text: "anthropic/claude-opus",
		expected: { model: "anthropic/claude-opus-4-8" },
	},
	{
		name: "named provider's literal id beats its fuzzy matches",
		text: "gw-b/free",
		expected: { model: "gw-b/gw-b/free" },
	},

	// Fuzzy matches across providers
	{
		name: "fuzzy prefers usable providers",
		text: "opus",
		usable: ["gw-a"],
		expected: { model: "gw-a/anthropic/claude-opus-4.8" },
	},
	{
		name: "fuzzy id tie across usable providers is ambiguous",
		text: "opus",
		usable: ["anthropic", "gw-a", "gw-b"],
		expected: { ambiguous: ["anthropic/claude-opus-4-8", "gw-b/claude-opus-4-8"], usableCount: 2 },
	},
	{
		name: "fuzzy id tie resolves to the sole usable provider",
		text: "opus",
		usable: ["anthropic"],
		expected: { model: "anthropic/claude-opus-4-8" },
	},

	// Explicit provider constraint
	{
		name: "explicit provider ignores usable providers elsewhere",
		text: "shared",
		provider: "gw-a",
		usable: ["gw-b"],
		expected: { model: "gw-a/shared" },
	},
	{
		name: "explicit provider accepts its own prefix",
		text: "GW-B/shared",
		provider: "gw-b",
		expected: { model: "gw-b/shared" },
	},
	{
		name: "explicit provider allows fuzzy matches",
		text: "4o",
		provider: "openai",
		expected: { model: "openai/gpt-4o" },
	},
	{ name: "explicit provider never leaves the provider", text: "gpt-4o", provider: "gw-a", expected: "not-found" },
];

function modelRef(m: Model<Api>): string {
	return `${m.provider}/${m.id}`;
}

describe("resolveModelReference", () => {
	test.each(referenceCases)("$name", (testCase) => {
		const usable = new Set(testCase.usable);
		const request: ModelReferenceRequest = {
			text: testCase.text,
			provider: testCase.provider,
			thinkingSuffix: testCase.thinkingSuffix ?? "strict",
			fuzzy: testCase.fuzzy ?? true,
		};
		// Catalog order must never decide the result.
		for (const models of [referenceCatalog, [...referenceCatalog].reverse()]) {
			const result = resolveModelReference(request, models, (provider) => usable.has(provider));
			const expected = testCase.expected;
			if (expected === "not-found") {
				expect(result.status).toBe("not-found");
			} else if ("ambiguous" in expected) {
				expect(result.status).toBe("ambiguous");
				if (result.status !== "ambiguous") continue;
				expect(result.candidates.map(modelRef).sort()).toEqual(expected.ambiguous);
				expect(result.usableCount).toBe(expected.usableCount);
			} else {
				expect(result.status).toBe("resolved");
				if (result.status !== "resolved") continue;
				expect(modelRef(result.model)).toBe(expected.model);
				expect(result.thinkingLevel).toBe(expected.thinkingLevel);
				if (expected.warning) expect(result.warning).toContain(expected.warning);
				else expect(result.warning).toBeUndefined();
			}
		}
	});
});

describe("resolveModelScopeWithDiagnostics", () => {
	test("returns scoped models and structured diagnostics without writing console warnings", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const registry = {
				getAvailable: () => allModels,
			} as unknown as Parameters<typeof resolveModelScopeWithDiagnostics>[1];

			const result = await resolveModelScopeWithDiagnostics(["sonnet:high", "gpt-4o:invalid", "missing"], registry);

			expect(result.scopedModels.map((scoped) => scoped.model.id)).toEqual(["claude-sonnet-4-5", "gpt-4o"]);
			expect(result.scopedModels[0].thinkingLevel).toBe("high");
			expect(result.scopedModels[1].thinkingLevel).toBeUndefined();
			expect(result.diagnostics).toEqual([
				{
					type: "warning",
					message: 'Invalid thinking level "invalid" in pattern "gpt-4o:invalid". Using default instead.',
					code: "invalid-thinking-level",
					pattern: "gpt-4o:invalid",
				},
				{
					type: "warning",
					message: 'No models match pattern "missing"',
					code: "no-match",
					pattern: "missing",
				},
			]);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	test("resolveModelScope preserves CLI warning output", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const registry = {
				getAvailable: () => allModels,
			} as unknown as Parameters<typeof resolveModelScope>[1];

			const scopedModels = await resolveModelScope(["missing"], registry);

			expect(scopedModels).toEqual([]);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0][0]).toContain('Warning: No models match pattern "missing"');
		} finally {
			warn.mockRestore();
		}
	});

	test("adds every provider for a pattern matching the same id on several providers, with a warning", async () => {
		const registry = {
			getAvailable: () => [
				...allModels,
				{ ...mockModels[1], provider: "azure" },
				{ ...mockModels[1], provider: "openai-codex", id: "gpt-4o-mini" },
			],
		} as unknown as Parameters<typeof resolveModelScopeWithDiagnostics>[1];

		for (const [pattern, thinkingLevel] of [
			["gpt-4o:high", "high"],
			["GPT-4o", undefined],
		] as const) {
			const result = await resolveModelScopeWithDiagnostics([pattern], registry);

			expect(
				result.scopedModels.map((scoped) => [`${scoped.model.provider}/${scoped.model.id}`, scoped.thinkingLevel]),
			).toEqual(
				expect.arrayContaining([
					["azure/gpt-4o", thinkingLevel],
					["openai/gpt-4o", thinkingLevel],
				]),
			);
			expect(result.scopedModels).toHaveLength(2);
			expect(result.diagnostics).toEqual([
				{
					type: "warning",
					code: "ambiguous",
					message: `Pattern "${pattern}" matches several providers: azure, openai. Use provider/id to choose one.`,
					pattern,
				},
			]);
		}
	});

	test("resolves bracketed model ids as exact references before glob matching", async () => {
		const bracketedModel: Model<"anthropic-messages"> = {
			id: "bracketed-model[1m]",
			name: "Bracketed Model",
			api: "anthropic-messages",
			provider: "custom",
			baseUrl: "https://example.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			getAvailable: () => [...allModels, bracketedModel],
		} as unknown as Parameters<typeof resolveModelScopeWithDiagnostics>[1];

		const result = await resolveModelScopeWithDiagnostics(["custom/bracketed-model[1m]"], registry);

		expect(result.scopedModels.map((scoped) => scoped.model.id)).toEqual(["bracketed-model[1m]"]);
		expect(result.diagnostics).toEqual([]);
	});

	test("resolves bracketed model ids with thinking levels as exact references before glob matching", async () => {
		const bracketedModel: Model<"anthropic-messages"> = {
			id: "bracketed-model[1m]",
			name: "Bracketed Model",
			api: "anthropic-messages",
			provider: "custom",
			baseUrl: "https://example.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const registry = {
			getAvailable: () => [...allModels, bracketedModel],
		} as unknown as Parameters<typeof resolveModelScopeWithDiagnostics>[1];

		const result = await resolveModelScopeWithDiagnostics(["custom/bracketed-model[1m]:high"], registry);

		expect(result.scopedModels.map((scoped) => scoped.model.id)).toEqual(["bracketed-model[1m]"]);
		expect(result.scopedModels[0].thinkingLevel).toBe("high");
		expect(result.diagnostics).toEqual([]);
	});
});

describe("resolveCliModel", () => {
	test("does not strip invalid :suffix as thinking level in --model (treat as raw id)", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o:extended",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o:extended");
	});

	test("allows custom model ids for explicit providers without double prefixing", () => {
		const registry = {
			getModels: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliProvider: "openrouter",
			cliModel: "openrouter/openai/ghost-model",
			modelRuntime: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/ghost-model");
	});

	test("returns a clear error when there are no models", () => {
		const registry = {
			getModels: () => [],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o",
			modelRuntime: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("No models available");
	});

	describe("duplicate raw ids behind a known provider prefix (#10160)", () => {
		const direct = { ...mockModels[0], id: "claude-sonnet-4-5", provider: "anthropic" };
		const openrouter = { ...mockModels[0], id: "anthropic/claude-opus-5.5", provider: "openrouter" };
		const vercel = { ...mockModels[0], id: "anthropic/claude-opus-5.5", provider: "vercel-ai-gateway" };
		const registry = (configured: string[]) =>
			({
				getModels: () => [direct, openrouter, vercel],
				hasConfiguredAuth: (provider: string) => configured.includes(provider),
			}) as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

		test("selects the authenticated gateway, with or without a thinking suffix", () => {
			for (const [cliModel, thinkingLevel] of [
				["anthropic/claude-opus-5.5", undefined],
				["anthropic/claude-opus-5.5:high", "high"],
			] as const) {
				const result = resolveCliModel({ cliModel, modelRuntime: registry(["vercel-ai-gateway"]) });

				expect(result.error).toBeUndefined();
				expect(result.model?.provider).toBe("vercel-ai-gateway");
				expect(result.thinkingLevel).toBe(thinkingLevel);
			}
		});

		test("reports ambiguity instead of choosing by catalog order", () => {
			const result = resolveCliModel({ cliModel: "anthropic/claude-opus-5.5", modelRuntime: registry([]) });

			expect(result.model).toBeUndefined();
			expect(result.error).toContain(
				"openrouter/anthropic/claude-opus-5.5, vercel-ai-gateway/anthropic/claude-opus-5.5",
			);
			expect(result.error).toContain("No matching provider is authenticated. Use --provider or provider/model.");
		});

		test("does not let stored credentials choose the provider for --api-key", () => {
			const result = resolveCliModel({
				cliModel: "anthropic/claude-opus-5.5",
				inlineApiKey: true,
				modelRuntime: registry(["vercel-ai-gateway"]),
			});

			expect(result.model).toBeUndefined();
			expect(result.error).toContain("--api-key does not choose a provider.");
		});
	});

	describe("custom model fallback with :thinking suffix (#5552)", () => {
		// Models for a provider that has registered models but the specific model ID
		// is not in the registry (triggers buildFallbackModel path).
		const neuralwattModel: Model<"anthropic-messages"> = {
			id: "some-base-model",
			name: "Some Base Model",
			api: "anthropic-messages",
			provider: "neuralwatt",
			baseUrl: "https://api.neuralwatt.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};

		const modelsWithNeuralwatt = [...allModels, neuralwattModel];

		test("strips :thinking suffix from custom model id in fallback path", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			const result = resolveCliModel({
				cliModel: "neuralwatt/zai-org/GLM-5.1-FP8:high",
				modelRuntime: registry,
			});

			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("neuralwatt");
			// The :high suffix must NOT leak into the model id sent to the API
			expect(result.model?.id).toBe("zai-org/GLM-5.1-FP8");
			expect(result.model?.reasoning).toBe(true);
			expect(result.thinkingLevel).toBe("high");
		});

		test("custom model without thinking suffix works normally in fallback path", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			const result = resolveCliModel({
				cliModel: "neuralwatt/zai-org/GLM-5.1-FP8",
				modelRuntime: registry,
			});

			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("neuralwatt");
			expect(result.model?.id).toBe("zai-org/GLM-5.1-FP8");
			expect(result.thinkingLevel).toBeUndefined();
		});

		test("all valid thinking levels work in fallback path", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
				const result = resolveCliModel({
					cliModel: `neuralwatt/zai-org/GLM-5.1-FP8:${level}`,
					modelRuntime: registry,
				});

				expect(result.error).toBeUndefined();
				expect(result.model?.id).toBe("zai-org/GLM-5.1-FP8");
				expect(result.thinkingLevel).toBe(level);
			}
		});

		test("invalid thinking suffix on custom model is treated as part of model id", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			const result = resolveCliModel({
				cliModel: "neuralwatt/zai-org/GLM-5.1-FP8:banana",
				modelRuntime: registry,
			});

			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("neuralwatt");
			// Invalid suffix stays in the id (it's not a thinking level)
			expect(result.model?.id).toBe("zai-org/GLM-5.1-FP8:banana");
			expect(result.thinkingLevel).toBeUndefined();
		});

		test("explicit --provider with custom model:thinking strips suffix correctly", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			const result = resolveCliModel({
				cliProvider: "neuralwatt",
				cliModel: "zai-org/GLM-5.1-FP8:high",
				modelRuntime: registry,
			});

			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("neuralwatt");
			expect(result.model?.id).toBe("zai-org/GLM-5.1-FP8");
			expect(result.thinkingLevel).toBe("high");
		});

		test("with explicit --thinking, :suffix is kept as part of model id", () => {
			const registry = {
				getModels: () => modelsWithNeuralwatt,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRuntime"];

			const result = resolveCliModel({
				cliModel: "neuralwatt/zai-org/GLM-5.1-FP8:high",
				cliThinking: "medium",
				modelRuntime: registry,
			});

			expect(result.error).toBeUndefined();
			expect(result.model?.provider).toBe("neuralwatt");
			// :high is kept as part of the model id since --thinking was explicit
			expect(result.model?.id).toBe("zai-org/GLM-5.1-FP8:high");
			expect(result.thinkingLevel).toBeUndefined();
		});
	});
});

describe("default model selection", () => {
	test("openai defaults track current models", () => {
		expect(defaultModelPerProvider.openai).toBe("gpt-6.1-sol");
		expect(defaultModelPerProvider["openai-codex"]).toBe("gpt-6.1-sol");
	});

	test("zai, minimax, cerebras, and ant-ling defaults track current models", () => {
		expect(defaultModelPerProvider.zai).toBe("glm-5.3");
		expect(defaultModelPerProvider["zai-coding-cn"]).toBe("glm-5.3");
		expect(defaultModelPerProvider.minimax).toBe("MiniMax-M2.7");
		expect(defaultModelPerProvider["minimax-cn"]).toBe("MiniMax-M2.7");
		expect(defaultModelPerProvider.cerebras).toBe("gpt-oss-120b");
		expect(defaultModelPerProvider["ant-ling"]).toBe("Ring-2.6-1T");
	});

	test("built-in chat providers have defaults in their generated catalogs", () => {
		for (const provider of getBuiltinProviders()) {
			const chatModels = getBuiltinModels(provider);
			const defaultId = defaultModelPerProvider[provider];
			if (chatModels.length === 0) {
				expect(defaultId, `${provider} has no chat models and should have no chat default`).toBeUndefined();
				continue;
			}
			expect(
				chatModels.some((model) => model.id === defaultId),
				`${provider} default ${defaultId} should exist in its generated catalog`,
			).toBe(true);
		}
	});

	test("ai-gateway default tracks current model", () => {
		expect(defaultModelPerProvider["vercel-ai-gateway"]).toBe("zai/glm-5.1");
	});

	test("xai default tracks current model", () => {
		expect(defaultModelPerProvider.xai).toBe("grok-4.7");
	});

	test("qwen token plan individual default tracks current model", () => {
		expect(defaultModelPerProvider["qwen-token-plan-individual"]).toBe("qwen3.8-max");
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
			getAvailableSnapshot: () => [aiGatewayModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRuntime: registry,
		});

		expect(result.model?.provider).toBe("vercel-ai-gateway");
		expect(result.model?.id).toBe("anthropic/claude-opus-4-6");
	});

	test("findInitialModel ignores an unauthenticated saved default", async () => {
		const savedDeepSeekModel: Model<"anthropic-messages"> = {
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "anthropic-messages",
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		};
		const localDeepSeekModel: Model<"anthropic-messages"> = {
			...savedDeepSeekModel,
			provider: "spark-two",
			baseUrl: "http://spark-two:8000/v1",
		};
		const registry = {
			getModel: (provider: string, modelId: string) =>
				provider === savedDeepSeekModel.provider && modelId === savedDeepSeekModel.id
					? savedDeepSeekModel
					: undefined,
			hasConfiguredAuth: (provider: string) => provider === "spark-two",
			getAvailableSnapshot: () => [localDeepSeekModel],
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "deepseek",
			defaultModelId: "deepseek-v4-flash",
			modelRuntime: registry,
		});

		expect(result.model?.provider).toBe("spark-two");
		expect(result.model?.id).toBe("deepseek-v4-flash");
	});

	describe("persisted default model scoping", () => {
		const tempDirs: string[] = [];
		const sonnet = getModel("anthropic", "claude-sonnet-4-5")!;
		const opus = getModel("anthropic", "claude-opus-4-8")!;

		afterEach(() => {
			for (const dir of tempDirs.splice(0)) {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		async function createSession(options: { scoped: boolean; persistedScope?: string[] }) {
			const tempDir = join(tmpdir(), `pi-default-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(tempDir, { recursive: true });
			tempDirs.push(tempDir);

			const settingsManager = SettingsManager.create(tempDir, tempDir);
			if (options.persistedScope) {
				settingsManager.setEnabledModels(options.persistedScope);
			}

			const authStorage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test-key" } });
			const modelRuntime = getModelRuntime(await createModelRegistry(authStorage, join(tempDir, "models.json")));
			const agent = new Agent({
				initialState: {
					model: sonnet,
					systemPrompt: "test",
					tools: [],
				},
				streamFn: streamSimple,
			});
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(tempDir),
				settingsManager,
				cwd: tempDir,
				modelRuntime,
				resourceLoader: createTestResourceLoader(),
				scopedModels: options.scoped ? [{ model: sonnet }] : [],
			});

			return { session, settingsManager };
		}

		test("adds a persisted default to an existing scoped model list", async () => {
			const { session, settingsManager } = await createSession({
				scoped: true,
				persistedScope: [`${sonnet.provider}/${sonnet.id}`],
			});

			await session.setModel(opus, { persist: true });

			expect(settingsManager.getDefaultProvider()).toBe(opus.provider);
			expect(settingsManager.getDefaultModel()).toBe(opus.id);
			expect(session.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
				`${sonnet.provider}/${sonnet.id}`,
				`${opus.provider}/${opus.id}`,
			]);
			expect(settingsManager.getEnabledModels()).toEqual([
				`${sonnet.provider}/${sonnet.id}`,
				`${opus.provider}/${opus.id}`,
			]);
		});

		test("does not create a scoped model list when all models are available", async () => {
			const { session, settingsManager } = await createSession({ scoped: false });

			await session.setModel(opus, { persist: true });

			expect(session.scopedModels).toEqual([]);
			expect(settingsManager.getEnabledModels()).toBeUndefined();
		});

		test("keeps session-only model changes out of scope", async () => {
			const { session, settingsManager } = await createSession({
				scoped: true,
				persistedScope: [`${sonnet.provider}/${sonnet.id}`],
			});

			await session.setModel(opus, { persist: false });

			expect(session.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
				`${sonnet.provider}/${sonnet.id}`,
			]);
			expect(settingsManager.getEnabledModels()).toEqual([`${sonnet.provider}/${sonnet.id}`]);
		});
	});
});
