import type { ApiKeyAuth, ApiKeyCredential, AuthContext } from "../auth/types.ts";
import type { Api, ImagesApi, ImagesModel, Model, ProviderEnv } from "../types.ts";

const CLOUDFLARE_API_KEY = "CLOUDFLARE_API_KEY";
const CLOUDFLARE_ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID = "CLOUDFLARE_GATEWAY_ID";

type CloudflareAuthKind = "workers-ai" | "ai-gateway";

async function resolveValue(
	name: string,
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<string | undefined> {
	if (credential) {
		if (name === CLOUDFLARE_API_KEY) return credential.key;
		return credential.env?.[name];
	}
	return ctx.env(name);
}

function resolveCloudflareBaseUrl(
	model: Model<Api> | ImagesModel<ImagesApi>,
	accountId: string,
	gatewayId: string | undefined,
): string {
	return model.baseUrl
		.replaceAll(`{${CLOUDFLARE_ACCOUNT_ID}}`, accountId)
		.replaceAll(`{${CLOUDFLARE_GATEWAY_ID}}`, gatewayId ?? "");
}

async function resolveCloudflareEnv(
	kind: CloudflareAuthKind,
	model: Model<Api> | ImagesModel<ImagesApi>,
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<{ apiKey: string; env: ProviderEnv; baseUrl: string; source: string } | undefined> {
	const apiKey = await resolveValue(CLOUDFLARE_API_KEY, ctx, credential);
	const accountId = await resolveValue(CLOUDFLARE_ACCOUNT_ID, ctx, credential);
	const gatewayId = kind === "ai-gateway" ? await resolveValue(CLOUDFLARE_GATEWAY_ID, ctx, credential) : undefined;

	if (!apiKey || !accountId || (kind === "ai-gateway" && !gatewayId)) return undefined;

	return {
		apiKey,
		env: {
			CLOUDFLARE_ACCOUNT_ID: accountId,
			...(gatewayId ? { CLOUDFLARE_GATEWAY_ID: gatewayId } : {}),
		},
		baseUrl: resolveCloudflareBaseUrl(model, accountId, gatewayId),
		source: credential ? "stored credential" : CLOUDFLARE_API_KEY,
	};
}

export function cloudflareWorkersAIAuth(): ApiKeyAuth {
	return {
		name: "Cloudflare API key",
		login: async (callbacks) => {
			const key = await callbacks.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			const accountId = await callbacks.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			return { type: "api_key", key, env: { CLOUDFLARE_ACCOUNT_ID: accountId } };
		},
		resolve: async ({ model, ctx, credential }) => {
			const resolved = await resolveCloudflareEnv("workers-ai", model, ctx, credential);
			if (!resolved) return undefined;
			return {
				auth: { apiKey: resolved.apiKey, baseUrl: resolved.baseUrl },
				env: resolved.env,
				source: resolved.source,
			};
		},
	};
}

export function cloudflareAIGatewayAuth(): ApiKeyAuth {
	return {
		name: "Cloudflare API key",
		login: async (callbacks) => {
			const key = await callbacks.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			const accountId = await callbacks.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			const gatewayId = await callbacks.prompt({ type: "text", message: "Enter Cloudflare AI Gateway ID" });
			return {
				type: "api_key",
				key,
				env: { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_GATEWAY_ID: gatewayId },
			};
		},
		resolve: async ({ model, ctx, credential }) => {
			const resolved = await resolveCloudflareEnv("ai-gateway", model, ctx, credential);
			if (!resolved) return undefined;
			return {
				auth: {
					headers: {
						"cf-aig-authorization": `Bearer ${resolved.apiKey}`,
						Authorization: null,
						"x-api-key": null,
					},
					baseUrl: resolved.baseUrl,
				},
				env: resolved.env,
				source: resolved.source,
			};
		},
	};
}
