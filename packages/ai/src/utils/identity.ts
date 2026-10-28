import type { Models, MutableModels } from "../models.ts";
import { PI_AI_VERSION } from "./version.ts";

/**
 * The `User-Agent` sent to providers:
 * - `"detailed"`: `pi/<version> (<platform>; <runtime>/<runtime version>; <arch>)`, or `pi/<version> (browser)`
 *   outside Node.js and Bun.
 * - `"short"`: `pi`.
 * - `{ custom }`: the given value.
 */
export type UserAgentMode = "short" | "detailed" | { custom: string };

/** Who requests are attributed to. `getAttributionHeaders()` maps the fields to each provider's headers. */
export interface ClientAttribution {
	/** App name: OpenRouter app title, NVIDIA invoke origin (first letter upper-cased), OpenCode client. */
	name: string;
	/** App URL: OpenRouter `HTTP-Referer`, the app's identity in OpenRouter's rankings, grouped by origin. */
	url: string;
	/** App categories, e.g. `["cli-agent"]`: OpenRouter `X-OpenRouter-Categories`, comma-separated. */
	categories?: string[];
}

/** pi's attribution, used by pi-agent-core, pi-durable, and the coding agent. */
export const PI_ATTRIBUTION: ClientAttribution = { name: "pi", url: "https://pi.dev", categories: ["cli-agent"] };

/**
 * How pi-ai identifies the calling app to providers. Every field is optional; absent fields use pi-ai's defaults:
 * a detailed `User-Agent` with pi-ai's version and no attribution headers. Plain JSON, so it can be persisted.
 */
export interface ClientIdentity {
	/** Default: `"detailed"`. */
	userAgent?: UserAgentMode;
	/** Provider attribution headers. Absent or `null`: none; `null` also turns off attribution set by a merged identity. */
	attribution?: ClientAttribution | null;
	/** Version in the detailed `User-Agent`. Default: the pi-ai version. */
	version?: string;
}

/** The provider and endpoint a request goes to. */
export interface ClientIdentityTarget {
	readonly provider: string;
	readonly baseUrl: string;
}

const NVIDIA_NIM_HOST = "integrate.api.nvidia.com";
const OPENCODE_HOST = "opencode.ai";

/** Merge identities field by field; later sources win and undefined fields are skipped. */
export function mergeClientIdentity(...sources: (ClientIdentity | undefined)[]): ClientIdentity | undefined {
	let merged: ClientIdentity | undefined;
	for (const source of sources) {
		if (!source) continue;
		merged = { ...merged };
		if (source.userAgent !== undefined) merged.userAgent = source.userAgent;
		if (source.attribution !== undefined) merged.attribution = source.attribution;
		if (source.version !== undefined) merged.version = source.version;
	}
	return merged;
}

/** The version in the detailed `User-Agent`. */
export function getClientVersion(identity?: ClientIdentity): string {
	return identity?.version ?? PI_AI_VERSION;
}

function runtimeDescription(): string | undefined {
	if (typeof process === "undefined") return undefined;
	const versions = process.versions;
	if (versions?.bun) return `bun/${versions.bun}`;
	if (versions?.node) return `node/${process.version}`;
	return undefined;
}

/** The `User-Agent` value of an identity. */
export function formatUserAgent(identity?: ClientIdentity): string {
	const mode = identity?.userAgent ?? "detailed";
	if (typeof mode === "object") return mode.custom;
	if (mode === "short") return "pi";
	const product = `pi/${getClientVersion(identity)}`;
	const runtime = runtimeDescription();
	return runtime ? `${product} (${process.platform}; ${runtime}; ${process.arch})` : `${product} (browser)`;
}

function matchesHost(baseUrl: string, expectedHost: string): boolean {
	try {
		return new URL(baseUrl).hostname === expectedHost;
	} catch {
		return false;
	}
}

function isOpenRouter(target: ClientIdentityTarget): boolean {
	return target.provider === "openrouter" || target.baseUrl.includes("openrouter.ai");
}

function isNvidiaNim(target: ClientIdentityTarget): boolean {
	return target.provider === "nvidia" || matchesHost(target.baseUrl, NVIDIA_NIM_HOST);
}

function isOpenCode(target: ClientIdentityTarget): boolean {
	return (
		target.provider === "opencode" || target.provider === "opencode-go" || matchesHost(target.baseUrl, OPENCODE_HOST)
	);
}

