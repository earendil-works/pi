import { stream, streamSimple } from "../api/ollama-chat.ts";
import { defaultProviderAuthContext } from "../auth/context.ts";
import type { ApiKeyCredential, AuthContext } from "../auth/types.ts";
import type { Provider } from "../models.ts";
import type { FetchFunction, Model } from "../types.ts";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_CONTEXT = 8192;

export function normalizeOllamaUrl(value: string): string {
	const url = new URL(value.includes("://") ? value.trim() : `http://${value.trim()}`);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error("Ollama URL must be an HTTP(S) server URL without credentials, query, or fragment");
	}
	url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:api|v1)$/, "");
	return url.toString().replace(/\/+$/, "");
}

export interface OllamaProviderOptions {
	/** Explicitly configure a server. Otherwise use stored OLLAMA_BASE_URL, OLLAMA_BASE_URL, or OLLAMA_HOST. */
	baseUrl?: string;
	fetch?: FetchFunction;
}

interface OllamaTag {
	name: string;
	digest: string;
}
interface OllamaShow {
	capabilities?: string[];
	remote_host?: string;
	parameters?: string;
	model_info?: Record<string, unknown>;
	details?: { family?: string };
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 1 ? value : undefined;
}

function toModel(tag: OllamaTag, info: OllamaShow, baseUrl: string): Model<"ollama-chat"> | undefined {
	if (info.remote_host || !info.capabilities?.includes("completion")) return undefined;
	const trained = Object.entries(info.model_info ?? {}).find(([key]) => key.endsWith(".context_length"))?.[1];
	const configured = Number(/(?:^|\n)num_ctx\s+(\d+)/.exec(info.parameters ?? "")?.[1]);
	const contextWindow = Math.min(
		positive(configured) ?? DEFAULT_OLLAMA_CONTEXT,
		positive(trained) ?? Number.MAX_SAFE_INTEGER,
	);
	const effort = info.details?.family === "gptoss";
	return {
		id: tag.name,
		name: tag.name,
		api: "ollama-chat",
		provider: "ollama",
		baseUrl,
		reasoning: info.capabilities.includes("thinking"),
		...(effort
			? { thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high" } }
			: {}),
		input: info.capabilities.includes("vision") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: Math.min(4096, Math.floor(contextWindow / 2)),
	};
}

/** Local Ollama catalog and native transport; importing this factory never probes a server. */
export function ollamaProvider(options: OllamaProviderOptions = {}): Provider<"ollama-chat"> {
	let models: readonly Model<"ollama-chat">[] = [];
	const defaultContext = defaultProviderAuthContext();
	const endpoint = async (ctx: AuthContext, credential?: ApiKeyCredential): Promise<string | undefined> => {
		const value =
			options.baseUrl ??
			credential?.env?.OLLAMA_BASE_URL ??
			(await ctx.env("OLLAMA_BASE_URL")) ??
			(await ctx.env("OLLAMA_HOST"));
		return value?.trim() ? normalizeOllamaUrl(value) : undefined;
	};
	const request = async <T>(
		baseUrl: string,
		path: string,
		signal: AbortSignal,
		key?: string,
		body?: unknown,
	): Promise<T> => {
		const response = await (options.fetch ?? fetch)(`${baseUrl}/api/${path}`, {
			method: body === undefined ? "GET" : "POST",
			signal,
			headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`Ollama ${path} ${response.status}: ${await response.text()}`);
		return (await response.json()) as T;
	};
	return {
		id: "ollama",
		name: "Ollama",
		baseUrl: options.baseUrl ? normalizeOllamaUrl(options.baseUrl) : DEFAULT_OLLAMA_URL,
		auth: {
			apiKey: {
				name: "Ollama server",
				login: async (interaction) => {
					const entered = await interaction.prompt({
						type: "text",
						message: "Ollama server URL",
						placeholder: DEFAULT_OLLAMA_URL,
					});
					const baseUrl = normalizeOllamaUrl(entered.trim() || DEFAULT_OLLAMA_URL);
					const key =
						(
							await interaction.prompt({
								type: "secret",
								message: "API key (optional; leave empty for local Ollama)",
							})
						).trim() || undefined;
					await request(baseUrl, "tags", AbortSignal.any([interaction.signal, AbortSignal.timeout(15_000)]), key);
					return { type: "api_key", key, env: { OLLAMA_BASE_URL: baseUrl } };
				},
				check: async ({ ctx, credential }) =>
					(await endpoint(ctx, credential)) ? { type: "api_key", source: "Ollama server" } : undefined,
				resolve: async ({ ctx, credential }) => {
					const baseUrl = await endpoint(ctx, credential);
					if (!baseUrl) return undefined;
					return {
						auth: { baseUrl, apiKey: credential?.key ?? (await ctx.env("OLLAMA_API_KEY")) },
						env: { ...credential?.env, OLLAMA_BASE_URL: baseUrl },
						source: "Ollama server",
					};
				},
			},
		},
		getModels: () => models,
		refreshModels: async (context) => {
			const credential = context.credential?.type === "api_key" ? context.credential : undefined;
			const baseUrl = await endpoint(context.authContext ?? defaultContext, credential);
			const restored = (context.stored?.models ?? models).filter(
				(model): model is Model<"ollama-chat"> =>
					model.provider === "ollama" && model.api === "ollama-chat" && model.baseUrl === baseUrl,
			);
			if (
				!(await context.publish({
					update: () => {
						models = restored;
					},
				}))
			)
				return;
			if (!baseUrl || !context.allowNetwork) return;
			const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]);
			const version = await request<{ version: string }>(baseUrl, "version", signal, credential?.key);
			const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version.version);
			if (!parts || (Number(parts[1]) === 0 && Number(parts[2]) < 20)) {
				throw new Error(
					"Native Ollama requires Ollama 0.20 or newer for explicit context overflow errors. Upgrade Ollama and refresh models.",
				);
			}
			const catalog = await request<{ models: OllamaTag[] }>(baseUrl, "tags", signal, credential?.key);
			if (!Array.isArray(catalog.models)) throw new Error("Invalid Ollama model catalog");
			const refreshed: Model<"ollama-chat">[] = [];
			// Bound discovery concurrency without loading any models into GPU memory.
			for (let index = 0; index < catalog.models.length; index += 4) {
				const batch = await Promise.all(
					catalog.models.slice(index, index + 4).map(async (tag) => {
						const info = await request<OllamaShow>(baseUrl, "show", signal, credential?.key, { model: tag.name });
						return toModel(tag, info, baseUrl);
					}),
				);
				for (const model of batch) if (model) refreshed.push(model);
			}
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					models = refreshed;
				},
			});
		},
		stream: (model, context, opts) => stream(model, context, { fetch: options.fetch, ...opts }),
		streamSimple: (model, context, opts) => streamSimple(model, context, { fetch: options.fetch, ...opts }),
	};
}
