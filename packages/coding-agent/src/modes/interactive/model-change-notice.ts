import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { isVirtualModel } from "../../core/virtual-models.ts";

/** Whether `message` is a response that names the physical model that produced it. */
export function isPhysicalResponse(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && !isVirtualModel(message);
}

/**
 * Notice for a response whose model differs from the previous response's, e.g. after routing.
 * Without a previous response, only a virtual selection gets a notice, so routed conversations
 * show their first model too.
 */
export function getModelChangeNotice(
	previous: AssistantMessage | undefined,
	message: AssistantMessage,
	selected: Model<Api> | undefined,
): string | undefined {
	if (isVirtualModel(message)) return undefined;
	const from =
		previous ??
		(selected && isVirtualModel(selected) ? { provider: selected.provider, model: selected.id } : undefined);
	if (!from || (from.provider === message.provider && from.model === message.model)) return undefined;
	const level = message.thinkingLevel ? ` • ${message.thinkingLevel}` : "";
	const change = previous ? `${previous.provider}/${previous.model} → ` : "";
	return `Model: ${change}${message.provider}/${message.model}${level}`;
}
