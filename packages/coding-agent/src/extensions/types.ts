import type { AgentTool, Message, ToolResultMessage } from "@kennyfrc/mu-ai";
import type { AutocompleteItem } from "@kennyfrc/mu-tui";
import type { TSchema } from "@sinclair/typebox";
import type { ProviderConfig } from "../model-config.js";

/**
 * Tool collections need a type-erased view: tools have heterogeneous parameter schemas,
 * but registries need to store them together.
 */
export type ErasedAgentTool = AgentTool<TSchema, unknown>;

export function eraseAgentTool<TParams extends TSchema, TDetails>(tool: AgentTool<TParams, TDetails>): ErasedAgentTool {
	return tool as unknown as ErasedAgentTool;
}

export interface HookMeta {
	sourceId: string;
	priority?: number;
}

export interface BeforeToolCallEvent {
	toolCallId: string;
	toolName: string;
	args: unknown;
}

export type BeforeToolCallResult =
	| { type: "block"; reason?: string }
	| { type: "patch"; args: unknown }
	| { type: "noop" };

export type BeforeToolCallHook = (
	event: BeforeToolCallEvent,
) => BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>;

export type AfterToolResultHook = (toolResult: ToolResultMessage<unknown>) => ToolResultMessage<unknown> | undefined;

export type ContextHook = (
	messages: Message[],
	abortSignal?: AbortSignal,
) => Message[] | undefined | Promise<Message[] | undefined>;

export type InputHookResult = { type: "handled" } | { type: "transform"; text: string } | { type: "noop" };

export type InputHook = (text: string) => InputHookResult | undefined | Promise<InputHookResult | undefined>;

export interface ToolRegistrationOptions {
	priority?: number;
}

export interface HookRegistrationOptions {
	priority?: number;
}

export interface CommandRegistrationOptions {
	priority?: number;
}

export interface ProviderRegistrationOptions {
	priority?: number;
}

export type ExtensionSessionMessageDisplay = "visible" | "hidden";

export type ExtensionCommandQueueKind = "by-end" | "next";

export type ExtensionCommandPrintColor = "dim" | "accent" | "warning" | "error" | "success";

export interface ExtensionCommandContext {
	/** Send a user message into the agent pipeline (respects queueing when streaming). */
	send(text: string, options?: { kind?: ExtensionCommandQueueKind }): Promise<void>;
	/** Print a line into the chat transcript. */
	print(text: string, options?: { color?: ExtensionCommandPrintColor }): void;
}

export interface ExtensionCommand {
	name: string;
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
	execute: (argString: string, ctx: ExtensionCommandContext) => void | Promise<void>;
}

export interface ExtensionApi {
	/** Register an LLM-callable tool */
	registerTool(tool: ErasedAgentTool, options?: ToolRegistrationOptions): void;

	/** Register a provider + models (overlays built-ins + models.json). */
	registerProvider(providerName: string, config: ProviderConfig, options?: ProviderRegistrationOptions): void;

	/** Transform/prune/inject messages before each LLM call */
	context(hook: ContextHook, options?: HookRegistrationOptions): void;

	/** Register a slash command (e.g. "/hello") */
	registerCommand(command: ExtensionCommand, options?: CommandRegistrationOptions): void;

	/** Transform or handle user input before submission */
	input(hook: InputHook, options?: HookRegistrationOptions): void;

	/** Observe/modify/block a tool call before execution */
	beforeToolCall(hook: BeforeToolCallHook, options?: HookRegistrationOptions): void;

	/** Patch a tool result message before it is appended/sent back to the model */
	afterToolResult(hook: AfterToolResultHook, options?: HookRegistrationOptions): void;

	/** Append a custom (non-LLM) session entry to the current session file. */
	appendSessionEntry(customType: string, data: unknown): void;

	/** Append a custom message entry to the current session file. */
	appendSessionMessage(
		customType: string,
		message: unknown,
		options?: { display?: ExtensionSessionMessageDisplay },
	): void;
}

export type ExtensionFactory = (api: ExtensionApi) => void | Promise<void>;
