import type { Api, Model } from "@kennyfrc/mu-ai";
import { findModel, getApiKeyForModel } from "../model-config.js";

export const FIREWORKS_THREAD_DERIVATION_MODEL_ID = "accounts/fireworks/routers/kimi-k2p5-turbo";

export interface ThreadDerivationModelResolution {
	model: Model<Api>;
	apiKey: string;
}

async function resolveCredentialedModel(
	model: Model<Api> | null | undefined,
): Promise<ThreadDerivationModelResolution | null> {
	if (!model) return null;

	try {
		const apiKey = await getApiKeyForModel(model);
		if (!apiKey) return null;
		return { model, apiKey };
	} catch {
		return null;
	}
}

export async function getThreadDerivationModel(
	currentModel: Model<Api> | undefined,
): Promise<ThreadDerivationModelResolution | null> {
	const fireworks = findModel("fireworks", FIREWORKS_THREAD_DERIVATION_MODEL_ID).model;
	const preferred = await resolveCredentialedModel(fireworks);
	if (preferred) return preferred;

	return resolveCredentialedModel(currentModel);
}
