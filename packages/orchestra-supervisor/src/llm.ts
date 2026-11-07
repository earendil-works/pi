// LLM wiring via Pi provider layer (Models). Tests use fauxProvider; prod uses real provider.
import type { Model } from "@earendil-works/pi-ai";
import { type createModels, normalizeContext } from "@earendil-works/pi-ai";

export interface LlmCall {
	modelId: string;
	system: string;
	user: string;
}

export async function callLlmViaModels(
	models: ReturnType<typeof createModels>,
	model: Model<string>,
	system: string,
	user: string,
): Promise<string> {
	const context = normalizeContext({
		systemPrompt: system,
		messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() } as never],
	});
	const stream = await models.streamSimple(model, context, {});
	const result = await stream.result();
	return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

export async function callLlmFaux(modelId: string, system: string, user: string, scripted: string): Promise<string> {
	// Deterministic test path: returns scripted output (no provider call). Caller validates JSON.
	void modelId;
	void system;
	void user;
	return scripted;
}
