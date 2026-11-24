import type { BlobResourceContents, ContentAnnotations, TextResourceContents } from "./content.ts";
import type { JsonRpcId } from "./jsonrpc.ts";

/**
 * The newest version with the `initialize` handshake ("legacy" in the terms of MCP 2026-07-28), and
 * the one `initialize` asks for by default. The stateless versions are {@link MODERN_PROTOCOL_VERSIONS}.
 */
export const LATEST_PROTOCOL_VERSION = "2025-11-25";
/**
 * Legacy versions the client accepts from a server. Servers that do not support the requested version
 * answer with their own latest one, so older versions stay accepted for servers built on older SDKs.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

/** Whether a version a server sent (wire input) is one of {@link SUPPORTED_PROTOCOL_VERSIONS}. */
export function isSupportedProtocolVersion(version: string): version is SupportedProtocolVersion {
	return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

/**
 * Stateless ("modern") protocol versions, newest first: no `initialize` handshake and no session, every
 * request carries its version and the client's capabilities in `_meta`.
 */
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;
export type ModernProtocolVersion = (typeof MODERN_PROTOCOL_VERSIONS)[number];
export const LATEST_MODERN_PROTOCOL_VERSION: ModernProtocolVersion = MODERN_PROTOCOL_VERSIONS[0];

/** Whether a version read from a message (wire input) is one of {@link MODERN_PROTOCOL_VERSIONS}. */
export function isModernProtocolVersion(version: string): version is ModernProtocolVersion {
	return (MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

/**
 * The protocol a connected client negotiated. `legacy`: the `initialize` handshake (2025-11-25 and
 * earlier). `modern`: per-request metadata (2026-07-28 and later).
 */
export type McpNegotiatedProtocol =
	| { era: "legacy"; version: SupportedProtocolVersion }
	| { era: "modern"; version: ModernProtocolVersion };

/**
 * Which protocol a client speaks to a server. `auto` probes the server with `server/discover` and falls
 * back to `legacy` when the server does not answer like a modern server. A modern version (`2026-07-28`)
 * requires that version and fails otherwise.
 */
export type McpProtocolMode = "auto" | "legacy" | ModernProtocolVersion;

export type LoggingLevel = "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";

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
	/** Optional MCP extensions, by identifier (for example `io.modelcontextprotocol/events`). */
	extensions?: Record<string, Record<string, unknown>>;
}

export interface ServerCapabilities {
	experimental?: Record<string, unknown>;
	logging?: Record<string, unknown>;
	prompts?: { listChanged?: boolean };
	resources?: { subscribe?: boolean; listChanged?: boolean };
	tools?: { listChanged?: boolean };
	completions?: Record<string, unknown>;
	/** Optional MCP extensions, by identifier (for example `io.modelcontextprotocol/events`). */
	extensions?: Record<string, Record<string, unknown>>;
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

/** The answer to `server/discover` (MCP 2026-07-28). */
export interface DiscoverResult {
	supportedVersions: string[];
	capabilities: ServerCapabilities;
	instructions?: string;
	_meta?: Record<string, unknown>;
}

/** A request the server needs answered before it can complete a request (MCP 2026-07-28). */
export interface InputRequest {
	method: string;
	params?: Record<string, unknown>;
}

/** Notification types a `subscriptions/listen` stream delivers (MCP 2026-07-28). */
export interface SubscriptionFilter {
	toolsListChanged?: boolean;
	promptsListChanged?: boolean;
	resourcesListChanged?: boolean;
	resourceSubscriptions?: string[];
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

/** A resource a server lists in `resources/list`. */
export interface Resource {
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
	annotations?: ContentAnnotations;
	_meta?: Record<string, unknown>;
}

/** A family of resources, addressed by an RFC 6570 URI template, from `resources/templates/list`. */
export interface ResourceTemplate {
	uriTemplate: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	annotations?: ContentAnnotations;
	_meta?: Record<string, unknown>;
}

export interface ListResourcesResult {
	resources: Resource[];
	nextCursor?: string;
	_meta?: Record<string, unknown>;
}

export interface ListResourceTemplatesResult {
	resourceTemplates: ResourceTemplate[];
	nextCursor?: string;
	_meta?: Record<string, unknown>;
}

export interface ReadResourceResult {
	contents: (TextResourceContents | BlobResourceContents)[];
	_meta?: Record<string, unknown>;
}
