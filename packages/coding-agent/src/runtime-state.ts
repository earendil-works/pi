import type { Api, Model } from "@kennyfrc/mu-ai";

let currentModel: Model<Api> | undefined;

export function setCurrentModel(model: Model<Api>): void {
	currentModel = model;
}

export function getCurrentModel(): Model<Api> | undefined {
	return currentModel;
}
