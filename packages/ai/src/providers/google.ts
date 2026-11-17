import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, isModelType, type Provider } from "../models.ts";
import type { Model, ThinkingLevelMap } from "../types.ts";
import { GOOGLE_MODELS } from "./google.models.ts";

const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GOOGLE_MODELS_TIMEOUT_MS = 15_000;
const GOOGLE_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const CATALOG_SCHEMA_VERSION = 1;
const GEMINI_LONG_DECODE_MAX_TOKENS = 131_072;
const DEFAULT_CONTEXT_WINDOW = 131_072;
const DEFAULT_MAX_TOKENS = 8_192;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Audio-only TTS, Lyria music, and image-only endpoints list generateContent in v1beta/models
// but require non-text response modalities instead of standard chat turns.
// TTS, transcribe, Lyria, image-only, and Interactions-API-only endpoints list generateContent
// in v1beta/models but reject or ignore standard chat generateContent requests.
const NON_CHAT_MODEL_ID =
	/(?:^|-)(?:tts|transcribe|image)(?:-|$)|^gemini-omni-|^antigravity-preview-|^lyria-|^nano-banana-|^imagen-/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function defaultGoogleMaxTokens(id: string): number {
	return /^gemini-(?:[4-9]|[1-9]\d)(?:-|$)/i.test(id) ? GEMINI_LONG_DECODE_MAX_TOKENS : 0;
}

