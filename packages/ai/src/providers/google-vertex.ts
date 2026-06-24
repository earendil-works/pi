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
	resolve: async ({ ctx, credential }) => {
		const key = credential?.key ?? (await ctx.env("GOOGLE_CLOUD_API_KEY"));
		if (key) return { auth: { apiKey: key }, source: credential?.key ? "stored credential" : "GOOGLE_CLOUD_API_KEY" };

		const adcPath = await ctx.env("GOOGLE_APPLICATION_CREDENTIALS");
		const hasCredentials = await ctx.fileExists(adcPath ?? VERTEX_ADC_PATH);
		const hasProject = Boolean((await ctx.env("GOOGLE_CLOUD_PROJECT")) ?? (await ctx.env("GCLOUD_PROJECT")));
		const hasLocation = Boolean(await ctx.env("GOOGLE_CLOUD_LOCATION"));
		if (hasCredentials && hasProject && hasLocation) {
			return { auth: {}, source: "gcloud application default credentials" };
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
