import type { AgentTool, AssistantMessage, AssistantMessageEvent, Message, Model, UserMessage } from "@kennyfrc/mu-ai";

/**
 * Attachment type definition.
 * Processing is done by consumers (e.g., document extraction in web-ui).
 */
export interface Attachment {
	id: string;
	type: "image" | "document";
	fileName: string;
	mimeType: string;
	size: number;
	content: string; // base64 encoded (without data URL prefix)
	extractedText?: string; // For documents
	preview?: string; // base64 image preview
}

/**
 * Thinking/reasoning level for models that support it.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * User message with optional attachments.
 */
export type UserMessageWithAttachments = UserMessage & { attachments?: Attachment[] };

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@kennyfrc/mu-agent-core" {
 *   interface CustomMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomMessages {
	// Empty by default - apps extend via declaration merging
}

/**
 * AppMessage: Union of LLM messages + attachments + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AppMessage =
	| AssistantMessage
	| UserMessageWithAttachments
	| Message // Includes ToolResultMessage
	| CustomMessages[keyof CustomMessages];

/**
 * Agent state containing all configuration and conversation data.
 */
export interface AgentState {
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool<any>[];
	messages: AppMessage[]; // Can include attachments + custom message types
	isStreaming: boolean;
	streamMessage: Message | null;
	pendingToolCalls: Set<string>;
	error?: string;
}

/**
 * Events emitted by the Agent for UI updates.
 * These events provide fine-grained lifecycle information for messages, turns, and tool executions.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AppMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AppMessage; toolResults: AppMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AppMessage }
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AppMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AppMessage }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	// Emitted when a tool execution produces streaming output (e.g., bash stdout/stderr)
	| { type: "tool_execution_progress"; toolCallId: string; toolName: string; output: string }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
