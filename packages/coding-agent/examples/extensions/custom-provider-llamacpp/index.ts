/**
 * llama.cpp Provider Extension
 *
 * Registers a "llamacpp" provider against a local llama.cpp server
 * (`./llama-server` from the llama.cpp project) using the OpenAI-completions
 * wire protocol. The model list is fetched from `{baseUrl}/models` at startup
 * inside an async extension factory, so registered models are available to
 * `pi --list-models` and to interactive startup.
 *
 * Defaults:
 *   baseUrl: http://localhost:8080/v1   (override with LLAMACPP_BASE_URL)
 *
 * Usage:
 *   pi -e ./packages/coding-agent/examples/extensions/custom-provider-llamacpp
 *   # or auto-discovery: copy the directory under ~/.pi/agent/extensions/
 *
 * Then `/model llamacpp/<id>` to use a discovered model.
 *
 * Tracks: https://github.com/badlogic/pi-mono/issues/3357
 */

import type { ExtensionAPI, ProviderModelConfig } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

const PROVIDER_NAME = "llamacpp";
const DEFAULT_BASE_URL = "http://localhost:8080/v1";
const PROBE_TIMEOUT_MS = 2000;
const FALLBACK_CONTEXT_WINDOW = 32768;
const FALLBACK_MAX_TOKENS = 4096;

// Curated table of context-window/max-tokens defaults for popular models
// llama.cpp commonly serves. Keys are matched as case-insensitive substrings of
// the served model id, longest match wins. Values reflect the model's nominal
// limits, not what llama.cpp may have been started with (controlled by
// `--ctx-size` / `-c`); users should override via `~/.pi/agent/models.json` if
// they ran llama-server with a smaller context.
const KNOWN_MODELS: Array<{ match: string; contextWindow: number; maxTokens: number; reasoning?: boolean }> = [
	{ match: "qwen2.5-coder-32b", contextWindow: 131072, maxTokens: 8192 },
	{ match: "qwen2.5-coder-14b", contextWindow: 131072, maxTokens: 8192 },
	{ match: "qwen2.5-coder-7b", contextWindow: 131072, maxTokens: 8192 },
	{ match: "qwen2.5-coder", contextWindow: 32768, maxTokens: 8192 },
	{ match: "qwen3-coder", contextWindow: 262144, maxTokens: 16384, reasoning: true },
	{ match: "qwen3", contextWindow: 131072, maxTokens: 16384, reasoning: true },
	{ match: "gpt-oss-120b", contextWindow: 131072, maxTokens: 16384, reasoning: true },
	{ match: "gpt-oss-20b", contextWindow: 131072, maxTokens: 16384, reasoning: true },
	{ match: "gpt-oss", contextWindow: 131072, maxTokens: 16384, reasoning: true },
	{ match: "glm-4.6", contextWindow: 200000, maxTokens: 16384, reasoning: true },
	{ match: "glm-4.5", contextWindow: 131072, maxTokens: 16384, reasoning: true },
	{ match: "glm-4", contextWindow: 131072, maxTokens: 8192, reasoning: true },
	{ match: "deepseek-v3", contextWindow: 131072, maxTokens: 8192 },
	{ match: "deepseek-r1", contextWindow: 131072, maxTokens: 16384, reasoning: true },
	{ match: "deepseek-coder-v2", contextWindow: 131072, maxTokens: 8192 },
	{ match: "llama-3.3", contextWindow: 131072, maxTokens: 8192 },
	{ match: "llama-3.2", contextWindow: 131072, maxTokens: 8192 },
	{ match: "llama-3.1", contextWindow: 131072, maxTokens: 8192 },
	{ match: "llama-3", contextWindow: 8192, maxTokens: 4096 },
	{ match: "mistral-large", contextWindow: 131072, maxTokens: 8192 },
	{ match: "mistral-small", contextWindow: 32768, maxTokens: 8192 },
	{ match: "mistral", contextWindow: 32768, maxTokens: 8192 },
	{ match: "codestral", contextWindow: 32768, maxTokens: 8192 },
	{ match: "phi-4", contextWindow: 16384, maxTokens: 4096 },
	{ match: "gemma-3", contextWindow: 131072, maxTokens: 8192 },
	{ match: "gemma-2", contextWindow: 8192, maxTokens: 4096 },
];

// =============================================================================
// Types
// =============================================================================

interface OpenAIModelEntry {
	id: string;
	object?: string;
	owned_by?: string;
	context_length?: number;
}

interface OpenAIModelsResponse {
	object?: string;
	data?: OpenAIModelEntry[];
}

type ProbeResult = { ok: true; entries: OpenAIModelEntry[] } | { ok: false; reason: string };

// =============================================================================
// Helpers
// =============================================================================

function resolveBaseUrl(): string {
	const fromEnv = process.env.LLAMACPP_BASE_URL?.trim();
	if (fromEnv) return fromEnv.replace(/\/+$/, "");
	return DEFAULT_BASE_URL;
}

function lookupKnownModel(id: string): { contextWindow: number; maxTokens: number; reasoning: boolean } {
	const lower = id.toLowerCase();
	for (const entry of KNOWN_MODELS) {
		if (lower.includes(entry.match)) {
			return {
				contextWindow: entry.contextWindow,
				maxTokens: entry.maxTokens,
				reasoning: entry.reasoning ?? false,
			};
		}
	}
	return {
		contextWindow: FALLBACK_CONTEXT_WINDOW,
		maxTokens: FALLBACK_MAX_TOKENS,
		reasoning: false,
	};
}

async function probeModels(baseUrl: string): Promise<ProbeResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(`${baseUrl}/models`, {
			signal: controller.signal,
			headers: { Accept: "application/json" },
		});
		if (!response.ok) {
			return { ok: false, reason: `HTTP ${response.status} ${response.statusText} from ${baseUrl}/models` };
		}
		const payload = (await response.json()) as OpenAIModelsResponse;
		const data = Array.isArray(payload.data) ? payload.data : [];
		return { ok: true, entries: data.filter((m): m is OpenAIModelEntry => typeof m?.id === "string") };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: `${baseUrl} unreachable: ${message}` };
	} finally {
		clearTimeout(timer);
	}
}

function buildModel(entry: OpenAIModelEntry): ProviderModelConfig {
	const known = lookupKnownModel(entry.id);
	// llama-server does not include the effective context length in the
	// OpenAI-shaped /v1/models response. Honor any context_length the server
	// happens to expose, otherwise use the curated default for the family.
	const contextWindow =
		typeof entry.context_length === "number" && entry.context_length > 0 ? entry.context_length : known.contextWindow;
	return {
		id: entry.id,
		name: entry.id,
		reasoning: known.reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: known.maxTokens,
	};
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
	const baseUrl = resolveBaseUrl();
	const probe = await probeModels(baseUrl);

	const models: ProviderModelConfig[] = probe.ok ? probe.entries.map(buildModel) : [];

	pi.registerProvider(PROVIDER_NAME, {
		baseUrl,
		apiKey: "none",
		api: "openai-completions",
		models,
	});

	if (!probe.ok) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(`llamacpp: ${probe.reason}. Start llama-server and run /reload.`, "warning");
		});
		return;
	}

	if (probe.entries.length === 0) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(
				`llamacpp: ${baseUrl} responded but reported no models. Load a model with llama-server and /reload.`,
				"warning",
			);
		});
	}
}
