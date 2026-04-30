/**
 * LM Studio Provider Extension
 *
 * Registers an "lmstudio" provider against a local LM Studio server using the
 * OpenAI-completions wire protocol. The model list is fetched from
 * `{baseUrl}/models` at startup inside an async extension factory, so
 * registered models are available to `pi --list-models` and to interactive
 * startup.
 *
 * LM Studio's OpenAI-compatible server does not understand the "developer"
 * role used by reasoning models, and ignores the `reasoning_effort` parameter,
 * so this extension sets `compat.supportsDeveloperRole: false` and
 * `compat.supportsReasoningEffort: false` at the provider level.
 *
 * Defaults:
 *   baseUrl: http://localhost:1234/v1   (override with LMSTUDIO_BASE_URL)
 *
 * Usage:
 *   pi -e ./packages/coding-agent/examples/extensions/custom-provider-lmstudio
 *   # or auto-discovery: copy the directory under ~/.pi/agent/extensions/
 *
 * Then `/model lmstudio/<id>` to use a discovered model.
 *
 * Tracks: https://github.com/badlogic/pi-mono/issues/3357
 */

import type { ExtensionAPI, ProviderModelConfig } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

const PROVIDER_NAME = "lmstudio";
const DEFAULT_BASE_URL = "http://localhost:1234/v1";
const PROBE_TIMEOUT_MS = 2000;
const FALLBACK_CONTEXT_WINDOW = 32768;
const FALLBACK_MAX_TOKENS = 4096;

// Curated table of nominal context windows and reasoning capability for models
// LM Studio commonly serves. LM Studio reports loaded-context (`loaded_context_length`)
// and `max_context_length` in its enriched /api/v0/models response, but the
// OpenAI-shaped /v1/models endpoint omits them, so we keep this static table as
// the fallback.
const KNOWN_MODELS: Array<{ match: string; contextWindow: number; maxTokens: number; reasoning?: boolean }> = [
	{ match: "qwen2.5-coder-32b", contextWindow: 131072, maxTokens: 8192 },
	{ match: "qwen2.5-coder", contextWindow: 32768, maxTokens: 8192 },
	{ match: "qwen3-coder", contextWindow: 262144, maxTokens: 16384, reasoning: true },
	{ match: "qwen3", contextWindow: 131072, maxTokens: 16384, reasoning: true },
	{ match: "gpt-oss-120b", contextWindow: 131072, maxTokens: 16384, reasoning: true },
	{ match: "gpt-oss-20b", contextWindow: 131072, maxTokens: 16384, reasoning: true },
	{ match: "gpt-oss", contextWindow: 131072, maxTokens: 16384, reasoning: true },
	{ match: "glm-4.6", contextWindow: 200000, maxTokens: 16384, reasoning: true },
	{ match: "glm-4.5", contextWindow: 131072, maxTokens: 16384, reasoning: true },
	{ match: "glm-4", contextWindow: 131072, maxTokens: 8192, reasoning: true },
	{ match: "deepseek-r1", contextWindow: 131072, maxTokens: 16384, reasoning: true },
	{ match: "deepseek-coder-v2", contextWindow: 131072, maxTokens: 8192 },
	{ match: "llama-3.3", contextWindow: 131072, maxTokens: 8192 },
	{ match: "llama-3.2", contextWindow: 131072, maxTokens: 8192 },
	{ match: "llama-3.1", contextWindow: 131072, maxTokens: 8192 },
	{ match: "llama-3", contextWindow: 8192, maxTokens: 4096 },
	{ match: "mistral-small", contextWindow: 32768, maxTokens: 8192 },
	{ match: "mistral", contextWindow: 32768, maxTokens: 8192 },
	{ match: "codestral", contextWindow: 32768, maxTokens: 8192 },
	{ match: "phi-4", contextWindow: 16384, maxTokens: 4096 },
	{ match: "gemma-3", contextWindow: 131072, maxTokens: 8192 },
];

// =============================================================================
// Types
// =============================================================================

