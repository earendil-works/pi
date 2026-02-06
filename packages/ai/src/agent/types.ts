import type { Static, TSchema } from "@sinclair/typebox";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	UserMessage,
} from "../types.js";

export interface AgentToolResult<T> {
	// Content blocks supporting text and images
	content: (TextContent | ImageContent)[];
	// Details to be displayed in a UI or logged
	details: T;
}

// AgentTool extends Tool but adds the execute function
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	// A human-readable label for the tool to be displayed in UI
	label: string;
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		// Optional callback for streaming progress updates (e.g., bash stdout/stderr)
		onProgress?: (chunk: string) => void,
	) => Promise<AgentToolResult<TDetails>>;
	/**
	 * Returns a resource key for serialization. Tool calls with the same non-null
	 * resource key are executed sequentially (FIFO order). Tool calls with different
	 * keys or undefined/null keys execute in parallel.
	 *
	 * Example: Edit and Write tools return `file:${absolutePath}` to serialize
	 * operations on the same file while allowing parallel operations on different files.
	 */
	getResourceKey?: (params: Static<TParameters>) => string | undefined;
}

// AgentContext is like Context but uses AgentTool
export interface AgentContext {
	systemPrompt: string;
	messages: Message[];
	tools?: AgentTool<any>[];
}

// Event types
export type AgentEvent =
	// Emitted when the agent starts. An agent can emit multiple turns
	| { type: "agent_start" }
	// Emitted when a turn starts. A turn can emit an optional user message (initial prompt), an assistant message (response) and multiple tool result messages
	| { type: "turn_start" }
	// Emitted when a user, assistant or tool result message starts
	| { type: "message_start"; message: Message }
	// Emitted when an assistant message is updated due to streaming
	| { type: "message_update"; assistantMessageEvent: AssistantMessageEvent; message: AssistantMessage }
	// Emitted when a user, assistant or tool result message is complete
	| { type: "message_end"; message: Message }
	// Emitted when a tool execution starts
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	// Emitted when a tool execution produces streaming output (e.g., bash stdout/stderr)
	| { type: "tool_execution_progress"; toolCallId: string; toolName: string; output: string }
	// Emitted when a tool execution completes
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<any> | string;
			isError: boolean;
	  }
	// Emitted when a full turn completes
	| { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
	// Emitted when the agent has completed all its turns. All messages from every turn are
	// contained in messages, which can be appended to the context
	| { type: "agent_end"; messages: AgentContext["messages"] };

// Configuration for agent loop execution
export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;
	preprocessor?: (messages: AgentContext["messages"], abortSignal?: AbortSignal) => Promise<AgentContext["messages"]>;
	/**
	 * Optional hook to inject user messages between a tool-using turn and the continuation LLM call.
	 *
	 * Called after tool execution completes (tool results exist) and before the next assistant
	 * response is generated.
	 */
	interrupt?: (
		args: {
			assistantMessage: AssistantMessage;
			toolResults: ToolResultMessage[];
			messages: AgentContext["messages"];
		},
		abortSignal?: AbortSignal,
	) => Promise<UserMessage[] | undefined | null>;
	/**
	 * Transform tool result messages after they're created but before they're added to context.
	 * Use this to inject additional content (e.g., context usage warnings) into tool results.
	 */
	toolResultTransformer?: (toolResult: ToolResultMessage) => ToolResultMessage;
}