function inferredThinkingLevelMap(id: string, reasoning: boolean): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	const lower = id.toLowerCase();
	if (/^gemini-(?:[4-9]|[1-9]\d)(?:-|$)/.test(lower)) {
		return {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: lower.includes("hydrogen") ? "xhigh" : null,
			max: null,
		};
	}
	if (/gemma-?4/.test(lower)) {
		return { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" };
	}
	if (/^gemini-3(?:\.\d+)?-pro/.test(lower)) {
		return { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	}
	if (/^gemini-3(?:\.\d+)?-flash/.test(lower)) {
		return { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	}
	return undefined;
}

async function catalogSourceKey(baseUrl: string, key: string): Promise<string> {
	const seed = JSON.stringify([CATALOG_SCHEMA_VERSION, baseUrl, key]);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
	return `google-v1beta:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function mergeGoogleModels(
	baseline: readonly Model<"google-generative-ai">[],
	incoming: readonly Model<"google-generative-ai">[],
	baseUrl: string,
): Model<"google-generative-ai">[] {
	const merged = new Map<string, Model<"google-generative-ai">>(
		baseline.map((model) => [model.id, { ...model, baseUrl }]),
	);
	const defaultInputLimits = baseline[0]?.inputLimits;
	for (const model of incoming) {
		if (NON_CHAT_MODEL_ID.test(model.id)) continue;
		const base = merged.get(model.id);
		if (base) {
			merged.set(model.id, {
				...base,
				baseUrl,
				name: model.name && model.name !== model.id ? model.name : base.name,
				reasoning: model.reasoning || base.reasoning,
				contextWindow: Math.max(base.contextWindow, model.contextWindow ?? 0),
				maxTokens: Math.max(base.maxTokens, model.maxTokens ?? 0, defaultGoogleMaxTokens(model.id)),
			});
		} else {
			const thinkingLevelMap = model.thinkingLevelMap ?? inferredThinkingLevelMap(model.id, model.reasoning);
			merged.set(model.id, {
				...model,
				api: "google-generative-ai",
				provider: "google",
				baseUrl,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				...(defaultInputLimits && !model.inputLimits ? { inputLimits: defaultInputLimits } : {}),
				maxTokens: Math.max(model.maxTokens ?? 0, defaultGoogleMaxTokens(model.id)) || DEFAULT_MAX_TOKENS,
			});
		}
	}
	return [...merged.values()];
}

function parseGoogleModelEntry(
	baseUrl: string,
	entry: Record<string, unknown>,
): Model<"google-generative-ai"> | undefined {
	const rawName = typeof entry.name === "string" ? entry.name.trim() : "";
	if (!rawName) return undefined;
	const methods = Array.isArray(entry.supportedGenerationMethods)
		? entry.supportedGenerationMethods.filter((m): m is string => typeof m === "string")
		: [];
	if (methods.length > 0 && !methods.includes("generateContent")) return undefined;
	const id = rawName.startsWith("models/") ? rawName.slice("models/".length) : rawName;
	if (!id || NON_CHAT_MODEL_ID.test(id)) return undefined;
	const displayName =
		typeof entry.displayName === "string" && entry.displayName.trim() ? entry.displayName.trim() : id;
	const reasoning = entry.thinking === true;
	const thinkingLevelMap = inferredThinkingLevelMap(id, reasoning);
	return {
		id,
		name: displayName,
		api: "google-generative-ai",
		provider: "google",
		baseUrl,
		reasoning,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: id.startsWith("gemini-") || /^gemma-?4/i.test(id) ? ["text", "image"] : ["text"],
		cost: { ...ZERO_COST },
		contextWindow: positiveNumber(entry.inputTokenLimit) ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: Math.max(positiveNumber(entry.outputTokenLimit) ?? DEFAULT_MAX_TOKENS, defaultGoogleMaxTokens(id)),
	};
}

async function fetchGoogleModels(
	baseUrl: string,
	key: string,
	signal: AbortSignal,
): Promise<Model<"google-generative-ai">[] | undefined> {
	const discovered: Model<"google-generative-ai">[] = [];
	const seen = new Set<string>();
	let pageToken: string | undefined;
	do {
		const url = new URL(`${baseUrl}/models`);
		url.searchParams.set("pageSize", "1000");
		if (pageToken) url.searchParams.set("pageToken", pageToken);
		const response = await fetch(url.toString(), {
			headers: { accept: "application/json", "x-goog-api-key": key },
			signal: AbortSignal.any([signal, AbortSignal.timeout(GOOGLE_MODELS_TIMEOUT_MS)]),
		});
		if (response.status === 401 || response.status === 403 || response.status === 404) return undefined;
		if (!response.ok) throw new Error(`Google model list request failed: ${response.status}`);
		const body: unknown = await response.json();
		if (!isRecord(body) || !Array.isArray(body.models)) {
			throw new Error("Invalid Google model list response");
		}
		for (const item of body.models) {
			if (!isRecord(item)) continue;
			const parsed = parseGoogleModelEntry(baseUrl, item);
			if (parsed && !seen.has(parsed.id)) {
				seen.add(parsed.id);
				discovered.push(parsed);
			}
		}
		pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
	} while (pageToken && !signal.aborted);
	return discovered;
}

export function googleProvider(): Provider<"google-generative-ai"> {
	const baseline = Object.values(GOOGLE_MODELS);
	let models: Model<"google-generative-ai">[] = [...baseline];
	const provider = createProvider({
		id: "google",
		name: "Google",
		baseUrl: GOOGLE_BASE_URL,
		auth: { apiKey: envApiKeyAuth("Gemini API key", ["GEMINI_API_KEY"]) },
		models,
		api: googleGenerativeAIApi(),
	});
	return {
		...provider,
		getModels: () => models,
		async refreshModels(context) {
			const baseUrl = (context.baseUrl ?? GOOGLE_BASE_URL).replace(/\/+$/, "");
			if (context.stored) {
				const restored = context.stored.models.filter(
					(model): model is Model<"google-generative-ai"> =>
						model.provider === "google" && isModelType(model, "chat") && model.api === "google-generative-ai",
				);
				if (restored.length > 0) {
					const next = mergeGoogleModels(baseline, restored, baseUrl);
					if (
						!(await context.publish({
							update: () => {
								models = next;
							},
						}))
					) {
						return;
					}
				}
			}
			const key = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
			if (!context.allowNetwork || !key || context.signal.aborted) return;
			const sourceKey = await catalogSourceKey(baseUrl, key);
			const sameSource = context.stored?.etag === sourceKey;
			const checkedAt = context.stored?.checkedAt ?? 0;
			const now = Date.now();
			if (
				!context.force &&
				sameSource &&
				checkedAt > 0 &&
				now >= checkedAt &&
				now - checkedAt < GOOGLE_REFRESH_INTERVAL_MS
			) {
				return;
			}
			const discovered = await fetchGoogleModels(baseUrl, key, context.signal);
			if (!discovered || discovered.length === 0) return;
			const next = mergeGoogleModels(baseline, discovered, baseUrl);
			await context.publish({
				persist: { models: next, checkedAt: Date.now(), etag: sourceKey },
				update: () => {
					models = next;
				},
			});
		},
	};
}
