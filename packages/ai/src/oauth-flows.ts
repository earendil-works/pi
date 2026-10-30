/**
 * Every built-in OAuth flow, bundled statically.
 *
 * Built-in providers load their OAuth flow lazily, through an import path that bundlers cannot follow,
 * so Node-only flow code never reaches a bundle by accident. Runtimes that bundle everything up front
 * (browsers, standalone binaries) import this entry instead and call `registerOAuthFlows()` once,
 * before the first login or token refresh. Importing it loads every flow.
 */

import { anthropicOAuth } from "./auth/oauth/anthropic.ts";
import { type OAuthFetch, setOAuthFetch } from "./auth/oauth/fetch.ts";
import { githubCopilotOAuth } from "./auth/oauth/github-copilot.ts";
import { kimiCodingOAuth } from "./auth/oauth/kimi-coding.ts";
import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.ts";
import { metaOAuth } from "./auth/oauth/meta.ts";
import { openaiChatGPTOAuth } from "./auth/oauth/openai-chatgpt.ts";
import { openaiCodexOAuth } from "./auth/oauth/openai-codex.ts";
import { openRouterOAuth } from "./auth/oauth/openrouter.ts";
import { createRadiusOAuth } from "./auth/oauth/radius.ts";
import { xaiOAuth } from "./auth/oauth/xai.ts";
import type { OAuthAuth } from "./auth/types.ts";
import { DEFAULT_RADIUS_GATEWAY } from "./providers/radius-config.ts";

export type { OAuthFetch } from "./auth/oauth/fetch.ts";

export interface OAuthFlowOptions {
	/**
	 * Sends every request of every flow, for example one that routes the requests a browser cannot
	 * make directly through a relay. Default: the global fetch.
	 */
	fetch?: OAuthFetch;
}

/** Make the lazily loaded OAuth flows of the built-in providers load from this bundle. */
export function registerOAuthFlows(options: OAuthFlowOptions = {}): void {
	setOAuthFetch(options.fetch);
	registerBundledOAuthFlowLoaders({
		anthropic: () => anthropicOAuth,
		openaiCodex: () => openaiCodexOAuth,
		openaiChatGPT: () => openaiChatGPTOAuth,
		githubCopilot: () => githubCopilotOAuth,
		openrouter: () => openRouterOAuth,
		kimiCoding: () => kimiCodingOAuth,
		meta: () => metaOAuth,
		xai: () => xaiOAuth,
		radius: createRadiusOAuth,
	});
}

/**
 * The OAuth flow of a built-in provider, by provider ID, for code that signs in without a `Models`
 * collection. Radius uses its default gateway.
 */
export function getBuiltinOAuthFlow(providerId: string): OAuthAuth | undefined {
	switch (providerId) {
		case "anthropic":
			return anthropicOAuth;
		case "openai":
			return openaiChatGPTOAuth;
		case "openai-codex":
			return openaiCodexOAuth;
		case "github-copilot":
			return githubCopilotOAuth;
		case "openrouter":
			return openRouterOAuth;
		case "kimi-coding":
			return kimiCodingOAuth;
		case "meta":
			return metaOAuth;
		case "xai":
			return xaiOAuth;
		case "radius":
			return createRadiusOAuth({ name: "Radius", gateway: DEFAULT_RADIUS_GATEWAY });
		default:
			return undefined;
	}
}
