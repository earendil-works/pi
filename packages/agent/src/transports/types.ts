import type { AgentEvent, AgentLoopConfig, AgentTool, Message, Model, ToolResultMessage } from "@kennyfrc/mu-ai";

/**
 * The minimal configuration needed to run an agent turn.
 */
export interface AgentRunConfig {
	systemPrompt: string;
	tools: AgentTool<any>[];
	model: Model<any>;
	reasoning?: "low" | "medium" | "high" | "xhigh";
	fastMode?: boolean;
	/**
	 * Transform/prune/inject messages before each LLM call within a multi-turn run.
	 * Passed through to @kennyfrc/mu-ai's AgentLoopConfig.preprocessor.
	 */
	preprocessor?: AgentLoopConfig["preprocessor"];
	/**
	 * Optional hook to inject user messages between a tool-using turn and the continuation LLM call.
	 * Used by steering messages (/steer) that are queued with kind "next".
	 */
	interrupt?: AgentLoopConfig["interrupt"];
	/**
	 * Transform tool result messages after they're created but before they're added to context.
	 * Use this to inject additional content (e.g., context usage warnings) into tool results.
	 */
	toolResultTransformer?: (toolResult: ToolResultMessage) => ToolResultMessage;
}

/**
 * Transport interface for executing agent turns.
 * Transports handle the communication with LLM providers,
 * abstracting away the details of API calls, proxies, etc.
 *
 * Events yielded must match the @kennyfrc/mu-ai AgentEvent types.
 */
export interface AgentTransport {
	run(
		messages: Message[],
		userMessage: Message,
		config: AgentRunConfig,
		signal?: AbortSignal,
	): AsyncIterable<AgentEvent>;
}
