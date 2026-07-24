import { bedrockConverseStreamApi } from "../api/bedrock-converse-stream.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { AMAZON_BEDROCK_MODELS } from "./amazon-bedrock.models.ts";

/**
 * Bedrock accepts a bearer token or the AWS SDK's default credential chain.
 * The login flow can store a token/profile choice; resolve also detects ambient
 * AWS credentials without copying them into pi's credential store.
 */
const bedrockAuth: ApiKeyAuth = {
	name: "AWS credentials or bearer token",
	login: async (interaction) => {
		const method = await interaction.prompt({
			type: "select",
			message: "Select Amazon Bedrock authentication method:",
			options: [
				{ id: "bearer-token", label: "Bearer token" },
				{ id: "aws-profile", label: "AWS profile" },
				{ id: "credential-chain", label: "Existing AWS credential chain" },
			],
		});
		if (method === "bearer-token") {
			return {
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter Amazon Bedrock bearer token" }),
			};
		}
		interaction.notify({
			type: "info",
			message: "Amazon Bedrock supports AWS profiles, IAM credentials, and role-based credentials.",
			links: [
				{
					label: "AWS credential provider chain",
					url: "https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html",
				},
			],
		});
		if (method === "aws-profile") {
			return {
				type: "api_key",
				env: { AWS_PROFILE: await interaction.prompt({ type: "text", message: "Enter AWS profile name" }) },
			};
		}
		if (method !== "credential-chain") throw new Error(`Unknown Amazon Bedrock auth method: ${method}`);
		await interaction.prompt({
			type: "text",
			message: "Configure AWS credentials, then press Enter to continue",
		});
		return { type: "api_key" };
	},
	resolve: async ({ ctx, credential }) => {
		if (credential?.key) {
			return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
		}
		if (await ctx.env("AWS_BEARER_TOKEN_BEDROCK")) return { auth: {}, source: "AWS_BEARER_TOKEN_BEDROCK" };
		if (credential?.env?.AWS_PROFILE ?? (await ctx.env("AWS_PROFILE"))) {
			return {
				auth: {},
				env: credential?.env,
				source: credential?.env?.AWS_PROFILE ? "stored credential" : "AWS_PROFILE",
			};
		}
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
