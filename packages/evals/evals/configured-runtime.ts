import { join } from "node:path";
import { type Api, type Context, contentText, type Model, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

type ModelFields = {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
};

export type ProviderRuntimeOutput = {
	result:
		| {
				validRequestReceived: boolean;
				model: ModelFields;
				response: { text: string; stopReason: string; inputTokens: number; outputTokens: number };
		  }
		| { error: string };
};

export type AddedModelOutput = {
	result: { model: ModelFields; existingModelsPreserved: boolean } | { error: string };
};

export type ProviderScenario = {
	providerId: string;
	modelId: string;
	createContext(): Context;
	options?: ModelsSimpleStreamOptions;
	validRequestReceived(): boolean;
};

function modelFields(model: Model<Api>): ModelFields {
	return {
		id: model.id,
		name: model.name,
		provider: model.provider,
		reasoning: model.reasoning,
		input: [...model.input],
		cost: {
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
		},
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

export function loadConfiguredModelRuntime(agentDir: string): Promise<ModelRuntime> {
	return ModelRuntime.create({
		modelsPath: join(agentDir, "models.json"),
		authPath: join(agentDir, "auth.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
	});
}

export async function inspectProvider(
	runtime: ModelRuntime,
	scenario: ProviderScenario,
): Promise<ProviderRuntimeOutput> {
	await runtime.refresh({ allowNetwork: false });
	const configurationError = runtime.getError();
	if (configurationError) return { result: { error: configurationError } };
	const model = runtime.getModel(scenario.providerId, scenario.modelId);
	if (!model) {
		return { result: { error: `Model ${scenario.providerId}/${scenario.modelId} is unavailable after reload.` } };
	}
	try {
		const response = await runtime.completeSimple(model, scenario.createContext(), scenario.options);
		return {
			result: {
				validRequestReceived: scenario.validRequestReceived(),
				model: modelFields(model),
				response: {
					text: contentText(response.content),
					stopReason: response.stopReason,
					inputTokens: response.usage.input,
					outputTokens: response.usage.output,
				},
			},
		};
	} catch (error) {
		return { result: { error: error instanceof Error ? error.message : String(error) } };
	}
}

export async function inspectAddedModel(
	runtime: ModelRuntime,
	providerId: string,
	modelId: string,
): Promise<AddedModelOutput> {
	const pristineRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
	const pristineProvider = pristineRuntime.getProvider(providerId);
	if (!pristineProvider) return { result: { error: `Built-in provider ${providerId} is unavailable.` } };
	const existingModelIds = pristineProvider.getModels().map(({ id }) => id);
	if (existingModelIds.length === 0) {
		return { result: { error: `Built-in provider ${providerId} has no models.` } };
	}
	await runtime.refresh({ allowNetwork: false });
	const configurationError = runtime.getError();
	if (configurationError) return { result: { error: configurationError } };
	const model = runtime.getModel(providerId, modelId);
	if (!model) {
		return { result: { error: `Model ${providerId}/${modelId} is unavailable after reload.` } };
	}
	return {
		result: {
			model: modelFields(model),
			existingModelsPreserved: existingModelIds.every((id) => runtime.getModel(providerId, id) !== undefined),
		},
	};
}
