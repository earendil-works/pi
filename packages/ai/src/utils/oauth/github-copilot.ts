/**
 * GitHub Copilot OAuth flow
 */

import { getModels } from "../../models.js";
import type { Api, Model } from "../../types.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

type CopilotCredentials = OAuthCredentials & {
	enterpriseUrl?: string;
	/** Dynamically discovered models from the Copilot /models API */
	discoveredModels?: SerializedCopilotModel[];
	/** Timestamp of the last model discovery fetch */
	discoveredModelsAt?: number;
};

/** Serializable shape stored on credentials for models discovered from the API */
interface SerializedCopilotModel {
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	compat?: Record<string, unknown>;
}

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");

const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

const INITIAL_POLL_INTERVAL_MULTIPLIER = 1.2;
const SLOW_DOWN_POLL_INTERVAL_MULTIPLIER = 1.4;

type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
};

type DeviceTokenSuccessResponse = {
	access_token: string;
	token_type?: string;
	scope?: string;
};

type DeviceTokenErrorResponse = {
	error: string;
	error_description?: string;
	interval?: number;
};

export function normalizeDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return null;
	}
}

function getUrls(domain: string): {
	deviceCodeUrl: string;
	accessTokenUrl: string;
	copilotTokenUrl: string;
} {
	return {
		deviceCodeUrl: `https://${domain}/login/device/code`,
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
		copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
	};
}

/**
 * Parse the proxy-ep from a Copilot token and convert to API base URL.
 * Token format: tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...
 * Returns API URL like https://api.individual.githubcopilot.com
 */
function getBaseUrlFromToken(token: string): string | null {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return null;
	const proxyHost = match[1];
	// Convert proxy.xxx to api.xxx
	const apiHost = proxyHost.replace(/^proxy\./, "api.");
	return `https://${apiHost}`;
}

export function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
	// If we have a token, extract the base URL from proxy-ep
	if (token) {
		const urlFromToken = getBaseUrlFromToken(token);
		if (urlFromToken) return urlFromToken;
	}
	// Fallback for enterprise or if token parsing fails
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	return "https://api.individual.githubcopilot.com";
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}
	return response.json();
}

async function startDeviceFlow(domain: string): Promise<DeviceCodeResponse> {
	const urls = getUrls(domain);
	const data = await fetchJson(urls.deviceCodeUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": "GitHubCopilotChat/0.35.0",
		},
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			scope: "read:user",
		}),
	});

	if (!data || typeof data !== "object") {
		throw new Error("Invalid device code response");
	}

	const deviceCode = (data as Record<string, unknown>).device_code;
	const userCode = (data as Record<string, unknown>).user_code;
	const verificationUri = (data as Record<string, unknown>).verification_uri;
	const interval = (data as Record<string, unknown>).interval;
	const expiresIn = (data as Record<string, unknown>).expires_in;

	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		typeof interval !== "number" ||
		typeof expiresIn !== "number"
	) {
		throw new Error("Invalid device code response fields");
	}

	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: verificationUri,
		interval,
		expires_in: expiresIn,
	};
}

