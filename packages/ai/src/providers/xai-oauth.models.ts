// Derived from xai.models.ts for the SuperGrok OAuth provider surface.
// Keep model metadata aligned with the API-key xAI catalog.

import type { Model } from "../types.ts";
import { XAI_MODELS } from "./xai.models.ts";

function asXaiOauthModel(model: Model<"openai-completions">): Model<"openai-completions"> {
	return {
		...model,
		provider: "xai-oauth",
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			...(model.compat ?? {}),
		},
	} satisfies Model<"openai-completions">;
}

export const XAI_OAUTH_MODELS = Object.fromEntries(
	Object.entries(XAI_MODELS).map(([id, model]) => [id, asXaiOauthModel(model)]),
) as {
	[K in keyof typeof XAI_MODELS]: Model<"openai-completions">;
};
