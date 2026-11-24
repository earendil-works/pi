import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIDecisionsApi } from "../api/openai-decisions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadGitHubCopilotOAuth } from "../auth/oauth/load.ts";
import type { Credential } from "../auth/types.ts";
import { createProvider, isModelType, type Provider } from "../models.ts";
import type { ProviderClassifier } from "../types.ts";
import { GITHUB_COPILOT_CLASSIFIER_MODELS, GITHUB_COPILOT_MODELS } from "./github-copilot.models.ts";

type GitHubCopilotApi = "anthropic-messages" | "openai-completions" | "openai-responses";

/**
 * Copilot serves its classifier APIs under `/v1` (`/v1/systemone`, `/v1/decisions`), while its chat APIs have
 * no version prefix. The login replaces the catalog base URL with the account's endpoint, so the prefix is added
 * per request.
 */
function copilotV1(classifier: ProviderClassifier): ProviderClassifier {
	return {
		classify: (model, context, options) =>
			classifier.classify({ ...model, baseUrl: `${model.baseUrl.replace(/\/+$/u, "")}/v1` }, context, options),
	};
}

/**
 * The model IDs the OAuth login recorded from the account's `/models` catalog under `key`, or undefined when
 * the credential has no such list (API key auth, or a login from before the list was recorded).
 */
function accountModelIds(
	credential: Credential | undefined,
	key: "availableModelIds" | "availableClassifierModelIds",
): Set<string> | undefined {
	if (credential?.type !== "oauth") return undefined;
	// Stored credentials are read from auth.json.
	const ids = credential[key];
	if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return undefined;
	return new Set(ids);
}

export function githubCopilotProvider(): Provider<GitHubCopilotApi> {
	return createProvider<GitHubCopilotApi>({
		id: "github-copilot",
		name: "GitHub Copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		auth: {
			apiKey: envApiKeyAuth("GitHub Copilot token", ["COPILOT_GITHUB_TOKEN"]),
			oauth: lazyOAuth({ name: "GitHub Copilot", isSubscription: true, load: loadGitHubCopilotOAuth }),
		},
		models: [...Object.values(GITHUB_COPILOT_MODELS), ...Object.values(GITHUB_COPILOT_CLASSIFIER_MODELS)],
		filterModels: (models, credential) => {
			const available = accountModelIds(credential, "availableModelIds");
			return available ? models.filter((model) => available.has(model.id)) : models;
		},
		// Decision models are absent from the account's picker catalog, so the login records them separately.
		filterAllModels: (models, credential) => {
			const chat = accountModelIds(credential, "availableModelIds");
			const classifiers = accountModelIds(credential, "availableClassifierModelIds");
			return models.filter((model) => {
				const available = isModelType(model, "classifier") ? classifiers : chat;
				return !available || available.has(model.id);
			});
		},
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
		classifiers: {
			"openai-decisions": copilotV1(openAIDecisionsApi()),
			"typesafe-system-one": copilotV1(typesafeSystemOneApi()),
		},
	});
}