/**
 * Sleep that can be interrupted by an AbortSignal
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}

		const timeout = setTimeout(resolve, ms);

		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Login cancelled"));
			},
			{ once: true },
		);
	});
}

async function pollForGitHubAccessToken(
	domain: string,
	deviceCode: string,
	intervalSeconds: number,
	expiresIn: number,
	signal?: AbortSignal,
) {
	const urls = getUrls(domain);
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));
	let intervalMultiplier = INITIAL_POLL_INTERVAL_MULTIPLIER;
	let slowDownResponses = 0;

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}

		const remainingMs = deadline - Date.now();
		const waitMs = Math.min(Math.ceil(intervalMs * intervalMultiplier), remainingMs);
		await abortableSleep(waitMs, signal);

		const raw = await fetchJson(urls.accessTokenUrl, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": "GitHubCopilotChat/0.35.0",
			},
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		if (raw && typeof raw === "object" && typeof (raw as DeviceTokenSuccessResponse).access_token === "string") {
			return (raw as DeviceTokenSuccessResponse).access_token;
		}

		if (raw && typeof raw === "object" && typeof (raw as DeviceTokenErrorResponse).error === "string") {
			const { error, error_description: description, interval } = raw as DeviceTokenErrorResponse;
			if (error === "authorization_pending") {
				continue;
			}

			if (error === "slow_down") {
				slowDownResponses += 1;
				intervalMs =
					typeof interval === "number" && interval > 0 ? interval * 1000 : Math.max(1000, intervalMs + 5000);
				intervalMultiplier = SLOW_DOWN_POLL_INTERVAL_MULTIPLIER;
				continue;
			}

			const descriptionSuffix = description ? `: ${description}` : "";
			throw new Error(`Device flow failed: ${error}${descriptionSuffix}`);
		}
	}

	if (slowDownResponses > 0) {
		throw new Error(
			"Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.",
		);
	}

	throw new Error("Device flow timed out");
}

/**
 * Refresh GitHub Copilot token
 */
