import type { JsonRpcId } from "./jsonrpc.ts";

export const LATEST_PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, "2025-03-26"] as const;
export type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

export interface Implementation {
	name: string;
	version: string;
	title?: string;
}

export interface Root {
	uri: string;
	name?: string;
}

export interface ClientCapabilities {
	experimental?: Record<string, unknown>;
	roots?: { listChanged?: boolean };
	sampling?: Record<string, unknown>;
	elicitation?: Record<string, unknown>;
}

export interface ServerCapabilities {
	experimental?: Record<string, unknown>;
	logging?: Record<string, unknown>;
	prompts?: { listChanged?: boolean };
	resources?: { subscribe?: boolean; listChanged?: boolean };
	tools?: { listChanged?: boolean };
	completions?: Record<string, unknown>;
}

export interface InitializeParams {
	protocolVersion: string;
	capabilities: ClientCapabilities;
	clientInfo: Implementation;
}

export interface InitializeResult {
	protocolVersion: string;
	capabilities: ServerCapabilities;
	serverInfo: Implementation;
	instructions?: string;
}

export interface ProgressNotification {
	progressToken: string | number;
	progress: number;
	total?: number;
	message?: string;
}

export interface CancelledNotification {
	requestId: JsonRpcId;
	reason?: string;
}

export interface ToolAnnotations {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface ToolExecution {
	taskSupport?: "forbidden" | "optional" | "required";
}

export interface Tool {
	name: string;
	title?: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: ToolAnnotations;
	execution?: ToolExecution;
	_meta?: Record<string, unknown>;
}

export interface ListToolsResult {
	tools: Tool[];
	nextCursor?: string;
	_meta?: Record<string, unknown>;
}
