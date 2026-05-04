/**
 * vLLM Provider Extension
 *
 * Registers a "vllm" provider against a local or remote vLLM server using the
 * OpenAI-completions wire protocol. The model list is fetched from
 * `{baseUrl}/models` at startup inside an async extension factory; per-model
 * `max_model_len` is read from the same endpoint when available, so registered
 * models reflect the effective context window of the running deployment.
 *
 * Defaults:
 *   baseUrl: http://localhost:8000/v1   (override with VLLM_BASE_URL)
 *   apiKey:  reads VLLM_API_KEY if set, otherwise sends "none"
 *
 * Usage:
 *   pi -e ./packages/coding-agent/examples/extensions/custom-provider-vllm
 *   # or auto-discovery: copy the directory under ~/.pi/agent/extensions/
 *
 * Then `/model vllm/<id>` to use a discovered model.
 *
 * This extension also pairs with `@mariozechner/pi-pods`, which provisions
 * vLLM with tool-call-friendly defaults on remote GPUs and emits an
 * OpenAI-compatible endpoint URL.
 *
 * Tracks: https://github.com/badlogic/pi-mono/issues/3357
 */

import type { ExtensionAPI, ProviderModelConfig } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

const PROVIDER_NAME = "vllm";
const DEFAULT_BASE_URL = "http://localhost:8000/v1";
const PROBE_TIMEOUT_MS = 3000;
const FALLBACK_CONTEXT_WINDOW = 32768;
const FALLBACK_MAX_TOKENS = 4096;

// Curated table of nominal max-tokens defaults and reasoning capability.
// vLLM exposes `max_model_len` per model, so we override the curated
// contextWindow when the server reports one. Keys are matched as
// case-insensitive substrings of the served model id.
const KNOWN_MODELS: Array<{ match: string; maxTokens: number; reasoning?: boolean; supportsImages?: boolean }> = [
	{ match: "qwen2.5-coder", maxTokens: 8192 },
	{ match: "qwen3-coder", maxTokens: 16384, reasoning: true },
	{ match: "qwen3-vl", maxTokens: 16384, reasoning: true, supportsImages: true },
	{ match: "qwen3", maxTokens: 16384, reasoning: true },
	{ match: "qwen2-vl", maxTokens: 8192, supportsImages: true },
	{ match: "gpt-oss", maxTokens: 16384, reasoning: true },
	{ match: "glm-4.6", maxTokens: 16384, reasoning: true },
	{ match: "glm-4.5", maxTokens: 16384, reasoning: true },
	{ match: "glm-4", maxTokens: 8192, reasoning: true },
	{ match: "deepseek-v3", maxTokens: 8192 },
	{ match: "deepseek-r1", maxTokens: 16384, reasoning: true },
	{ match: "deepseek-coder", maxTokens: 8192 },
	{ match: "llama-3.3", maxTokens: 8192 },
	{ match: "llama-3.2", maxTokens: 8192 },
	{ match: "llama-3.1", maxTokens: 8192 },
	{ match: "llama-3", maxTokens: 4096 },
	{ match: "mistral-large", maxTokens: 8192 },
	{ match: "mistral", maxTokens: 8192 },
	{ match: "codestral", maxTokens: 8192 },
	{ match: "phi-4", maxTokens: 4096 },
	{ match: "gemma-3", maxTokens: 8192 },
	{ match: "pixtral", maxTokens: 8192, supportsImages: true },
];

// =============================================================================
// Types
// =============================================================================

interface VllmModelEntry {
	id: string;
	object?: string;
	owned_by?: string;
	max_model_len?: number;
	parent?: string | null;
}

interface VllmModelsResponse {
	object?: string;
	data?: VllmModelEntry[];
}

interface NormalizedEntry {
	id: string;
	contextWindow?: number;
}

type ProbeResult = { ok: true; entries: NormalizedEntry[] } | { ok: false; reason: string };

// =============================================================================
// Helpers
// =============================================================================

function resolveBaseUrl(): string {
	const fromEnv = process.env.VLLM_BASE_URL?.trim();
	if (fromEnv) return fromEnv.replace(/\/+$/, "");
	return DEFAULT_BASE_URL;
}

function lookupKnown(id: string): { maxTokens: number; reasoning: boolean; supportsImages: boolean } {
	const lower = id.toLowerCase();
	for (const entry of KNOWN_MODELS) {
		if (lower.includes(entry.match)) {
			return {
				maxTokens: entry.maxTokens,
				reasoning: entry.reasoning ?? false,
				supportsImages: entry.supportsImages ?? false,
			};
		}
	}
	return { maxTokens: FALLBACK_MAX_TOKENS, reasoning: false, supportsImages: false };
}

async function probeModels(baseUrl: string, apiKey: string | undefined): Promise<ProbeResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	try {
		const response = await fetch(`${baseUrl}/models`, { signal: controller.signal, headers });
		if (!response.ok) {
			return { ok: false, reason: `HTTP ${response.status} ${response.statusText} from ${baseUrl}/models` };
		}
		const payload = (await response.json()) as VllmModelsResponse;
		const data = Array.isArray(payload.data) ? payload.data : [];
		const entries: NormalizedEntry[] = [];
		for (const m of data) {
			if (typeof m?.id !== "string") continue;
			// Skip LoRA adapters reported alongside the base model.
			if (m.parent) continue;
			entries.push({
				id: m.id,
				contextWindow: typeof m.max_model_len === "number" && m.max_model_len > 0 ? m.max_model_len : undefined,
			});
		}
		return { ok: true, entries };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: `${baseUrl} unreachable: ${message}` };
	} finally {
		clearTimeout(timer);
	}
}

function buildModel(entry: NormalizedEntry): ProviderModelConfig {
	const known = lookupKnown(entry.id);
	const contextWindow =
		typeof entry.contextWindow === "number" && entry.contextWindow > 0
			? entry.contextWindow
			: FALLBACK_CONTEXT_WINDOW;
	const input: ("text" | "image")[] = known.supportsImages ? ["text", "image"] : ["text"];
	return {
		id: entry.id,
		name: entry.id,
		reasoning: known.reasoning,
		input,
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
	const apiKeyValue = process.env.VLLM_API_KEY?.trim();
	const probe = await probeModels(baseUrl, apiKeyValue);

	const models: ProviderModelConfig[] = probe.ok ? probe.entries.map(buildModel) : [];

	pi.registerProvider(PROVIDER_NAME, {
		baseUrl,
		// vLLM accepts any non-empty bearer token (or none, depending on
		// --api-key). When the user sets VLLM_API_KEY we forward it; otherwise
		// we send the literal "none" since pi requires apiKey when registering
		// models.
		apiKey: apiKeyValue ? "VLLM_API_KEY" : "none",
		api: "openai-completions",
		authHeader: Boolean(apiKeyValue),
		models,
	});

	if (!probe.ok) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(`vllm: ${probe.reason}. Start vLLM (or fix VLLM_BASE_URL) and run /reload.`, "warning");
		});
		return;
	}

	if (probe.entries.length === 0) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(
				`vllm: ${baseUrl} responded but reported no models. Check the deployment and /reload.`,
				"warning",
			);
		});
	}
}