export async function refreshGitHubCopilotToken(
	refreshToken: string,
	enterpriseDomain?: string,
): Promise<OAuthCredentials> {
	const domain = enterpriseDomain || "github.com";
	const urls = getUrls(domain);

	const raw = await fetchJson(urls.copilotTokenUrl, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${refreshToken}`,
			...COPILOT_HEADERS,
		},
	});

	if (!raw || typeof raw !== "object") {
		throw new Error("Invalid Copilot token response");
	}

	const token = (raw as Record<string, unknown>).token;
	const expiresAt = (raw as Record<string, unknown>).expires_at;

	if (typeof token !== "string" || typeof expiresAt !== "number") {
		throw new Error("Invalid Copilot token response fields");
	}

	return {
		refresh: refreshToken,
		access: token,
		expires: expiresAt * 1000 - 5 * 60 * 1000,
		enterpriseUrl: enterpriseDomain,
	};
}

// ============================================================================
// Dynamic model discovery from the Copilot /models API
// ============================================================================

/** Shape of a single model entry from GET /models */
interface CopilotApiModel {
	id: string;
	name: string;
	object: string;
	vendor: string;
	preview: boolean;
	model_picker_enabled?: boolean;
	supported_endpoints?: string[] | null;
	capabilities: {
		object: string;
		type: string;
		limits: {
			max_context_window_tokens?: number | null;
			max_output_tokens?: number | null;
			vision?: { supported_media_types?: string[] } | null;
		};
		supports: {
			tool_calls?: boolean | null;
			vision?: boolean | null;
			adaptive_thinking?: boolean | null;
			streaming?: boolean | null;
			structured_outputs?: boolean | null;
			reasoning_effort?: string[] | null;
		};
	};
	policy?: {
		state: string;
	};
}

/**
 * Determine the Pi API type from a Copilot model's supported_endpoints.
 *
 * - /v1/messages → anthropic-messages (Claude models)
 * - /responses   → openai-responses (GPT-5+ / Goldeneye)
 * - fallback     → openai-completions
 */
function inferApiFromEndpoints(endpoints: string[] | null | undefined, modelId: string): string {
	if (!endpoints || endpoints.length === 0) {
		// No explicit endpoints — infer from model ID patterns
		const isClaude4 = /^claude-(haiku|sonnet|opus)-4([.-]|$)/.test(modelId);
		if (isClaude4) return "anthropic-messages";
		if (modelId.startsWith("gpt-5")) return "openai-responses";
		return "openai-completions";
	}

	if (endpoints.some((e) => e.includes("/v1/messages"))) return "anthropic-messages";
	if (endpoints.some((e) => e.includes("/responses"))) return "openai-responses";
	return "openai-completions";
}

/**
 * Convert a Copilot API model to the serializable shape we store on credentials.
 */
function toCopilotDiscoveredModel(m: CopilotApiModel): SerializedCopilotModel {
	const api = inferApiFromEndpoints(m.supported_endpoints, m.id);
	const supports = m.capabilities?.supports;
	const limits = m.capabilities?.limits;

	// Reasoning: explicit adaptive_thinking flag, or GPT-5+ family pattern
	const reasoning =
		supports?.adaptive_thinking === true || /^(gpt-5|goldeneye|claude-(opus|sonnet|haiku)-4\.[5-9])/.test(m.id);

	const input: ("text" | "image")[] = supports?.vision ? ["text", "image"] : ["text"];

	const result: SerializedCopilotModel = {
		id: m.id,
		name: m.name || m.id,
		api,
		reasoning,
		input,
		contextWindow: limits?.max_context_window_tokens || 128000,
		maxTokens: limits?.max_output_tokens || 16384,
	};

	// openai-completions models need compat flags
	if (api === "openai-completions") {
		result.compat = {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		};
	}

	return result;
}

/**
 * Fetch the list of available models from the Copilot /models API.
 * Only returns models that support tool_calls (i.e. usable for agentic coding).
 */
export async function fetchCopilotModels(token: string, enterpriseDomain?: string): Promise<SerializedCopilotModel[]> {
	const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
	const url = `${baseUrl}/models`;

	try {
		const response = await fetch(url, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				...COPILOT_HEADERS,
			},
		});
		if (!response.ok) return [];

		const body = (await response.json()) as { data?: CopilotApiModel[] };
		if (!body?.data || !Array.isArray(body.data)) return [];

		// Filter: must support tool_calls, deduplicate by id (keep first occurrence)
		const seen = new Set<string>();
		const result: SerializedCopilotModel[] = [];

		for (const m of body.data) {
			if (m.capabilities?.supports?.tool_calls !== true) continue;
			if (seen.has(m.id)) continue;
			seen.add(m.id);
			result.push(toCopilotDiscoveredModel(m));
		}

		return result;
	} catch {
		// Non-fatal: if the API is unreachable, fall back to static models
		return [];
	}
}

/**
 * Enable a model for the user's GitHub Copilot account.
 * This is required for some models (like Claude, Grok) before they can be used.
 */
async function enableGitHubCopilotModel(token: string, modelId: string, enterpriseDomain?: string): Promise<boolean> {
	const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
	const url = `${baseUrl}/models/${modelId}/policy`;

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				...COPILOT_HEADERS,
				"openai-intent": "chat-policy",
				"x-interaction-type": "chat-policy",
			},
			body: JSON.stringify({ state: "enabled" }),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Enable all known GitHub Copilot models that may require policy acceptance.
 * Called after successful login to ensure all models are available.
 */
async function enableAllGitHubCopilotModels(
	token: string,
	enterpriseDomain?: string,
	onProgress?: (model: string, success: boolean) => void,
	discoveredModels?: SerializedCopilotModel[],
): Promise<void> {
	// Merge built-in + discovered model IDs for policy enablement
	const builtIn = getModels("github-copilot");
	const allIds = new Set(builtIn.map((m) => m.id));
	if (discoveredModels) {
		for (const m of discoveredModels) allIds.add(m.id);
	}

	await Promise.all(
		Array.from(allIds).map(async (id) => {
			const success = await enableGitHubCopilotModel(token, id, enterpriseDomain);
			onProgress?.(id, success);
		}),
	);
}

/**
 * Login with GitHub Copilot OAuth (device code flow)
 *
 * @param options.onAuth - Callback with URL and optional instructions (user code)
 * @param options.onPrompt - Callback to prompt user for input
 * @param options.onProgress - Optional progress callback
 * @param options.signal - Optional AbortSignal for cancellation
 */
export async function loginGitHubCopilot(options: {
	onAuth: (url: string, instructions?: string) => void;
	onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const input = await options.onPrompt({
		message: "GitHub Enterprise URL/domain (blank for github.com)",
		placeholder: "company.ghe.com",
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = input.trim();
	const enterpriseDomain = normalizeDomain(input);
	if (trimmed && !enterpriseDomain) {
		throw new Error("Invalid GitHub Enterprise URL/domain");
	}
	const domain = enterpriseDomain || "github.com";

	const device = await startDeviceFlow(domain);
	options.onAuth(device.verification_uri, `Enter code: ${device.user_code}`);

	const githubAccessToken = await pollForGitHubAccessToken(
		domain,
		device.device_code,
		device.interval,
		device.expires_in,
		options.signal,
	);
	const credentials = await refreshGitHubCopilotToken(githubAccessToken, enterpriseDomain ?? undefined);

	// Discover available models from the API and enable them
	options.onProgress?.("Discovering models...");
	const discovered = await fetchCopilotModels(credentials.access, enterpriseDomain ?? undefined);
	(credentials as CopilotCredentials).discoveredModels = discovered;
	(credentials as CopilotCredentials).discoveredModelsAt = Date.now();

	options.onProgress?.("Enabling models...");
	await enableAllGitHubCopilotModels(credentials.access, enterpriseDomain ?? undefined, undefined, discovered);
	return credentials;
}

export const githubCopilotOAuthProvider: OAuthProviderInterface = {
	id: "github-copilot",
	name: "GitHub Copilot",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginGitHubCopilot({
			onAuth: (url, instructions) => callbacks.onAuth({ url, instructions }),
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		const creds = credentials as CopilotCredentials;
		const refreshed = await refreshGitHubCopilotToken(creds.refresh, creds.enterpriseUrl);

		// Re-discover models if the last discovery is stale (>1 hour) or missing
		const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour
		const lastDiscovery = creds.discoveredModelsAt ?? 0;
		if (Date.now() - lastDiscovery > DISCOVERY_TTL_MS) {
			const discovered = await fetchCopilotModels(refreshed.access, creds.enterpriseUrl);
			if (discovered.length > 0) {
				(refreshed as CopilotCredentials).discoveredModels = discovered;
				(refreshed as CopilotCredentials).discoveredModelsAt = Date.now();
			} else {
				// Keep previous discovery if the new fetch failed
				(refreshed as CopilotCredentials).discoveredModels = creds.discoveredModels;
				(refreshed as CopilotCredentials).discoveredModelsAt = creds.discoveredModelsAt;
			}
		} else {
			// Carry forward existing discovery
			(refreshed as CopilotCredentials).discoveredModels = creds.discoveredModels;
			(refreshed as CopilotCredentials).discoveredModelsAt = creds.discoveredModelsAt;
		}

		return refreshed;
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	modifyModels(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
		const creds = credentials as CopilotCredentials;
		const domain = creds.enterpriseUrl ? (normalizeDomain(creds.enterpriseUrl) ?? undefined) : undefined;
		const baseUrl = getGitHubCopilotBaseUrl(creds.access, domain);

		// Update baseUrl on existing copilot models
		let result = models.map((m) => (m.provider === "github-copilot" ? { ...m, baseUrl } : m));

		// Merge dynamically discovered models
		const discovered = creds.discoveredModels;
		if (discovered && discovered.length > 0) {
			const existingIds = new Set(result.filter((m) => m.provider === "github-copilot").map((m) => m.id));

			for (const dm of discovered) {
				if (existingIds.has(dm.id)) {
					// Update existing model with fresh capabilities from the API
					result = result.map((m) => {
						if (m.provider !== "github-copilot" || m.id !== dm.id) return m;
						return {
							...m,
							name: dm.name,
							contextWindow: dm.contextWindow,
							maxTokens: dm.maxTokens,
							input: dm.input,
							reasoning: dm.reasoning,
						};
					});
				} else {
					// Add newly discovered model
					result.push({
						id: dm.id,
						name: dm.name,
						api: dm.api as Api,
						provider: "github-copilot",
						baseUrl,
						reasoning: dm.reasoning,
						input: dm.input,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: dm.contextWindow,
						maxTokens: dm.maxTokens,
						headers: { ...COPILOT_HEADERS },
						...(dm.compat ? { compat: dm.compat } : {}),
					} as Model<Api>);
				}
			}
		}

		return result;
	},
};
