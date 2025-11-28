import type { AgentEvent, AgentTool, Message, Model } from "@mariozechner/pi-ai";

// The minimal configuration needed to run a turn.
export interface AgentRunConfig {
	systemPrompt: string;
	tools: AgentTool<any>[];
	model: Model<any>;
	reasoning?: "low" | "medium" | "high";
}

// Events yielded by transports must match the @mariozechner/pi-ai prompt() events.
// We re-export the Message type above; consumers should use the upstream AgentEvent type.

export interface AgentTransport {
	run(
		messages: Message[],
		userMessage: Message,
		config: AgentRunConfig,
		signal?: AbortSignal,
	): AsyncIterable<AgentEvent>; // passthrough of AgentEvent from upstream
}
