import type { ThinkingLevel } from "@kennyfrc/mu-agent-core";
import type { Api, Model } from "@kennyfrc/mu-ai";

let currentModel: Model<Api> | undefined;
let currentThinkingLevel: ThinkingLevel = "off";

export function setCurrentModel(model: Model<Api>): void {
	currentModel = model;
}

export function getCurrentModel(): Model<Api> | undefined {
	return currentModel;
}

export function setCurrentThinkingLevel(thinkingLevel: ThinkingLevel): void {
	currentThinkingLevel = thinkingLevel;
}

export function getCurrentThinkingLevel(): ThinkingLevel {
	return currentThinkingLevel;
}