/** Provider attribution headers of an identity for a request target. Empty when attribution is off. */
export function getAttributionHeaders(target: ClientIdentityTarget, identity?: ClientIdentity): Record<string, string> {
	const attribution = identity?.attribution;
	if (!attribution) return {};
	const { name, url, categories } = attribution;
	if (isOpenRouter(target)) {
		return {
			"HTTP-Referer": url,
			"X-OpenRouter-Title": name,
			...(categories === undefined || categories.length === 0
				? {}
				: { "X-OpenRouter-Categories": categories.join(",") }),
		};
	}
	// NVIDIA expects a capitalized origin, such as `Pi`.
	if (isNvidiaNim(target)) return { "X-BILLING-INVOKE-ORIGIN": name.charAt(0).toUpperCase() + name.slice(1) };
	if (isOpenCode(target)) return { "x-opencode-client": name };
	return {};
}

/**
 * OpenCode's per-conversation routing header for requests to OpenCode, including custom providers pointing at it.
 * Undefined without a session or for other targets.
 */
export function getOpenCodeSessionHeaders(
	target: ClientIdentityTarget,
	sessionId: string | undefined,
): Record<string, string> | undefined {
	return sessionId && isOpenCode(target) ? { "x-opencode-session": sessionId } : undefined;
}

/**
 * Default headers an identity adds to a request: `User-Agent` and provider attribution. APIs apply them below model,
 * provider, and request headers, so configured headers override them and `null` request headers remove them.
 */
export function getIdentityHeaders(target: ClientIdentityTarget, identity?: ClientIdentity): Record<string, string> {
	return { "User-Agent": formatUserAgent(identity), ...getAttributionHeaders(target, identity) };
}

function isMutableModels(models: Models): models is MutableModels {
	return "setProvider" in models && "deleteProvider" in models && "clearProviders" in models;
}

/**
 * `models` with `identity` as the default identity of its requests: a request's `identity` overrides it field by
 * field, and it overrides the identity `models` was created with. Everything else is delegated unchanged; a
 * `MutableModels` stays mutable.
 */
export function withClientIdentity(models: MutableModels, identity: ClientIdentity): MutableModels;
export function withClientIdentity(models: Models, identity: ClientIdentity): Models;
export function withClientIdentity(models: Models, identity: ClientIdentity): Models {
	const withIdentity = <T extends { identity?: ClientIdentity }>(options: T | undefined): T =>
		({ ...options, identity: mergeClientIdentity(identity, options?.identity) }) as T;
	const wrapped: Models = {
		getProviders: () => models.getProviders(),
		getProvider: (id) => models.getProvider(id),
		getModels: (provider) => models.getModels(provider),
		getModel: (provider, id) => models.getModel(provider, id),
		getModelsOfType: (type, provider) => models.getModelsOfType(type, provider),
		getModelOfType: (type, provider, id) => models.getModelOfType(type, provider, id),
		getAllModels: (provider) => models.getAllModels(provider),
		refresh: (options) => models.refresh(options),
		checkAuth: (providerId, options) => models.checkAuth(providerId, options),
		getAvailable: (providerId, options) => models.getAvailable(providerId, options),
		getAvailableOfType: (type, providerId, options) => models.getAvailableOfType(type, providerId, options),
		getAllAvailable: (providerId, options) => models.getAllAvailable(providerId, options),
		getAuth: models.getAuth.bind(models),
		login: (providerId, type, interaction, options) => models.login(providerId, type, interaction, options),
		logout: (providerId, options) => models.logout(providerId, options),
		stream: (model, context, options) => models.stream(model, context, withIdentity(options)),
		complete: (model, context, options) => models.complete(model, context, withIdentity(options)),
		streamSimple: (model, context, options) => models.streamSimple(model, context, withIdentity(options)),
		completeSimple: (model, context, options) => models.completeSimple(model, context, withIdentity(options)),
		streamDeferred: (model, handle, options) => models.streamDeferred(model, handle, withIdentity(options)),
		fetchDeferred: (model, handle, options) => models.fetchDeferred(model, handle, withIdentity(options)),
		cancelDeferred: (model, handle, options) => models.cancelDeferred(model, handle, withIdentity(options)),
		generateImages: (model, context, options) => models.generateImages(model, context, withIdentity(options)),
		classify: (model, context, options) => models.classify(model, context, withIdentity(options)),
	};
	if (!isMutableModels(models)) return wrapped;
	const mutable: MutableModels = {
		...wrapped,
		setProvider: (provider) => models.setProvider(provider),
		deleteProvider: (id) => models.deleteProvider(id),
		clearProviders: () => models.clearProviders(),
	};
	return mutable;
}
