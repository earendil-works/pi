import { googleVertexApi } from "../api/google-vertex.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { GOOGLE_VERTEX_MODELS } from "./google-vertex.models.ts";

const VERTEX_ADC_PATH = "~/.config/gcloud/application_default_credentials.json";

/**
 * Vertex accepts an explicit API key or Application Default Credentials
 * (`gcloud auth application-default login`). ADC additionally requires
 * project and location env vars, which the implementation reads itself.
 */
const vertexAuth: ApiKeyAuth = {
	name: "Google Cloud credentials",
	login: async (interaction) => {
		const method = await interaction.prompt({
			type: "select",
			message: "Select Google Vertex AI authentication method:",
			options: [
				{ id: "api-key", label: "Google Cloud API key" },
				{ id: "adc", label: "Application Default Credentials" },
				{ id: "service-account", label: "Service account credentials file" },
			],
		});
		if (method === "api-key") {
			return {
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter Google Cloud API key" }),
			};
		}
		if (method !== "adc" && method !== "service-account") {
			throw new Error(`Unknown Google Vertex AI auth method: ${method}`);
		}
		interaction.notify({
			type: "info",
			message:
				method === "adc"
					? "Run `gcloud auth application-default login`, then provide the project and location."
					: "Provide a service account credentials file, project, and location.",
			links: [
				{
					label: "Application Default Credentials",
					url: "https://cloud.google.com/docs/authentication/provide-credentials-adc",
				},
			],
		});
		const project = await interaction.prompt({ type: "text", message: "Enter Google Cloud project ID" });
		const location = await interaction.prompt({ type: "text", message: "Enter Google Cloud location" });
		const credentialsPath =
			method === "service-account"
				? await interaction.prompt({ type: "text", message: "Enter service account credentials file path" })
				: undefined;
		return {
			type: "api_key",
			env: {
				GOOGLE_CLOUD_PROJECT: project,
				GOOGLE_CLOUD_LOCATION: location,
				...(credentialsPath ? { GOOGLE_APPLICATION_CREDENTIALS: credentialsPath } : {}),
			},
		};
	},
	resolve: async ({ ctx, credential }) => {
		const key = credential?.key ?? (await ctx.env("GOOGLE_CLOUD_API_KEY"));
		if (key) return { auth: { apiKey: key }, source: credential?.key ? "stored credential" : "GOOGLE_CLOUD_API_KEY" };

		const adcPath =
			credential?.env?.GOOGLE_APPLICATION_CREDENTIALS ?? (await ctx.env("GOOGLE_APPLICATION_CREDENTIALS"));
		const hasCredentials = await ctx.fileExists(adcPath ?? VERTEX_ADC_PATH);
		const project =
			credential?.env?.GOOGLE_CLOUD_PROJECT ??
			(await ctx.env("GOOGLE_CLOUD_PROJECT")) ??
			(await ctx.env("GCLOUD_PROJECT"));
		const location = credential?.env?.GOOGLE_CLOUD_LOCATION ?? (await ctx.env("GOOGLE_CLOUD_LOCATION"));
		if (hasCredentials && project && location) {
			return {
				auth: {},
				env: credential?.env,
				source: credential ? "stored credential" : "gcloud application default credentials",
			};
		}
		return undefined;
	},
};

export function googleVertexProvider(): Provider<"google-vertex"> {
	return createProvider({
		id: "google-vertex",
		name: "Google Vertex AI",
		auth: { apiKey: vertexAuth },
		models: Object.values(GOOGLE_VERTEX_MODELS),
		api: googleVertexApi(),
	});
}
