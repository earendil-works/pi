// The auth documents this package ships with; pi.dev publishes the same set and may publish newer ones.

import type { AuthDocument, AuthDocuments, AuthMethodDocument } from "./documents.ts";

const RELAY_ALWAYS = "so the sign-in and every token refresh go through pi.dev's relay.";

const PASTE = "after signing in, paste the address of the page that fails to load";

/**
 * Browser support of the providers pi knows, as last checked by `scripts/probe-cors.ts`. pi.dev serves
 * this set from `/api/auth/providers`; apps use it until they fetch a newer revision.
 */
export const BUILTIN_AUTH_DOCUMENTS: AuthDocuments = {
	version: 1,
	revision: "2026-10-30.1",
	providers: [
		{
			provider: "radius",
			name: "Radius",
			inference: { browser: "direct" },
			methods: [
				apiKey("Radius API key"),
				{
					id: "device-code",
					type: "oauth",
					kind: "device_code",
					label: "Sign in with a device code",
					browser: { signIn: "direct", relay: "none" },
				},
				{
					id: "browser",
					type: "oauth",
					kind: "pkce_loopback",
					label: "Sign in with the browser",
					browser: {
						signIn: "unsupported",
						relay: "none",
						reason:
							"Radius redirects this sign-in only to a local server and offers no paste fallback. Use the device code.",
					},
				},
			],
		},
		{
			provider: "anthropic",
			name: "Anthropic",
			inference: { browser: "direct" },
			methods: [
				apiKey("Anthropic API key"),
				{
					id: "copy_code",
					type: "oauth",
					kind: "pkce_copy_code",
					label: "Sign in with Claude (copy a code)",
					browser: {
						signIn: "direct",
						relay: "always",
						reason: `Anthropic's token endpoint does not accept browser requests, ${RELAY_ALWAYS}`,
					},
				},
				{
					id: "browser",
					type: "oauth",
					kind: "pkce_loopback",
					label: "Sign in with Claude (paste the address)",
					browser: {
						signIn: "manual",
						relay: "always",
						reason: `Anthropic redirects this sign-in only to localhost: ${PASTE}. Its token endpoint does not accept browser requests, ${RELAY_ALWAYS}`,
					},
				},
			],
		},
		{
			provider: "openai",
			name: "OpenAI",
			inference: { browser: "direct" },
			methods: [
				apiKey("OpenAI API key"),
				{
					id: "browser",
					type: "oauth",
					kind: "pkce_loopback",
					label: "Sign in with ChatGPT",
					browser: {
						signIn: "manual",
						relay: "none",
						reason: `OpenAI redirects this sign-in only to 127.0.0.1: ${PASTE}.`,
					},
				},
			],
		},
		{
			provider: "openai-codex",
			name: "OpenAI Codex (legacy)",
			inference: {
				browser: "unsupported",
				reason: "chatgpt.com accepts browser requests only from pages on http://localhost.",
			},
			methods: [
				{
					id: "device_code",
					type: "oauth",
					kind: "device_code",
					label: "Sign in with a device code",
					browser: { signIn: "direct", relay: "none" },
				},
				{
					id: "browser",
					type: "oauth",
					kind: "pkce_loopback",
					label: "Sign in with the browser",
					browser: {
						signIn: "manual",
						relay: "none",
						reason: `OpenAI redirects this sign-in only to localhost: ${PASTE}.`,
					},
				},
			],
		},
		{
			provider: "github-copilot",
			name: "GitHub Copilot",
			inference: { browser: "direct" },
			methods: [
				apiKey("GitHub Copilot token"),
				{
					id: "device_code",
					type: "oauth",
					kind: "device_code",
					label: "Sign in with GitHub",
					browser: {
						signIn: "direct",
						relay: "always",
						reason: `GitHub's sign-in endpoints do not accept browser requests and the Copilot token endpoint rejects the headers Copilot needs, ${RELAY_ALWAYS} GitHub Enterprise is not supported.`,
					},
				},
			],
		},
		{
			provider: "xai",
			name: "xAI",
			inference: { browser: "direct" },
			methods: [
				apiKey("xAI API key"),
				{
					id: "device_code",
					type: "oauth",
					kind: "device_code",
					label: "Sign in with SuperGrok or X Premium",
					browser: {
						signIn: "direct",
						relay: "always",
						reason: `auth.x.ai does not accept browser requests, ${RELAY_ALWAYS}`,
					},
				},
			],
		},
		{
			provider: "meta",
			name: "Meta",
			inference: { browser: "direct" },
			methods: [
				apiKey("Meta Model API key"),
				{
					id: "device_code",
					type: "oauth",
					kind: "device_code",
					label: "Sign in with Meta",
					browser: {
						signIn: "direct",
						relay: "always",
						reason:
							"auth.meta.com and Meta's key endpoint do not accept browser requests, so the sign-in and the daily key renewal go through pi.dev's relay.",
					},
				},
			],
		},
		{
			provider: "kimi-coding",
			name: "Kimi For Coding",
			inference: { browser: "unsupported", reason: "api.kimi.com does not accept browser requests." },
			methods: [
				apiKey("Kimi API key"),
				{
					id: "device_code",
					type: "oauth",
					kind: "device_code",
					label: "Sign in with Kimi Code",
					browser: { signIn: "direct", relay: "none" },
				},
			],
		},
		{
			provider: "openrouter",
			name: "OpenRouter",
			inference: {
				browser: "unsupported",
				reason:
					"pi talks to OpenRouter's Anthropic-compatible API, and openrouter.ai refuses the anthropic-* headers those requests carry from browsers.",
			},
			methods: [
				apiKey("OpenRouter API key"),
				{
					id: "browser",
					type: "oauth",
					kind: "pkce_loopback",
					label: "Sign in with OpenRouter",
					browser: {
						signIn: "unsupported",
						relay: "none",
						reason:
							"pi's OpenRouter sign-in waits for a local server and has no paste fallback yet. Use an API key.",
					},
				},
			],
		},
		apiKeyProvider("google", "Google", "Gemini API key"),
		apiKeyProvider("mistral", "Mistral", "Mistral API key"),
		apiKeyProvider("groq", "Groq", "Groq API key"),
		apiKeyProvider("deepseek", "DeepSeek", "DeepSeek API key"),
		apiKeyProvider("cerebras", "Cerebras", "Cerebras API key"),
		apiKeyProvider("together", "Together", "Together API key"),
		apiKeyProvider("huggingface", "Hugging Face", "Hugging Face token"),
		{
			provider: "fireworks",
			name: "Fireworks",
			inference: { browser: "unsupported", reason: "api.fireworks.ai does not accept browser requests." },
			methods: [apiKey("Fireworks API key")],
		},
		{
			provider: "moonshotai",
			name: "Moonshot AI",
			inference: { browser: "unsupported", reason: "api.moonshot.ai does not accept browser requests." },
			methods: [apiKey("Moonshot AI API key")],
		},
	],
};

function apiKey(label: string): AuthMethodDocument {
	return { id: "api_key", type: "api_key", kind: "api_key", label, browser: { signIn: "direct", relay: "none" } };
}

function apiKeyProvider(provider: string, name: string, keyLabel: string): AuthDocument {
	return { provider, name, inference: { browser: "direct" }, methods: [apiKey(keyLabel)] };
}
