/**
 * Ollama Provider Extension
 *
 * Registers an "ollama" provider against a local Ollama server. The model list
 * is fetched from Ollama's native `/api/tags` at startup inside an async
 * extension factory, so registered models are available to `pi --list-models`
 * and to interactive startup.
 *
 * Wire protocol:
 *   This v1 talks to Ollama's OpenAI-compatibility shim at `{baseUrl}/v1`,
 *   which is the same wire format used for llama.cpp / LM Studio / vLLM. Tool
 *   calling on the OpenAI shim is currently lossy for some Ollama models (see
 *   https://github.com/ollama/ollama/issues/12557 ); a native /api/chat
 *   adapter is the planned v2 — see TODO at the bottom of this file.
 *
 * Defaults:
 *   baseUrl: http://localhost:11434  (override with OLLAMA_BASE_URL)
 *
 * Usage:
 *   pi -e ./packages/coding-agent/examples/extensions/custom-provider-ollama
 *   # or auto-discovery: copy the directory under ~/.pi/agent/extensions/
 *
 * Then `/model ollama/<id>` to use a discovered model.
 *
 * Tracks: https://github.com/badlogic/pi-mono/issues/3357
 */

import type { ExtensionAPI, ProviderModelConfig } from "@mariozechner/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

const PROVIDER_NAME = "ollama";
const DEFAULT_BASE_URL = "http://localhost:11434";
const PROBE_TIMEOUT_MS = 2000;
const FALLBACK_CONTEXT_WINDOW = 32768;
const FALLBACK_MAX_TOKENS = 4096;

// Curated table of context-window/max-tokens defaults for popular Ollama
// model families. Ollama's `/api/tags` does not include `num_ctx` (that lives
// behind `/api/show`, which is more expensive to call per model), so we use
// this static table as the default and let users override it via
// `~/.pi/agent/models.json`.
//
// Keys are matched as case-insensitive substrings of the served model id
// (e.g. "qwen2.5-coder:7b"); longest match wins.
const KNOWN_MODELS: Array<{ match: string; contextWindow: number; maxTokens: number; reasoning?: boolean }> = [
	{ match: "qwen2.5-coder", contextWindow: 32768, maxTokens: 8192 },
	{ match: "qwen3-coder", contextWindow: 262144, maxTokens: 16384, reasoning: true },
	{ match: "qwen3", contextWindow: 131072, maxTokens: 16384, reasoning: true },
	{ match: "qwen2.5", contextWindow: 131072, maxTokens: 8192 },
	{ match: "gpt-oss", contextWindow: 131072, maxTokens: 16384, reasoning: true },
	{ match: "deepseek-r1", contextWindow: 131072, maxTokens: 16384, reasoning: true },
	{ match: "deepseek-coder-v2", contextWindow: 131072, maxTokens: 8192 },
	{ match: "deepseek-v3", contextWindow: 131072, maxTokens: 8192 },
	{ match: "llama3.3", contextWindow: 131072, maxTokens: 8192 },
	{ match: "llama3.2", contextWindow: 131072, maxTokens: 8192 },
	{ match: "llama3.1", contextWindow: 131072, maxTokens: 8192 },
	{ match: "llama3", contextWindow: 8192, maxTokens: 4096 },
	{ match: "mistral-small", contextWindow: 32768, maxTokens: 8192 },
	{ match: "mistral", contextWindow: 32768, maxTokens: 8192 },
	{ match: "codestral", contextWindow: 32768, maxTokens: 8192 },
	{ match: "phi4", contextWindow: 16384, maxTokens: 4096 },
	{ match: "gemma3", contextWindow: 131072, maxTokens: 8192 },
	{ match: "gemma2", contextWindow: 8192, maxTokens: 4096 },
];

// Ollama model families with native vision support. Used to flag image input
// when the served family matches.
const VISION_FAMILIES = [
	"llava",
	"llama3.2-vision",
	"qwen2-vl",
	"qwen3-vl",
	"minicpm-v",
	"moondream",
	"bakllava",
	"gemma3",
];

// =============================================================================
// Types
// =============================================================================

interface OllamaTagModel {
	name: string;
	model?: string;
	size?: number;
	digest?: string;
	details?: {
		family?: string;
		families?: string[];
		parameter_size?: string;
		quantization_level?: string;
	};
}

interface OllamaTagsResponse {
	models?: OllamaTagModel[];
}

interface NormalizedEntry {
	id: string;
	families: string[];
}

type ProbeResult = { ok: true; entries: NormalizedEntry[] } | { ok: false; reason: string };

// =============================================================================
// Helpers
// =============================================================================

function resolveBaseUrl(): string {
	const fromEnv = process.env.OLLAMA_BASE_URL?.trim();
	if (fromEnv) return fromEnv.replace(/\/+$/, "");
	return DEFAULT_BASE_URL;
}

function lookupKnown(id: string): { contextWindow: number; maxTokens: number; reasoning: boolean } {
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

function isVisionModel(id: string, families: string[]): boolean {
	const lower = id.toLowerCase();
	if (VISION_FAMILIES.some((f) => lower.includes(f))) return true;
	return families.some((f) => VISION_FAMILIES.includes(f.toLowerCase()));
}

async function probeModels(baseUrl: string): Promise<ProbeResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(`${baseUrl}/api/tags`, {
			signal: controller.signal,
			headers: { Accept: "application/json" },
		});
		if (!response.ok) {
			return { ok: false, reason: `HTTP ${response.status} ${response.statusText} from ${baseUrl}/api/tags` };
		}
		const payload = (await response.json()) as OllamaTagsResponse;
		const data = Array.isArray(payload.models) ? payload.models : [];
		const entries: NormalizedEntry[] = [];
		for (const m of data) {
			if (typeof m?.name !== "string") continue;
			const families = m.details?.families ?? (m.details?.family ? [m.details.family] : []);
			entries.push({ id: m.name, families });
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
	const input: ("text" | "image")[] = isVisionModel(entry.id, entry.families) ? ["text", "image"] : ["text"];
	return {
		id: entry.id,
		name: entry.id,
		reasoning: known.reasoning,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: known.contextWindow,
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

	// Ollama's OpenAI shim lives at `{baseUrl}/v1`. The shim ignores Authorization
	// when configured without auth, so we send the literal "none" as a placeholder.
	pi.registerProvider(PROVIDER_NAME, {
		baseUrl: `${baseUrl}/v1`,
		apiKey: "none",
		api: "openai-completions",
		// Ollama does not understand OpenAI's "developer" role and ignores
		// reasoning_effort. Apply at the provider level.
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
			ctx.ui.notify(`ollama: ${probe.reason}. Start \`ollama serve\` and run /reload.`, "warning");
		});
		return;
	}

	if (probe.entries.length === 0) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(
				`ollama: ${baseUrl} reported no pulled models. Run \`ollama pull <model>\` and /reload.`,
				"warning",
			);
		});
	}
}

// =============================================================================
// TODO — v2: native /api/chat streamSimple
// =============================================================================
// Ollama's OpenAI-compat /v1/chat/completions shim is currently lossy for tool
// calls on some models (https://github.com/ollama/ollama/issues/12557). The
// next iteration of this extension should ship a native /api/chat adapter,
// modelled on packages/ai/src/providers/google.ts. @CaptCanadaMan published a
// working starting point at https://github.com/CaptCanadaMan/pi-ollama-native
// which can be folded in here behind a `streamSimple` provider option, with
// the OpenAI shim retained as a fallback when the user opts out.
