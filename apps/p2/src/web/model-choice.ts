// The page's model helpers, shared by the chat's footer and its command menu pages (plugins/chat): a model choice,
// a model's name and thinking levels from the owner's catalog, and the signed-in models the pages list.
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ResourceSnapshot } from "../../plugins/models/contract.ts";

export type ModelChoice = { model: ModelRef; thinkingLevel: ModelThinkingLevel };
type Summary = ResourceSnapshot["models"][number];

export function modelName(resources: ResourceSnapshot | undefined, model: ModelRef | undefined): string {
	if (!model) return "Choose model";
	return (
		resources?.models.find((entry) => entry.provider === model.provider && entry.modelId === model.modelId)?.name ??
		model.modelId
	);
}

export function thinkingLevels(resources: ResourceSnapshot | undefined, model: ModelRef | undefined): string[] {
	return (
		resources?.models.find((entry) => entry.provider === model?.provider && entry.modelId === model?.modelId)
			?.thinkingLevels ?? ["off"]
	);
}

/** Picking `model`: the thinking level stays `thinking` where the model has it, else off. */
export function modelChoice(model: Summary, thinking: ModelThinkingLevel | undefined): ModelChoice {
	return {
		model: { provider: model.provider, modelId: model.modelId },
		thinkingLevel: thinking !== undefined && model.thinkingLevels.includes(thinking) ? thinking : "off",
	};
}

/** The models of the providers the owner signed in to, in the catalog's order. */
export function signedInModels(resources: ResourceSnapshot | undefined): Summary[] {
	const signedIn = new Set(resources?.credentials.map((credential) => credential.providerId));
	return (resources?.models ?? []).filter((model) => signedIn.has(model.provider));
}