interface OpenAIModelEntry {
	id: string;
	object?: string;
	owned_by?: string;
}

interface OpenAIModelsResponse {
	object?: string;
	data?: OpenAIModelEntry[];
}

// LM Studio's enriched native endpoint at /api/v0/models. We try this first
// for a richer description of each model and fall back to /v1/models on any
// failure.
interface LMStudioNativeModelEntry {
	id: string;
	type?: string;
	state?: "loaded" | "not-loaded" | string;
	max_context_length?: number;
	loaded_context_length?: number;
	capabilities?: string[];
}

interface LMStudioNativeModelsResponse {
	object?: string;
	data?: LMStudioNativeModelEntry[];
}

interface NormalizedEntry {
	id: string;
	contextWindow?: number;
	reasoning?: boolean;
	supportsImages?: boolean;
}

type ProbeResult = { ok: true; entries: NormalizedEntry[] } | { ok: false; reason: string };

// =============================================================================
// Helpers
// =============================================================================

function resolveBaseUrl(): string {
	const fromEnv = process.env.LMSTUDIO_BASE_URL?.trim();
	if (fromEnv) return fromEnv.replace(/\/+$/, "");
	return DEFAULT_BASE_URL;
}

function deriveNativeBase(baseUrl: string): string {
	// /v1 is the OpenAI-shaped path; /api/v0 is LM Studio's enriched one.
	if (baseUrl.endsWith("/v1")) return `${baseUrl.slice(0, -3)}/api/v0`;
	return `${baseUrl.replace(/\/+$/, "")}/api/v0`;
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

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: { Accept: "application/json" },
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function probeModels(baseUrl: string): Promise<ProbeResult> {
	const native = await fetchJson<LMStudioNativeModelsResponse>(
		`${deriveNativeBase(baseUrl)}/models`,
		PROBE_TIMEOUT_MS,
	);
	if (native && Array.isArray(native.data)) {
		const entries: NormalizedEntry[] = [];
		for (const m of native.data) {
			if (typeof m?.id !== "string") continue;
			if (m.type && m.type !== "llm" && m.type !== "vlm") continue;
			const supportsImages = m.type === "vlm" || m.capabilities?.includes("vision");
			const reasoning = m.capabilities?.includes("reasoning") || m.capabilities?.includes("tool_use_thinking");
			entries.push({
				id: m.id,
				contextWindow: m.max_context_length ?? m.loaded_context_length,
				reasoning,
				supportsImages,
			});
		}
		return { ok: true, entries };
	}

	// Fall back to plain OpenAI shape.
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
		const entries = data.filter((m): m is OpenAIModelEntry => typeof m?.id === "string").map((m) => ({ id: m.id }));
		return { ok: true, entries };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: `${baseUrl} unreachable: ${message}` };
	} finally {
		clearTimeout(timer);
	}
}

function buildModel(entry: NormalizedEntry): ProviderModelConfig {
	const known = lookupKnownModel(entry.id);
	const contextWindow =
		typeof entry.contextWindow === "number" && entry.contextWindow > 0 ? entry.contextWindow : known.contextWindow;
	const reasoning = typeof entry.reasoning === "boolean" ? entry.reasoning : known.reasoning;
	const input: ("text" | "image")[] = entry.supportsImages ? ["text", "image"] : ["text"];
	return {
		id: entry.id,
		name: entry.id,
		reasoning,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: known.maxTokens,
		// Provider-level compat flags below already cover this model; declaring
		// them per-model would only matter if the user set them differently in
		// `~/.pi/agent/models.json`.
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
		models: models.map((m) => ({
			...m,
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				...m.compat,
			},
		})),
	});

	if (!probe.ok) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(`lmstudio: ${probe.reason}. Start LM Studio's local server and run /reload.`, "warning");
		});
		return;
	}

	if (probe.entries.length === 0) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(
				`lmstudio: ${baseUrl} responded but reported no models. Load a model in LM Studio and /reload.`,
				"warning",
			);
		});
	}
}
