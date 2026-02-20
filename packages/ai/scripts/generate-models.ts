#!/usr/bin/env tsx

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Api, KnownProvider, Model } from "../src/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");

interface ModelsDevModel {
	id: string;
	name: string;
	tool_call?: boolean;
	reasoning?: boolean;
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	modalities?: {
		input?: string[];
	};
}

async function fetchOpenRouterModels(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from OpenRouter API...");
		const response = await fetch("https://openrouter.ai/api/v1/models");
		const data = await response.json();

		const models: Model<any>[] = [];

		for (const model of data.data) {
			// Only include models that support tools
			if (!model.supported_parameters?.includes("tools")) continue;

			// Parse provider from model ID
			let provider: KnownProvider = "openrouter";
			let modelKey = model.id;

			modelKey = model.id; // Keep full ID for OpenRouter

			// Parse input modalities
			const input: ("text" | "image")[] = ["text"];
			if (model.architecture?.modality?.includes("image")) {
				input.push("image");
			}

			// Convert pricing from $/token to $/million tokens
			const inputCost = parseFloat(model.pricing?.prompt || "0") * 1_000_000;
			const outputCost = parseFloat(model.pricing?.completion || "0") * 1_000_000;
			const cacheReadCost = parseFloat(model.pricing?.input_cache_read || "0") * 1_000_000;
			const cacheWriteCost = parseFloat(model.pricing?.input_cache_write || "0") * 1_000_000;

			const normalizedModel: Model<any> = {
				id: modelKey,
				name: model.name,
				api: "openai-completions",
				baseUrl: "https://openrouter.ai/api/v1",
				provider,
				reasoning: model.supported_parameters?.includes("reasoning") || false,
				input,
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: cacheReadCost,
					cacheWrite: cacheWriteCost,
				},
				contextWindow: model.context_length || 4096,
				maxTokens: model.top_provider?.max_completion_tokens || 4096,
			};
			models.push(normalizedModel);
		}

		console.log(`Fetched ${models.length} tool-capable models from OpenRouter`);
		return models;
	} catch (error) {
		console.error("Failed to fetch OpenRouter models:", error);
		return [];
	}
}

