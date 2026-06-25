/**
 * GitLab Duo Provider Extension
 *
 * Provides access to GitLab Duo AI models (Claude and GPT) through GitLab's AI Gateway.
 * Delegates to pi-ai's built-in Anthropic and OpenAI streaming implementations.
 *
 * Usage:
 *   pi -e ./packages/coding-agent/examples/extensions/custom-provider-gitlab-duo
 *   # Then /login gitlab-duo, or set GITLAB_TOKEN=glpat-...
 */

import {
	type Api,
	type AssistantMessageEventStream,
	anthropicMessagesApi,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	openAIResponsesApi,
	type SimpleStreamOptions,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

const GITLAB_COM_URL = "https://gitlab.com";
const AI_GATEWAY_URL = "https://cloud.gitlab.com";
const ANTHROPIC_PROXY_URL = `${AI_GATEWAY_URL}/ai/v1/proxy/anthropic/`;
const OPENAI_PROXY_URL = `${AI_GATEWAY_URL}/ai/v1/proxy/openai/v1`;

const BUNDLED_CLIENT_ID = "da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b";
const OAUTH_SCOPES = ["api"];
const REDIRECT_URI = "http://127.0.0.1:8080/callback";
const DIRECT_ACCESS_TTL = 25 * 60 * 1000;

// =============================================================================
// Models - exported for use by tests
// =============================================================================

type Backend = "anthropic" | "openai";

interface GitLabModel {
	id: string;
	name: string;
	backend: Backend;
	baseUrl: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

export const MODELS: GitLabModel[] = [
	// Anthropic
	{
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		backend: "anthropic",
		baseUrl: ANTHROPIC_PROXY_URL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		backend: "anthropic",
		baseUrl: ANTHROPIC_PROXY_URL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1000000,
		maxTokens: 64000,
	},
	{
		id: "claude-opus-4-5-20251101",
		name: "Claude Opus 4.5",
		backend: "anthropic",
		baseUrl: ANTHROPIC_PROXY_URL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		contextWindow: 200000,
		maxTokens: 32000,
	},
	{
		id: "claude-sonnet-4-5-20250929",
		name: "Claude Sonnet 4.5",
		backend: "anthropic",
		baseUrl: ANTHROPIC_PROXY_URL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 16384,
	},
	{
		id: "claude-haiku-4-5-20251001",
		name: "Claude Haiku 4.5",
		backend: "anthropic",
		baseUrl: ANTHROPIC_PROXY_URL,
		reasoning: true,
		thinkingLevelMap: { xhigh: "max" },
		input: ["text", "image"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	// OpenAI (all use Responses API)
	{
		id: "gpt-5.5-2026-04-23",
		name: "GPT-5.5",
		backend: "openai",
		baseUrl: OPENAI_PROXY_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.1-2025-11-13",
		name: "GPT-5.1",
		backend: "openai",
		baseUrl: OPENAI_PROXY_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-5-mini-2025-08-07",
		name: "GPT-5 Mini",
		backend: "openai",
		baseUrl: OPENAI_PROXY_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
	{
		id: "gpt-5-codex",
		name: "GPT-5 Codex",
		backend: "openai",
		baseUrl: OPENAI_PROXY_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	},
];

const MODEL_MAP = new Map(MODELS.map((m) => [m.id, m]));

// =============================================================================
// Direct Access Token Cache
// =============================================================================

interface DirectAccessToken {
	token: string;
	headers: Record<string, string>;
	expiresAt: number;
}

let cachedDirectAccess: DirectAccessToken | null = null;

async function getDirectAccessToken(gitlabAccessToken: string): Promise<DirectAccessToken> {
	const now = Date.now();
	if (cachedDirectAccess && cachedDirectAccess.expiresAt > now) {
		return cachedDirectAccess;
	}

	const response = await fetch(`${GITLAB_COM_URL}/api/v4/ai/third_party_agents/direct_access`, {
		method: "POST",
		headers: { Authorization: `Bearer ${gitlabAccessToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({ feature_flags: { DuoAgentPlatformNext: true } }),
	});

	if (!response.ok) {
		const errorText = await response.text();
		if (response.status === 403) {
			throw new Error(
				`GitLab Duo access denied. Ensure GitLab Duo is enabled for your account. Error: ${errorText}`,
			);
		}
		throw new Error(`Failed to get direct access token: ${response.status} ${errorText}`);
	}

	const data = (await response.json()) as { token: string; headers: Record<string, string> };
	cachedDirectAccess = { token: data.token, headers: data.headers, expiresAt: now + DIRECT_ACCESS_TTL };
	return cachedDirectAccess;
}

function invalidateDirectAccessToken() {
	cachedDirectAccess = null;
}

// =============================================================================
// OAuth
// =============================================================================

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	const verifier = btoa(String.fromCharCode(...array))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return { verifier, challenge };
}

async function loginGitLab(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const authParams = new URLSearchParams({
		client_id: BUNDLED_CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		response_type: "code",
		scope: OAUTH_SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: crypto.randomUUID(),
	});

	callbacks.onAuth({ url: `${GITLAB_COM_URL}/oauth/authorize?${authParams.toString()}` });
	const callbackUrl = await callbacks.onPrompt({ message: "Paste the callback URL:" });
	const code = new URL(callbackUrl).searchParams.get("code");
	if (!code) throw new Error("No authorization code found in callback URL");

	const tokenResponse = await fetch(`${GITLAB_COM_URL}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: BUNDLED_CLIENT_ID,
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			redirect_uri: REDIRECT_URI,
		}).toString(),
	});

	if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
	const data = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
		created_at: number;
	};
	invalidateDirectAccessToken();
	return {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: (data.created_at + data.expires_in) * 1000 - 5 * 60 * 1000,
	};
}

async function refreshGitLabToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const response = await fetch(`${GITLAB_COM_URL}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: BUNDLED_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
		}).toString(),
	});
	if (!response.ok) throw new Error(`Token refresh failed: ${await response.text()}`);
	const data = (await response.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
		created_at: number;
	};
	invalidateDirectAccessToken();
	return {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: (data.created_at + data.expires_in) * 1000 - 5 * 60 * 1000,
	};
}

// =============================================================================
// Stream Function
// =============================================================================

export function streamGitLabDuo(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		try {
			const gitlabAccessToken = options?.apiKey;
			if (!gitlabAccessToken) throw new Error("No GitLab access token. Run /login gitlab-duo or set GITLAB_TOKEN");

			const cfg = MODEL_MAP.get(model.id);
			if (!cfg) throw new Error(`Unknown model: ${model.id}`);

			const directAccess = await getDirectAccessToken(gitlabAccessToken);
			const modelWithBaseUrl = { ...model, baseUrl: cfg.baseUrl };
			const headers = { ...directAccess.headers, Authorization: `Bearer ${directAccess.token}` };
			const streamOptions = { ...options, apiKey: "gitlab-duo", headers };

			const innerStream =
				cfg.backend === "anthropic"
					? anthropicMessagesApi().streamSimple(
							{
								...(modelWithBaseUrl as Model<"anthropic-messages">),
								compat: {
									...(modelWithBaseUrl as Model<"anthropic-messages">).compat,
									forceAdaptiveThinking: true,
								},
							},
							context,
							streamOptions,
						)
					: openAIResponsesApi().streamSimple(
							modelWithBaseUrl as Model<"openai-responses">,
							context,
							streamOptions,
						);

			for await (const event of innerStream) stream.push(event);
			stream.end();
		} catch (error) {
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();

	return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerProvider("gitlab-duo", {
		baseUrl: AI_GATEWAY_URL,
		apiKey: "$GITLAB_TOKEN",
		api: "gitlab-duo-api",
		models: MODELS.map(({ id, name, reasoning, thinkingLevelMap, input, cost, contextWindow, maxTokens }) => ({
			id,
			name,
			reasoning,
			thinkingLevelMap,
			input,
			cost,
			contextWindow,
			maxTokens,
		})),
		oauth: {
			name: "GitLab Duo",
			login: loginGitLab,
			refreshToken: refreshGitLabToken,
			getApiKey: (cred) => cred.access,
		},
		streamSimple: streamGitLabDuo,
	});
}
