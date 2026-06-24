import { bedrockConverseStreamApi } from "../api/bedrock-converse-stream.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { AMAZON_BEDROCK_MODELS } from "./amazon-bedrock.models.ts";

/**
 * Bedrock auth is ambient: the AWS SDK's default credential chain handles the
 * actual signing, so `resolve` only reports whether the provider is
 * configured. A stored credential key is surfaced as the bearer token.
 */
const bedrockAuth: ApiKeyAuth = {
	name: "AWS credentials",
	resolve: async ({ ctx, credential }) => {
		if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
		if (await ctx.env("AWS_BEARER_TOKEN_BEDROCK")) return { auth: {}, source: "AWS_BEARER_TOKEN_BEDROCK" };
		if (await ctx.env("AWS_PROFILE")) return { auth: {}, source: "AWS_PROFILE" };
		if ((await ctx.env("AWS_ACCESS_KEY_ID")) && (await ctx.env("AWS_SECRET_ACCESS_KEY"))) {
			return { auth: {}, source: "AWS access keys" };
		}
		if (await ctx.env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")) return { auth: {}, source: "ECS task role" };
		if (await ctx.env("AWS_CONTAINER_CREDENTIALS_FULL_URI")) return { auth: {}, source: "ECS task role" };
		if (await ctx.env("AWS_WEB_IDENTITY_TOKEN_FILE")) return { auth: {}, source: "web identity token" };
		return undefined;
	},
};

export function amazonBedrockProvider(): Provider<"bedrock-converse-stream"> {
	return createProvider({
		id: "amazon-bedrock",
		name: "Amazon Bedrock",
		auth: { apiKey: bedrockAuth },
		models: Object.values(AMAZON_BEDROCK_MODELS),
		api: bedrockConverseStreamApi(),
	});
}
