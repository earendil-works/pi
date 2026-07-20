import type { ApiKeyAuth, OAuthAuth } from "./types.ts";

/**
 * Standard api-key auth: a stored credential key wins, otherwise the first
 * set env var resolves. Includes a `login` that prompts for the key.
 * Providers with non-standard resolution (provider env, ambient files, IAM)
 * write their own `ApiKeyAuth`.
 */
export function envApiKeyAuth(name: string, envVars: readonly string[]): ApiKeyAuth {
	return {
		name,
		login: async (interaction) => {
			const key = await interaction.prompt({ type: "secret", message: `Enter ${name}` });
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential }) => {
			// Surface provider-scoped env from the stored credential (auth.json `env`)
			// so provider config such as AZURE_OPENAI_BASE_URL resolves before process
			// env. Per-field: prefer the credential value, fall back to ambient env.
			const env = credential?.env;
			if (credential?.key) return { auth: { apiKey: credential.key }, env, source: "stored credential" };
			for (const envVar of envVars) {
				const fromCredential = env?.[envVar];
				const value = fromCredential ?? (await ctx.env(envVar));
				if (value) return { auth: { apiKey: value }, env, source: fromCredential ? "stored credential" : envVar };
			}
			return undefined;
		},
	};
}

/**
 * Wraps a dynamically imported `OAuthAuth` so provider definitions can
 * advertise OAuth without importing the implementation. The flow loads on
 * first `login`/`refresh`/`toAuth` call; callers keep Node-only flow code out
 * of bundles by loading through a bundler-opaque dynamic import (variable
 * specifier, see the bedrock lazy wrapper).
 */
export function lazyOAuth(input: { name: string; loginLabel?: string; load: () => Promise<OAuthAuth> }): OAuthAuth {
	let promise: Promise<OAuthAuth> | undefined;
	const loaded = () => {
		promise ??= input.load();
		return promise;
	};
	return {
		name: input.name,
		loginLabel: input.loginLabel,
		login: async (interaction) => (await loaded()).login(interaction),
		refresh: async (credential) => (await loaded()).refresh(credential),
		toAuth: async (credential) => (await loaded()).toAuth(credential),
	};
}
