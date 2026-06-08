import { amazonBedrockMantleOpenAIResponsesApi } from "../api/amazon-bedrock-mantle-openai-responses.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { AMAZON_BEDROCK_MANTLE_OPENAI_RESPONSES_MODELS } from "./amazon-bedrock-mantle-openai-responses.models.ts";

const bedrockMantleAuth: ApiKeyAuth = {
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

export function amazonBedrockMantleOpenAIResponsesProvider(): Provider<"amazon-bedrock-mantle-openai-responses"> {
	return createProvider({
		id: "amazon-bedrock-mantle-openai-responses",
		name: "Amazon Bedrock Mantle",
		auth: { apiKey: bedrockMantleAuth },
		models: Object.values(AMAZON_BEDROCK_MANTLE_OPENAI_RESPONSES_MODELS),
		api: amazonBedrockMantleOpenAIResponsesApi(),
	});
}
