// Adapted from pi-antigravity (MIT), Copyright (c) 2026 Rahul Arya.
// See LICENSE in this directory.
import type { ProviderEnv, ProviderRequestOptions } from "../../types.ts";
import { isSelectableRuntimeModelId } from "./grouping.ts";
import { assertSafeApiBaseUrl, safeError } from "./security.ts";
import type { AntigravityApiKey, AvailableModelsRaw, DynamicModelInfo } from "./types.ts";
import { antigravityEnv, isRecord, stableUuid } from "./util.ts";

export const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ENDPOINTS = [
	DEFAULT_ENDPOINT,
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
];
// The server gates fetchAvailableModels on this client version: clients < 1.3.0
// are served a stale catalog (no gemini-4-argon). Pin a newer client with
// ANTIGRAVITY_CLIENT_VERSION (bare X.Y.Z, NOAGY_CLIENT_VERSION also works),
// or override the whole header with ANTIGRAVITY_USER_AGENT.
export const ANTIGRAVITY_CLIENT_VERSION_ENV = "ANTIGRAVITY_CLIENT_VERSION";
const BUNDLED_CLIENT_VERSION = "1.3.5";
const CLIENT_VERSION = /^\d+\.\d+\.\d+$/;

export function resolveAntigravityClientVersion(env?: ProviderEnv): string {
	const override = antigravityEnv("CLIENT_VERSION", env)?.trim();
	if (!override) return BUNDLED_CLIENT_VERSION;
	if (!CLIENT_VERSION.test(override))
		throw new Error(`${ANTIGRAVITY_CLIENT_VERSION_ENV} must be a bare X.Y.Z version`);
	return override;
}

export function antigravityUserAgent(env?: ProviderEnv): string {
	return (
		antigravityEnv("USER_AGENT", env) ||
		`antigravity/cli/${resolveAntigravityClientVersion(env)} (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)`
	);
}

export const DEFAULT_USER_AGENT = antigravityUserAgent();

export function endpointCandidates(env?: ProviderEnv, baseUrl?: string): string[] {
	const explicit = antigravityEnv("BASE_URL", env)?.trim();
	if (explicit) return [assertSafeApiBaseUrl(explicit)];
	if (baseUrl && baseUrl !== DEFAULT_ENDPOINT) return [assertSafeApiBaseUrl(baseUrl)];
	return ENDPOINTS;
}

export function antigravityHeaders(token: string, env?: ProviderEnv): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"User-Agent": antigravityUserAgent(env),
	};
}

export function jsonOrTextError(text: string): string {
	try {
		const value: unknown = JSON.parse(text);
		if (isRecord(value) && isRecord(value.error) && typeof value.error.message === "string")
			return value.error.message;
	} catch {
		/* Non-JSON error body. */
	}
	return text;
}

export function parseApiKey(raw: string | undefined): AntigravityApiKey {
	if (!raw) throw new Error("No Antigravity OAuth credentials");
	try {
		const value: unknown = JSON.parse(raw);
		if (
			isRecord(value) &&
			typeof value.token === "string" &&
			value.token &&
			typeof value.projectId === "string" &&
			value.projectId
		) {
			return { token: value.token, projectId: value.projectId };
		}
	} catch {
		/* Never include credentials in parse errors. */
	}
	throw new Error("Invalid Antigravity credentials: expected token and projectId");
}

export async function defaultProjectId(seed = "antigravity-default", env?: ProviderEnv): Promise<string> {
	return antigravityEnv("PROJECT_ID", env)?.trim() || stableUuid(`antigravity:${seed}`);
}

export async function resolveProjectId(input: {
	token: string;
	credentialProjectId?: string;
	warmedProject?: string | null;
}): Promise<string> {
	return input.warmedProject || input.credentialProjectId || defaultProjectId();
}

function extractProjectId(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const id =
		value.antigravityProjectId ??
		value.projectId ??
		value.backendProjectId ??
		value.userDefinedCloudaicompanionProject ??
		value.cloudaicompanionProject ??
		value.project;
	if (typeof id === "string" && id) return id;
	if (isRecord(id) && typeof id.id === "string") return id.id;
	for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
		const entries = value[key];
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			if (typeof entry === "string" && entry) return entry;
			const nested = extractProjectId(entry);
			if (nested) return nested;
		}
	}
	return undefined;
}

async function request(
	endpoint: string,
	method: string,
	token: string,
	body: unknown,
	options?: ProviderRequestOptions,
): Promise<unknown> {
	const signal = options?.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(8000)])
		: AbortSignal.timeout(8000);
	const response = await (options?.fetch ?? fetch)(`${endpoint}/v1internal:${method}`, {
		method: "POST",
		headers: antigravityHeaders(token, options?.env),
		body: JSON.stringify(body),
		signal,
	});
	if (!response.ok)
		throw new Error(
			`Antigravity ${method} (${response.status}): ${safeError(jsonOrTextError(await response.text()))}`,
		);
	return response.json();
}

export async function loadCodeAssist(token: string, options?: ProviderRequestOptions): Promise<string | undefined> {
	for (const endpoint of endpointCandidates(options?.env)) {
		options?.signal?.throwIfAborted();
		try {
			const project = extractProjectId(
				await request(endpoint, "loadCodeAssist", token, { metadata: { ideType: "ANTIGRAVITY" } }, options),
			);
			if (project) return project;
			const listed = extractProjectId(await request(endpoint, "listCloudAICompanionProjects", token, {}, options));
			if (listed) return listed;
		} catch {
			options?.signal?.throwIfAborted();
		}
	}
	return undefined;
}

