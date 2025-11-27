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
		output += `\t${providerId}: {\n`;

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
			output += `\t\t\tinput: [${model.input.map(i => `"${i}"`).join(", ")}],\n`;
			output += `\t\t\tcost: {\n`;
			output += `\t\t\t\tinput: ${model.cost.input},\n`;
			output += `\t\t\t\toutput: ${model.cost.output},\n`;
			output += `\t\t\t\tcacheRead: ${model.cost.cacheRead},\n`;
			output += `\t\t\t\tcacheWrite: ${model.cost.cacheWrite},\n`;
			output += `\t\t\t},\n`;
			output += `\t\t\tcontextWindow: ${model.contextWindow},\n`;
			output += `\t\t\tmaxTokens: ${model.maxTokens},\n`;
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