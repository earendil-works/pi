import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { defineDoc } from "../documents.ts";
import type { ConversationRetryPolicy, ConversationStreamOptions, QueueMode, ToolExecutionMode } from "./types.ts";

/** Durable per-conversation model, thinking level, request options, and desired tool loadout. */
export type ConversationConfigState = {
	model?: { provider: string; modelId: string };
	thinkingLevel: ModelThinkingLevel;
	/** Desired tool names in offered order; names may be unregistered in the current process. */
	activeTools: string[];
	/** Forwarded to every generation request. */
	streamOptions?: ConversationStreamOptions;
	/** Durable generation attempt retries; absent uses `DEFAULT_RETRY_POLICY`. */
	retry?: ConversationRetryPolicy;
	/** Whether a round's tools run at once or in call order; absent means `parallel`. */
	toolExecution?: ToolExecutionMode;
	/** How many queued steers a boundary places; absent means `one-at-a-time`. */
	steeringMode?: QueueMode;
	/** How many queued follow-ups a final boundary places; absent means `one-at-a-time`. */
	followUpMode?: QueueMode;
};

export const DEFAULT_RETRY_POLICY: ConversationRetryPolicy = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	maxAgentDelayMs: 60000,
};

/** Built-in configuration document; rewindable so forks start from the configuration at their fork entry. */
export const ConversationConfig = defineDoc<ConversationConfigState>({
	kind: "pi.conversation.config",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ thinkingLevel: "off", activeTools: [] }),
	checkpointWhen: () => true,
});