export async function fetchAvailableModelsCatalog(
	token: string,
	projectId: string,
	options?: ProviderRequestOptions,
): Promise<AvailableModelsRaw> {
	const results = await Promise.allSettled(
		endpointCandidates(options?.env).map((endpoint) =>
			request(endpoint, "fetchAvailableModels", token, { project: projectId }, options),
		),
	);
	options?.signal?.throwIfAborted();
	const models: NonNullable<AvailableModelsRaw["models"]> = {};
	let received = false;
	for (const result of results) {
		if (result.status !== "fulfilled" || !isRecord(result.value) || !isRecord(result.value.models)) continue;
		received = true;
		for (const [id, value] of Object.entries(result.value.models)) if (isRecord(value)) models[id] = value;
	}
	if (!received) throw new Error("Antigravity model discovery failed at every endpoint");
	return { models };
}

function buildModelMatchRegex(requestedId: string): RegExp {
	const req = requestedId.toLowerCase();
	// Display names from fetchAvailableModels (keys are the real runtime ids):
	//   gemini-3.8-flash-low       → "Gemini 3.8 Flash (Low)"
	//   gemini-3.8-flash-medium    → "Gemini 3.8 Flash (Medium)"
	//   gemini-3.8-flash-high      → "Gemini 3.8 Flash (High)"
	//   gemini-3.7-flash-low       → "Gemini 3.7 Flash (Low)"
	//   gemini-3.7-flash-medium    → "Gemini 3.7 Flash (Medium)"
	//   gemini-3.7-flash-high      → "Gemini 3.7 Flash (High)"
	//   gemini-3.6-flash-low       → "Gemini 3.6 Flash (Low)"
	//   gemini-3.6-flash-medium    → "Gemini 3.6 Flash (Medium)"
	//   gemini-3.6-flash-high      → "Gemini 3.6 Flash (High)"
	//   gemini-3.5-flash-extra-low → "Gemini 3.5 Flash (Low)"
	//   gemini-3.5-flash-low       → "Gemini 3.5 Flash (Medium)"
	//   gemini-3-flash-agent       → "Gemini 3.5 Flash (High)"
	if (req === "gemini-4-argon-low") return /gemini[- ]4[- ]argon \(low\)/i;
	if (req === "gemini-4-argon-medium") return /gemini[- ]4[- ]argon \(medium\)/i;
	if (req === "gemini-4-argon-high") return /gemini[- ]4[- ]argon \(high\)/i;
	if (req === "gemini-3.8-flash-low") return /gemini[- ]3\.8[- ]flash \(low\)/i;
	if (req === "gemini-3.8-flash-medium") return /gemini[- ]3\.8[- ]flash \(medium\)/i;
	if (req === "gemini-3.8-flash-high") return /gemini[- ]3\.8[- ]flash \(high\)/i;
	if (req === "gemini-3.7-flash-low") return /gemini[- ]3\.7[- ]flash \(low\)/i;
	if (req === "gemini-3.7-flash-medium") return /gemini[- ]3\.7[- ]flash \(medium\)/i;
	if (req === "gemini-3.7-flash-high") return /gemini[- ]3\.7[- ]flash \(high\)/i;
	if (req === "gemini-3.6-flash-low") return /gemini[- ]3\.6[- ]flash \(low\)/i;
	if (req === "gemini-3.6-flash-medium") return /gemini[- ]3\.6[- ]flash \(medium\)/i;
	if (req === "gemini-3.6-flash-high") return /gemini[- ]3\.6[- ]flash \(high\)/i;
	if (req === "gemini-3.5-flash-extra-low") return /gemini[- ]3\.5[- ]flash \(low\)/i;
	if (req === "gemini-3.5-flash-low" || req === "gemini-3.5-flash-medium")
		return /gemini[- ]3\.5[- ]flash \(medium\)/i;
	if (req === "gemini-3.5-flash-high" || req === "gemini-3-flash-agent") return /gemini[- ]3\.5[- ]flash \(high\)/i;
	if (req.includes("claude-opus-5-5")) return /claude.*opus.*5\.5/i;
	if (req.includes("claude-sonnet-5-5")) return /claude.*sonnet.*5\.5/i;
	if (req.includes("claude-opus-4-6")) return /claude.*opus.*4\.6/i;
	if (req.includes("claude-sonnet-4-6")) return /claude.*sonnet.*4\.6/i;
	if (req.includes("gpt-oss-120b")) return /gpt.*oss.*120b/i;
	if (req === "gemini-3.1-pro-low") return /gemini[- ]3\.1[- ]pro \(low\)/i;
	if (req === "gemini-3.1-pro-high" || req === "gemini-pro-agent") return /gemini[- ]3\.1[- ]pro \(high\)/i;
	const escaped = req.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[- ]");
	return new RegExp(escaped, "i");
}

export async function fetchAvailableRuntimeModel(
	token: string,
	projectId: string,
	requested: string,
	options?: ProviderRequestOptions,
): Promise<DynamicModelInfo | undefined> {
	try {
		const catalog = await fetchAvailableModelsCatalog(token, projectId, options);
		const entries = Object.entries(catalog.models ?? {}).filter(
			([id, info]) => isSelectableRuntimeModelId(id) && !info.isInternal,
		);
		const pattern = buildModelMatchRegex(requested);
		const matched =
			entries.find(([id]) => id === requested) ??
			entries.find(([id, info]) => {
				const label = info.label ?? info.displayName ?? info.modelName;
				return pattern.test(id) || (typeof label === "string" && pattern.test(label));
			});
		if (matched)
			return { id: matched[0], model: typeof matched[1].model === "string" ? matched[1].model : undefined };
	} catch {
		options?.signal?.throwIfAborted();
	}
	return undefined;
}
