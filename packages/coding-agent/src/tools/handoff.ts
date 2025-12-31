import type { AgentTool, AssistantMessage, Message, Model, TextContent, ToolCall } from "@kennyfrc/pi-ai";
import { complete } from "@kennyfrc/pi-ai";
import { Type } from "@sinclair/typebox";
import { getHandoffPrompt } from "../prompts/index.js";

/**
 * Data passed from the handoff tool to the TUI callback
 */
export interface HandoffData {
	goal: string;
	summary: string;
	parentSessionId: string;
}

/**
 * Context passed to the handoff tool at execution time
 */
export interface HandoffToolContext {
	model: Model<"anthropic-messages" | "openai-completions" | "openai-responses" | "google-generative-ai">;
	apiKey: string;
	messages: Message[];
	sessionId: string;
	onHandoff: (data: HandoffData) => Promise<void>;
}

const handoffSchema = Type.Object({
	goal: Type.String({
		description: "Clear description of what to accomplish in the new session",
	}),
});

/**
 * Format messages for the handoff summary generation
 */
function formatMessagesForHandoff(messages: Message[]): string {
	return messages
		.map((msg) => {
			if (msg.role === "user") {
				const content = msg.content as Array<{ type: string; text?: string }>;
				const text = content
					.filter((c) => c.type === "text")
					.map((c) => c.text || "")
					.join("");
				return `User: ${text}`;
			} else if (msg.role === "assistant") {
				const assistantMsg = msg as AssistantMessage;
				const textParts = assistantMsg.content
					.filter((c): c is TextContent => c.type === "text")
					.map((c) => c.text)
					.join("");
				const toolCalls = assistantMsg.content
					.filter((c): c is ToolCall => c.type === "toolCall")
					.map((c) => `[Tool: ${c.name}]`)
					.join(" ");
				return `Assistant: ${textParts}${toolCalls ? "\n" + toolCalls : ""}`;
			} else if (msg.role === "toolResult") {
				const toolResult = msg as {
					role: "toolResult";
					toolName?: string;
					content: Array<{ type: string; text?: string }>;
				};
				const text = toolResult.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("");
				const truncated = text.length > 500 ? text.substring(0, 500) + "..." : text;
				return `Tool (${toolResult.toolName || "unknown"}): ${truncated}`;
			}
			return "";
		})
		.filter((line) => line.length > 0)
		.join("\n\n");
}

/**
 * Create a handoff tool with the given context provider
 * The context provider is called at execution time to get current state
 * It can be sync or async to support lazy API key resolution
 */
export function createHandoffTool(
	getContext: () => HandoffToolContext | null | Promise<HandoffToolContext | null>,
): AgentTool<typeof handoffSchema> {
	return {
		name: "handoff",
		label: "Handoff",
		description: `Create a new focused session to continue work when context budget is exhausted.
Use this tool when instructed that context budget is critical.
Provide a clear, specific goal describing what needs to be accomplished in the new session.`,
		parameters: handoffSchema,
		execute: async (_toolCallId, params, signal) => {
			const context = await getContext();
			if (!context) {
				return {
					content: [{ type: "text" as const, text: "Handoff not available in this context" }],
					details: { error: "No context available" },
				};
			}

			const { goal } = params;
			const { model, apiKey, messages, sessionId, onHandoff } = context;

			try {
				// Generate handoff summary
				const historyText = formatMessagesForHandoff(messages);
				const systemPrompt = getHandoffPrompt(goal);

				const result = await complete(
					model,
					{
						systemPrompt,
						messages: [
							{
								role: "user" as const,
								content: [{ type: "text" as const, text: historyText }],
								timestamp: Date.now(),
							},
						],
						tools: [],
					},
					{ apiKey, signal },
				);

				if (result.stopReason === "error" || result.stopReason === "aborted") {
					return {
						content: [
							{
								type: "text" as const,
								text: `Failed to generate handoff summary: ${result.errorMessage || result.stopReason}`,
							},
						],
						details: { error: result.errorMessage || result.stopReason },
					};
				}

				const summary = result.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("");

				if (!summary.trim()) {
					return {
						content: [{ type: "text" as const, text: "Generated handoff summary is empty" }],
						details: { error: "Empty summary" },
					};
				}

				// Trigger the handoff via callback
				// This will abort the agent, so our return value is effectively ignored
				await onHandoff({
					goal,
					summary,
					parentSessionId: sessionId,
				});

				// This return is ignored since the agent is aborted by the callback
				return {
					content: [{ type: "text" as const, text: "Handoff initiated successfully" }],
					details: { goal, sessionId },
				};
			} catch (err: unknown) {
				const error = err as Error;
				if (error.name === "AbortError") {
					return {
						content: [{ type: "text" as const, text: "Handoff was cancelled" }],
						details: { error: "Aborted" },
					};
				}
				return {
					content: [{ type: "text" as const, text: `Handoff failed: ${error.message}` }],
					details: { error: error.message },
				};
			}
		},
	};
}