async function loadModelsDevData(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from models.dev API...");
		const response = await fetch("https://models.dev/api.json");
		const data = await response.json();

		const models: Model<any>[] = [];

		// Process Anthropic models
		if (data.anthropic?.models) {
			for (const [modelId, model] of Object.entries(data.anthropic.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Google models
		if (data.google?.models) {
			for (const [modelId, model] of Object.entries(data.google.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "google-generative-ai",
					provider: "google",
					baseUrl: "https://generativelanguage.googleapis.com/v1beta",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process OpenAI models
		if (data.openai?.models) {
			for (const [modelId, model] of Object.entries(data.openai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Groq models
		if (data.groq?.models) {
			for (const [modelId, model] of Object.entries(data.groq.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "groq",
					baseUrl: "https://api.groq.com/openai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Cerebras models
		if (data.cerebras?.models) {
			for (const [modelId, model] of Object.entries(data.cerebras.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cerebras",
					baseUrl: "https://api.cerebras.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process xAi models
		if (data.xai?.models) {
			for (const [modelId, model] of Object.entries(data.xai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "xai",
					baseUrl: "https://api.x.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process xAi models
		if (data.zai?.models) {
			for (const [modelId, model] of Object.entries(data.zai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "anthropic-messages",
					provider: "zai",
					baseUrl: "https://api.z.ai/api/anthropic",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Mistral models
		if (data.mistral?.models) {
			for (const [modelId, model] of Object.entries(data.mistral.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "mistral",
					baseUrl: "https://api.mistral.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		console.log(`Loaded ${models.length} tool-capable models from models.dev`);
		return models;
	} catch (error) {
		console.error("Failed to load models.dev data:", error);
		return [];
	}
}

async function generateModels() {
	// Fetch models from both sources
	// models.dev: Anthropic, Google, OpenAI, Groq, Cerebras
	// OpenRouter: xAI and other providers (excluding Anthropic, Google, OpenAI)
	const modelsDevModels = await loadModelsDevData();
	const openRouterModels = await fetchOpenRouterModels();

	// Combine models (models.dev has priority)
	const allModels = [...modelsDevModels, ...openRouterModels];

	// Fix incorrect cache pricing for Claude Opus 4.5 from models.dev
	// models.dev has 3x the correct pricing (1.5/18.75 instead of 0.5/6.25)
	const opus45 = allModels.find(m => m.provider === "anthropic" && m.id === "claude-opus-4-5");
	if (opus45) {
		opus45.cost.cacheRead = 0.5;
		opus45.cost.cacheWrite = 6.25;
	}

	// Add missing gpt models
	if (!allModels.some(m => m.provider === "openai" && m.id === "gpt-5-chat-latest")) {
		allModels.push({
			id: "gpt-5-chat-latest",
			name: "GPT-5 Chat Latest",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 16384,
		});
	}

	if (!allModels.some(m => m.provider === "openai" && m.id === "gpt-5.1-codex")) {
		allModels.push({
			id: "gpt-5.1-codex",
			name: "GPT-5.1 Codex",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 5,
				cacheRead: 0.125,
				cacheWrite: 1.25,
			},
			contextWindow: 400000,
			maxTokens: 128000,
		});
	}

	// Add missing Grok models
	if (!allModels.some(m => m.provider === "xai" && m.id === "grok-code-fast-1")) {
		allModels.push({
			id: "grok-code-fast-1",
			name: "Grok Code Fast 1",
			api: "openai-completions",
			baseUrl: "https://api.x.ai/v1",
			provider: "xai",
			reasoning: false,
			input: ["text"],
			cost: {
				input: 0.2,
				output: 1.5,
				cacheRead: 0.02,
				cacheWrite: 0,
			},
			contextWindow: 32768,
			maxTokens: 8192,
		});
	}

	// Add missing OpenRouter model
	if (!allModels.some(m => m.provider === "openrouter" && m.id === "openrouter/auto")) {
		allModels.push({
			id: "openrouter/auto",
			name: "OpenRouter: Auto Router",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				// we dont know about the costs because OpenRouter auto routes to different models
				// and then charges you for the underlying used model
				input:0,
				output:0,
				cacheRead:0,
				cacheWrite:0,
			},
			contextWindow: 2000000,
			maxTokens: 30000,
		});
	}

	// Moonshot (Kimi) models (direct API)
	// Docs: https://platform.moonshot.ai/ (OpenAI-compatible base URL: https://api.moonshot.ai/v1)
	// NOTE: We currently support image inputs, not video inputs.
	if (!allModels.some((m) => m.provider === "moonshot" && m.id === "kimi-k2.5")) {
		allModels.push({
			id: "kimi-k2.5",
			name: "Kimi K2.5 (Moonshot)",
			api: "openai-completions",
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			// Moonshot exposes reasoning via `reasoning_content` and expects it preserved in follow-up turns.
			reasoning: true,
			reasoningFormat: "reasoning_content",
			input: ["text", "image"],
			// Pricing from Moonshot docs (k2.5): input cache-hit $0.10/M, cache-miss $0.60/M, output $3.00/M.
			// We model this as: input=cache-miss, cacheRead=cache-hit, cacheWrite unknown.
			cost: {
				input: 0.6,
				output: 3.0,
				cacheRead: 0.1,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 32768,
			extraBody: {
				// Explicitly enable thinking (default is enabled, but be explicit).
				thinking: { type: "enabled" },
				// Moonshot docs indicate k2.5 uses fixed values; sending anything else can error.
				temperature: 1.0,
				top_p: 0.95,
				n: 1,
				presence_penalty: 0.0,
				frequency_penalty: 0.0,
			},
		});
	}

	// Google Cloud Code Assist models (Gemini CLI)
	// Uses production endpoint, standard Gemini models only
	const CLOUD_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
	const cloudCodeAssistModels: Model<"google-gemini-cli">[] = [
		{
			id: "gemini-2.5-pro",
			name: "Gemini 2.5 Pro (Cloud Code Assist)",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: CLOUD_CODE_ASSIST_ENDPOINT,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		},
		{
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash (Cloud Code Assist)",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: CLOUD_CODE_ASSIST_ENDPOINT,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		},
		{
			id: "gemini-2.0-flash",
			name: "Gemini 2.0 Flash (Cloud Code Assist)",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: CLOUD_CODE_ASSIST_ENDPOINT,
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 8192,
		},
		{
			id: "gemini-3-pro-preview",
			name: "Gemini 3 Pro Preview (Cloud Code Assist)",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: CLOUD_CODE_ASSIST_ENDPOINT,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		},
		{
			id: "gemini-3-flash-preview",
			name: "Gemini 3 Flash Preview (Cloud Code Assist)",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: CLOUD_CODE_ASSIST_ENDPOINT,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		},
		{
			id: "gemini-3.1-pro-preview",
			name: "Gemini 3.1 Pro Preview (Cloud Code Assist)",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: CLOUD_CODE_ASSIST_ENDPOINT,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		},
	];
	allModels.push(...cloudCodeAssistModels);

	// Antigravity models (Gemini 3, Claude, GPT-OSS via Google Cloud)
	// Uses sandbox endpoint and different OAuth credentials for access to additional models
	const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
	const antigravityModels: Model<"google-gemini-cli">[] = [
		{
			id: "gemini-3-pro-high",
			name: "Gemini 3 Pro High (Antigravity)",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: ANTIGRAVITY_ENDPOINT,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		},
		{
			id: "gemini-3-pro-low",
			name: "Gemini 3 Pro Low (Antigravity)",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: ANTIGRAVITY_ENDPOINT,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		},
		{
			id: "gemini-3-flash",
			name: "Gemini 3 Flash (Antigravity)",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: ANTIGRAVITY_ENDPOINT,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		},
		{
			id: "gemini-3.5-flash",
			name: "Gemini 3.5 Flash (Antigravity)",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: ANTIGRAVITY_ENDPOINT,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65535,
		},
		{
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5 (Antigravity)",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: ANTIGRAVITY_ENDPOINT,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		},
		{
			id: "gpt-oss-120b",
			name: "GPT-OSS 120B (Antigravity)",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: ANTIGRAVITY_ENDPOINT,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 16384,
		},
	];
	allModels.push(...antigravityModels);

	// OpenAI Codex (ChatGPT OAuth) models
	// NOTE: These use OAuth authentication, not API keys.
	// Users must /login with openai-codex provider to use these models.
	// Context window is based on observed server limits (400s above ~272k), not marketing numbers.
	const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
	const CODEX_CONTEXT = 272000;
	const CODEX_MAX_TOKENS = 128000;
	const codexModels: Model<"openai-codex-responses">[] = [
		{
			id: "gpt-5.1",
			name: "GPT-5.1 (ChatGPT Sub)",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // Included with subscription
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.1-codex-max",
			name: "GPT-5.1 Codex Max (ChatGPT Sub)",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.1-codex-mini",
			name: "GPT-5.1 Codex Mini (ChatGPT Sub)",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.2",
			name: "GPT-5.2 (ChatGPT Sub)",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.2-codex",
			name: "GPT-5.2 Codex (ChatGPT Sub)",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.3-codex",
			name: "GPT-5.3 Codex (ChatGPT Sub)",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark (ChatGPT Sub)",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 64000,
		},
	];
	allModels.push(...codexModels);

	// Synthetic (synthetic.new) models
	// Docs: https://dev.synthetic.new/docs/openai/chat-completions
	// Uses OpenAI-compatible API with model IDs prefixed with "hf:"
	const syntheticModels: Model<"openai-completions">[] = [
		{
			id: "hf:deepseek-ai/DeepSeek-V3-0324",
			name: "DeepSeek V3 0324 (Synthetic)",
			api: "openai-completions",
			provider: "synthetic",
			baseUrl: "https://api.synthetic.new/openai/v1",
			reasoning: true,
			reasoningFormat: "reasoning_content",
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 64000,
			maxTokens: 8192,
		},
		{
			id: "hf:deepseek-ai/DeepSeek-R1",
			name: "DeepSeek R1 (Synthetic)",
			api: "openai-completions",
			provider: "synthetic",
			baseUrl: "https://api.synthetic.new/openai/v1",
			reasoning: true,
			reasoningFormat: "reasoning_content",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 64000,
			maxTokens: 8192,
		},
	];
	allModels.push(...syntheticModels);

	// Group by provider and deduplicate by model ID
	const providers: Record<string, Record<string, Model<any>>> = {};
	for (const model of allModels) {
		if (!providers[model.provider]) {
			providers[model.provider] = {};
		}
		// Use model ID as key to automatically deduplicate
		// Only add if not already present (models.dev takes priority over OpenRouter)
		if (!providers[model.provider][model.id]) {
			providers[model.provider][model.id] = model;
		}
	}

	// Generate TypeScript file
	let output = `// This file is auto-generated by scripts/generate-models.ts
// Do not edit manually - run 'npm run generate-models' to update

import type { Model } from "./types.js";

export const MODELS = {
`;

	// Generate provider sections
	for (const [providerId, models] of Object.entries(providers)) {
		output += `\t"${providerId}": {\n`;

		for (const model of Object.values(models)) {
			output += `\t\t"${model.id}": {\n`;
			output += `\t\t\tid: "${model.id}",\n`;
			output += `\t\t\tname: "${model.name}",\n`;
			output += `\t\t\tapi: "${model.api}",\n`;
			output += `\t\t\tprovider: "${model.provider}",\n`;
			if (model.baseUrl) {
				output += `\t\t\tbaseUrl: "${model.baseUrl}",\n`;
			}
			output += `\t\t\treasoning: ${model.reasoning},\n`;
			if (model.reasoningFormat) {
				output += `\t\t\treasoningFormat: "${model.reasoningFormat}",\n`;
			}
			output += `\t\t\tinput: [${model.input.map(i => `"${i}"`).join(", ")}],\n`;
			output += `\t\t\tcost: {\n`;
			output += `\t\t\t\tinput: ${model.cost.input},\n`;
			output += `\t\t\t\toutput: ${model.cost.output},\n`;
			output += `\t\t\t\tcacheRead: ${model.cost.cacheRead},\n`;
			output += `\t\t\t\tcacheWrite: ${model.cost.cacheWrite},\n`;
			output += `\t\t\t},\n`;
			output += `\t\t\tcontextWindow: ${model.contextWindow},\n`;
			output += `\t\t\tmaxTokens: ${model.maxTokens},\n`;
			if (model.headers) {
				const headersJson = JSON.stringify(model.headers, null, 2);
				output += `\t\t\theaders: ${headersJson.replace(/\n/g, "\n\t\t\t")},\n`;
			}
			if (model.extraBody) {
				const extraBodyJson = JSON.stringify(model.extraBody, null, 2);
				output += `\t\t\textraBody: ${extraBodyJson.replace(/\n/g, "\n\t\t\t")},\n`;
			}
			output += `\t\t} satisfies Model<"${model.api}">,\n`;
		}

		output += `\t},\n`;
	}

	output += `} as const;
`;

	// Write file
	writeFileSync(join(packageRoot, "src/models.generated.ts"), output);
	console.log("Generated src/models.generated.ts");

	// Print statistics
	const totalModels = allModels.length;
	const reasoningModels = allModels.filter(m => m.reasoning).length;

	console.log(`\nModel Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(providers)) {
		console.log(`  ${provider}: ${Object.keys(models).length} models`);
	}
}

// Run the generator
generateModels().catch(console.error);
