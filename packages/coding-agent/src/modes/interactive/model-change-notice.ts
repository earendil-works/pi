import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { VIRTUAL_MODEL_API } from "../../core/virtual-models.ts";

/** Whether a response names the model that produced it. Failed routing leaves the virtual model instead. */
export function hasPhysicalModel(message: AssistantMessage): boolean {
	return message.api !== VIRTUAL_MODEL_API;
}

/**
 * Notice for a response whose model differs from the previous response's, e.g. after routing.
 * Without a previous response, a notice appears only when a virtual model is selected, so routed
 * conversations show their first model too.
 */
export function getModelChangeNotice(
	previous: AssistantMessage | undefined,
	message: AssistantMessage,
	selected: Model<Api> | undefined,
): string | undefined {
	if (!hasPhysicalModel(message)) return undefined;
	const from =
		previous ??
		(selected?.api === VIRTUAL_MODEL_API ? { provider: selected.provider, model: selected.id } : undefined);
	if (!from || (from.provider === message.provider && from.model === message.model)) return undefined;
	const level = message.thinkingLevel ? ` • ${message.thinkingLevel}` : "";
	const change = previous ? `${previous.provider}/${previous.model} → ` : "";
	return `Model: ${change}${message.provider}/${message.model}${level}`;
}
