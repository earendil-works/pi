import type { Api, AssistantMessage, Model, ToolCall, ToolResultMessage, Usage } from "@kennyfrc/mu-ai";

export const SUBSCRIPTION_TOOL_NAME = "SubscriptionUpdate";

export interface BuildSubscriptionResultParams {
	sessionId: string;
	assistantMessage: AssistantMessage;
}

export interface SubscriptionToolMessageParams {
	toolCallId: string;
	model: Model<Api>;
	assistantMessage: AssistantMessage;
	sessionId: string;
	now?: number;
}

export interface SubscriptionToolMessages {
	assistantToolCallMessage: AssistantMessage;
	toolResultMessage: ToolResultMessage;
}

export function buildSubscriptionResultText({ sessionId, assistantMessage }: BuildSubscriptionResultParams): string {
	const textParts = assistantMessage.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
	const summary = textParts.trim().length > 0 ? textParts.trim() : "[no text output]";

	return [
		`Subscription update from ${sessionId}`,
		`Stop reason: ${assistantMessage.stopReason}`,
		`Timestamp: ${assistantMessage.timestamp}`,
		"",
		summary,
	].join("\n");
}

function createZeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

export function createSubscriptionToolMessages({
	toolCallId,
	model,
	assistantMessage,
	sessionId,
	now,
}: SubscriptionToolMessageParams): SubscriptionToolMessages {
	const timestamp = now ?? Date.now();
	const toolCall: ToolCall = {
		type: "toolCall",
		id: toolCallId,
		name: SUBSCRIPTION_TOOL_NAME,
		arguments: {
			sessionId,
			stopReason: assistantMessage.stopReason,
			timestamp: assistantMessage.timestamp,
		},
	};

	const assistantToolCallMessage: AssistantMessage = {
		role: "assistant",
		content: [toolCall],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createZeroUsage(),
		stopReason: "toolUse",
		timestamp,
	};

	const toolResultText = buildSubscriptionResultText({ sessionId, assistantMessage });
	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName: SUBSCRIPTION_TOOL_NAME,
		content: [{ type: "text", text: toolResultText }],
		isError: false,
		timestamp,
	};

	return { assistantToolCallMessage, toolResultMessage };
}
