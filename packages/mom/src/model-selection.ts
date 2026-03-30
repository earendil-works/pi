import type { Model } from "@mariozechner/pi-ai";
import type { ModelRegistry, SettingsManager } from "@mariozechner/pi-coding-agent";

export interface ResolvedMomModel {
	provider: string;
	modelId: string;
	model: Model<any>;
	source: "env" | "settings" | "available";
}

export function resolveMomStartupModel(
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): ResolvedMomModel {
	const configuredModel = process.env.MOM_MODEL?.trim();
	if (configuredModel) {
		const { provider, modelId } = parseMomModel(configuredModel);
		const model = resolveConfiguredModel(modelRegistry, provider, modelId, `MOM_MODEL=${configuredModel}`);
		assertConfiguredAuth(modelRegistry, model, `MOM_MODEL=${configuredModel}`);
		return { provider, modelId, model, source: "env" };
	}

	const defaultProvider = settingsManager.getDefaultProvider();
	const defaultModel = settingsManager.getDefaultModel();
	if (defaultProvider && defaultModel) {
		const model = resolveConfiguredModel(modelRegistry, defaultProvider, defaultModel, "workspace .pi/settings.json");
		assertConfiguredAuth(modelRegistry, model, "workspace .pi/settings.json");
		return {
			provider: defaultProvider,
			modelId: defaultModel,
			model,
			source: "settings",
		};
	}

	const availableModels = modelRegistry.getAvailable();
	if (availableModels.length === 0) {
		throw new Error(
			"No available models configured for mom. Set MOM_MODEL=provider:model or configure provider auth.",
		);
	}

	const model = availableModels[0];
	return {
		provider: model.provider,
		modelId: model.id,
		model,
		source: "available",
	};
}

function parseMomModel(configuredModel: string): { provider: string; modelId: string } {
	const separatorIndex = configuredModel.indexOf(":");
	if (separatorIndex <= 0 || separatorIndex === configuredModel.length - 1) {
		throw new Error(`Invalid MOM_MODEL format: ${configuredModel}. Expected provider:model`);
	}

	const provider = configuredModel.slice(0, separatorIndex).trim();
	const modelId = configuredModel.slice(separatorIndex + 1).trim();
	if (!provider || !modelId) {
		throw new Error(`Invalid MOM_MODEL format: ${configuredModel}. Expected provider:model`);
	}

	return { provider, modelId };
}

function resolveConfiguredModel(
	modelRegistry: ModelRegistry,
	provider: string,
	modelId: string,
	sourceLabel: string,
): Model<any> {
	const model = modelRegistry.find(provider, modelId);
	if (model) {
		return model;
	}

	const hasProvider = modelRegistry.getAll().some((candidate) => candidate.provider === provider);
	if (!hasProvider) {
		throw new Error(`Unknown model provider in ${sourceLabel}: ${provider}`);
	}

	throw new Error(`Unknown model ID in ${sourceLabel}: ${provider}:${modelId}`);
}

function assertConfiguredAuth(modelRegistry: ModelRegistry, model: Model<any>, sourceLabel: string): void {
	if (modelRegistry.hasConfiguredAuth(model)) {
		return;
	}

	throw new Error(`No API key configured for ${model.provider}:${model.id} selected from ${sourceLabel}`);
}
