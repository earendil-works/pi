import type { ApiKeyAuth, ApiKeyCredential, AuthContext } from "../auth/types.ts";
import type { ProviderEnv } from "../types.ts";

const CLOUDFLARE_API_KEY = "CLOUDFLARE_API_KEY";
const CLOUDFLARE_ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID = "CLOUDFLARE_GATEWAY_ID";
const CLOUDFLARE_GATEWAY_DOMAIN = "CLOUDFLARE_GATEWAY_DOMAIN";
const CLOUDFLARE_ACCESS_CLIENT_ID = "CLOUDFLARE_ACCESS_CLIENT_ID";
const CLOUDFLARE_ACCESS_CLIENT_SECRET = "CLOUDFLARE_ACCESS_CLIENT_SECRET";
const CLOUDFLARE_ACCESS_TOKEN = "CLOUDFLARE_ACCESS_TOKEN";

async function resolveValue(
	name: string,
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<string | undefined> {
	// Per-field merge: prefer the credential value, fall back to ambient env.
	// A credential carrying only the API key must still pick up the account /
	// gateway id from the environment.
	const fromCredential = credential
		? name === CLOUDFLARE_API_KEY
			? credential.key
			: credential.env?.[name]
		: undefined;
	if (fromCredential !== undefined) return fromCredential;
	signal.throwIfAborted();
	const value = await ctx.env(name);
	signal.throwIfAborted();
	return value;
}

async function resolveCloudflareEnv(
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<{ apiKey: string; env: ProviderEnv; source: string } | undefined> {
	const apiKey = await resolveValue(CLOUDFLARE_API_KEY, ctx, credential, signal);
	const accountId = await resolveValue(CLOUDFLARE_ACCOUNT_ID, ctx, credential, signal);
	if (!apiKey || !accountId) return undefined;

	return {
		apiKey,
		env: { CLOUDFLARE_ACCOUNT_ID: accountId },
		source: credential ? "stored credential" : CLOUDFLARE_API_KEY,
	};
}

export function cloudflareWorkersAIAuth(): ApiKeyAuth {
	return {
		name: "Cloudflare API key",
		login: async (interaction) => {
			const key = await interaction.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			const accountId = await interaction.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			return { type: "api_key", key, env: { CLOUDFLARE_ACCOUNT_ID: accountId } };
		},
		resolve: async ({ ctx, credential, signal }) => {
			const resolved = await resolveCloudflareEnv(ctx, credential, signal);
			if (!resolved) return undefined;
			return {
				auth: { apiKey: resolved.apiKey },
				env: resolved.env,
				source: resolved.source,
			};
		},
	};
}

async function resolveCloudflareGateway(
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<{ headers: Record<string, string | null>; env: ProviderEnv; source: string } | undefined> {
	const apiKey = await resolveValue(CLOUDFLARE_API_KEY, ctx, credential, signal);
	const domain = await resolveValue(CLOUDFLARE_GATEWAY_DOMAIN, ctx, credential, signal);
	const accountId = await resolveValue(CLOUDFLARE_ACCOUNT_ID, ctx, credential, signal);
	const gatewayId = await resolveValue(CLOUDFLARE_GATEWAY_ID, ctx, credential, signal);
	const accessClientId = await resolveValue(CLOUDFLARE_ACCESS_CLIENT_ID, ctx, credential, signal);
	const accessClientSecret = await resolveValue(CLOUDFLARE_ACCESS_CLIENT_SECRET, ctx, credential, signal);
	const accessToken = await resolveValue(CLOUDFLARE_ACCESS_TOKEN, ctx, credential, signal);

	if (!domain && (!accountId || !gatewayId)) return undefined;

	const env: ProviderEnv = {};
	if (accountId) env[CLOUDFLARE_ACCOUNT_ID] = accountId;
	if (gatewayId) env[CLOUDFLARE_GATEWAY_ID] = gatewayId;
	if (domain) env[CLOUDFLARE_GATEWAY_DOMAIN] = domain;

	const headers: Record<string, string | null> = {
		// Always present (null when unauthenticated) so compat treats the request as already resolved.
		"cf-aig-authorization": apiKey ? `Bearer ${apiKey}` : null,
		Authorization: null,
		"x-api-key": null,
	};
	if (accessClientId && accessClientSecret) {
		headers["cf-access-client-id"] = accessClientId;
		headers["cf-access-client-secret"] = accessClientSecret;
	}
	if (accessToken) headers["cf-access-token"] = accessToken;

	return {
		headers,
		env,
		source: credential
			? "stored credential"
			: apiKey
				? CLOUDFLARE_API_KEY
				: domain
					? CLOUDFLARE_GATEWAY_DOMAIN
					: CLOUDFLARE_GATEWAY_ID,
	};
}

export function cloudflareAIGatewayAuth(): ApiKeyAuth {
	return {
		name: "Cloudflare AI Gateway",
		login: async (interaction) => {
			const env: Record<string, string> = {};
			const endpoint = await interaction.prompt({
				type: "select",
				message: "Select Cloudflare AI Gateway endpoint:",
				options: [
					{ id: "default", label: "gateway.ai.cloudflare.com", description: "Account ID and gateway ID" },
					{ id: "custom-domain", label: "Custom domain", description: "For example ai.example.com" },
				],
			});
			if (endpoint === "custom-domain") {
				env[CLOUDFLARE_GATEWAY_DOMAIN] = await interaction.prompt({
					type: "text",
					message: "Enter AI Gateway custom domain",
					placeholder: "ai.example.com",
				});
			} else {
				env[CLOUDFLARE_ACCOUNT_ID] = await interaction.prompt({
					type: "text",
					message: "Enter Cloudflare account ID",
				});
				env[CLOUDFLARE_GATEWAY_ID] = await interaction.prompt({
					type: "text",
					message: "Enter Cloudflare AI Gateway ID",
				});
			}

			const gatewayAuth = await interaction.prompt({
				type: "select",
				message: "Does the gateway require an AI Gateway token?",
				options: [
					{ id: "token", label: "Yes", description: "Authenticated gateway" },
					{ id: "none", label: "No", description: "Unauthenticated gateway" },
				],
			});
			const key =
				gatewayAuth === "token"
					? await interaction.prompt({ type: "secret", message: "Enter Cloudflare API key" })
					: undefined;

			if (endpoint === "custom-domain") {
				const access = await interaction.prompt({
					type: "select",
					message: "Select Cloudflare Access authentication:",
					options: [
						{ id: "none", label: "None", description: "No Access policy, or WARP provides the identity" },
						{ id: "service-token", label: "Service token", description: "Client ID and client secret" },
						{ id: "access-token", label: "Access token", description: "Sent as cf-access-token" },
					],
				});
				if (access === "service-token") {
					env[CLOUDFLARE_ACCESS_CLIENT_ID] = await interaction.prompt({
						type: "text",
						message: "Enter Cloudflare Access client ID",
					});
					env[CLOUDFLARE_ACCESS_CLIENT_SECRET] = await interaction.prompt({
						type: "secret",
						message: "Enter Cloudflare Access client secret",
					});
				} else if (access === "access-token") {
					env[CLOUDFLARE_ACCESS_TOKEN] = await interaction.prompt({
						type: "secret",
						message: "Enter Cloudflare Access token",
					});
				}
			}

			return key === undefined ? { type: "api_key", env } : { type: "api_key", key, env };
		},
		resolve: async ({ ctx, credential, signal }) => {
			const resolved = await resolveCloudflareGateway(ctx, credential, signal);
			if (!resolved) return undefined;
			return { auth: { headers: resolved.headers }, env: resolved.env, source: resolved.source };
		},
	};
}
