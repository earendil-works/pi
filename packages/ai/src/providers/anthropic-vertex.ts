import { anthropicVertexApi } from "../api/anthropic-vertex.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { ANTHROPIC_VERTEX_MODELS } from "./anthropic-vertex.models.ts";

const VERTEX_ADC_PATH = "~/.config/gcloud/application_default_credentials.json";

/** Anthropic Vertex uses ambient Google Application Default Credentials only. */
const anthropicVertexAuth: ApiKeyAuth = {
	name: "Google Cloud credentials",
	check: async ({ ctx, credential, signal }) => {
		const readEnv = async (name: string) => {
			signal.throwIfAborted();
			const value = await ctx.env(name);
			signal.throwIfAborted();
			return value;
		};
		const env = credential?.env;
		const adcPath = env?.GOOGLE_APPLICATION_CREDENTIALS ?? (await readEnv("GOOGLE_APPLICATION_CREDENTIALS"));
		signal.throwIfAborted();
		const hasCredentials = await ctx.fileExists(adcPath ?? VERTEX_ADC_PATH);
		signal.throwIfAborted();
		const hasProject = Boolean(
			env?.ANTHROPIC_VERTEX_PROJECT_ID ||
				env?.GOOGLE_CLOUD_PROJECT ||
				env?.GCLOUD_PROJECT ||
				(await readEnv("ANTHROPIC_VERTEX_PROJECT_ID")) ||
				(await readEnv("GOOGLE_CLOUD_PROJECT")) ||
				(await readEnv("GCLOUD_PROJECT")),
		);
		if (!hasCredentials && !hasProject) return undefined;
		return {
			type: "api_key",
			source: credential
				? "stored credential"
				: hasCredentials
					? "Google Application Default Credentials"
					: "Google Cloud environment",
		};
	},
	resolve: async ({ credential, signal }) => {
		signal.throwIfAborted();
		// ADC discovery is broader than local files and project environment variables:
		// on Google Cloud it can resolve an attached service account through the metadata
		// server. Keep availability checks conservative, but let the official SDK perform
		// the full request-time credential chain.
		// https://cloud.google.com/docs/authentication/application-default-credentials
		return {
			auth: {},
			env: credential?.env,
			source: credential ? "stored credential" : "Google Application Default Credentials",
		};
	},
};

export function anthropicVertexProvider(): Provider<"anthropic-vertex"> {
	return createProvider({
		id: "anthropic-vertex",
		name: "Anthropic Vertex AI",
		auth: { apiKey: anthropicVertexAuth },
		models: Object.values(ANTHROPIC_VERTEX_MODELS),
		api: anthropicVertexApi(),
	});
}
