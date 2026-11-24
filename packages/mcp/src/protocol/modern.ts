// Wire rules of the stateless MCP revisions (2026-07-28 and later): request metadata, result types,
// the errors that identify a modern server, and the `server/discover` result.
import { isObject, JSON_RPC_ERROR_CODES, MCP_ERROR_CODES, McpError } from "./jsonrpc.ts";
import {
	type ClientCapabilities,
	type DiscoverResult,
	type Implementation,
	type InputRequest,
	type LoggingLevel,
	MODERN_PROTOCOL_VERSIONS,
	type ModernProtocolVersion,
	type SubscriptionFilter,
} from "./types.ts";

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_LOG_LEVEL = "io.modelcontextprotocol/logLevel";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
export const META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

/** What every modern request declares about the client in its `_meta`. */
export interface ModernRequestMeta {
	protocolVersion: ModernProtocolVersion;
	clientInfo: Implementation;
	clientCapabilities: ClientCapabilities;
	logLevel: LoggingLevel | undefined;
}

/** `params` with the modern request metadata added to its `_meta`, keeping the `_meta` keys it has. */
export function withModernMeta(
	params: Record<string, unknown> | undefined,
	meta: ModernRequestMeta,
): Record<string, unknown> {
	return {
		...params,
		_meta: {
			...(isObject(params?._meta) ? params._meta : {}),
			[META_PROTOCOL_VERSION]: meta.protocolVersion,
			[META_CLIENT_INFO]: meta.clientInfo,
			[META_CLIENT_CAPABILITIES]: meta.clientCapabilities,
			...(meta.logLevel === undefined ? {} : { [META_LOG_LEVEL]: meta.logLevel }),
		},
	};
}

/**
 * A result of a modern request, by `resultType`. A result without `resultType` is complete: servers of
 * earlier revisions do not send it.
 */
export type ModernResult =
	| { kind: "complete"; result: Record<string, unknown> }
	| { kind: "input_required"; inputRequests: Record<string, InputRequest>; requestState: string | undefined };

/** Read the `resultType` of a modern result (wire input). Unknown result types are invalid. */
export function readModernResult(method: string, value: unknown): ModernResult {
	if (!isObject(value)) throw invalid(`Invalid MCP ${method} result`);
	const { resultType } = value;
	if (resultType === undefined || resultType === "complete") return { kind: "complete", result: value };
	if (resultType !== "input_required") throw invalid(`Unsupported MCP ${method} result type: ${String(resultType)}`);
	const { inputRequests, requestState } = value;
	if (inputRequests !== undefined && !isInputRequests(inputRequests)) {
		throw invalid(`Invalid input requests in MCP ${method} result`);
	}
	if (requestState !== undefined && typeof requestState !== "string") {
		throw invalid(`Invalid request state in MCP ${method} result`);
	}
	if (inputRequests === undefined && requestState === undefined) {
		throw invalid(`MCP ${method} result requires input but names neither input requests nor request state`);
	}
	return { kind: "input_required", inputRequests: inputRequests ?? {}, requestState };
}

function isInputRequests(value: unknown): value is Record<string, InputRequest> {
	if (!isObject(value)) return false;
	return Object.values(value).every(
		(request) =>
			isObject(request) &&
			typeof request.method === "string" &&
			(request.params === undefined || isObject(request.params)),
	);
}

/**
 * Whether an error response identifies a server that speaks a modern revision: the error codes
 * 2026-07-28 reserves. Any other error from a `server/discover` probe identifies a legacy server.
 */
export function isModernProtocolError(error: McpError): boolean {
	return (
		error.code === MCP_ERROR_CODES.headerMismatch ||
		error.code === MCP_ERROR_CODES.missingRequiredClientCapability ||
		(error.code === MCP_ERROR_CODES.unsupportedProtocolVersion && supportedVersions(error) !== undefined)
	);
}

/** The versions an `UnsupportedProtocolVersionError` lists as supported (wire input). */
export function supportedVersions(error: McpError): string[] | undefined {
	if (error.code !== MCP_ERROR_CODES.unsupportedProtocolVersion || !isObject(error.data)) return undefined;
	const { supported } = error.data;
	return Array.isArray(supported) && supported.every((version) => typeof version === "string") ? supported : undefined;
}

/** The newest of `clientVersions` (default: every modern version) that the server supports. */
export function mutualModernVersion(
	serverVersions: readonly string[],
	clientVersions: readonly ModernProtocolVersion[] = MODERN_PROTOCOL_VERSIONS,
): ModernProtocolVersion | undefined {
	return clientVersions.find((version) => serverVersions.includes(version));
}

/** A validated `server/discover` result, and the server's name and version from it. */
export interface DiscoveredServer {
	result: DiscoverResult;
	serverInfo: Implementation | undefined;
}

/** Validate a `server/discover` result (wire input). */
export function validateDiscoverResult(value: unknown): DiscoveredServer {
	if (
		!isObject(value) ||
		!Array.isArray(value.supportedVersions) ||
		!value.supportedVersions.every((version) => typeof version === "string") ||
		!isObject(value.capabilities) ||
		(value.instructions !== undefined && typeof value.instructions !== "string")
	) {
		throw invalid("Invalid MCP server/discover result");
	}
	return { result: value as unknown as DiscoverResult, serverInfo: serverInfoOf(value) };
}

/**
 * The server's name and version from a result's `_meta`. Some servers put `serverInfo` next to the
 * result fields instead; it is accepted there too.
 */
function serverInfoOf(result: Record<string, unknown>): Implementation | undefined {
	const meta = isObject(result._meta) ? result._meta : {};
	for (const candidate of [meta[META_SERVER_INFO], result.serverInfo]) {
		if (!isObject(candidate)) continue;
		const { name, version, title } = candidate;
		if (typeof name === "string" && typeof version === "string") {
			return { name, version, ...(typeof title === "string" ? { title } : {}) };
		}
	}
	return undefined;
}

const SUBSCRIPTION_FLAGS = ["toolsListChanged", "promptsListChanged", "resourcesListChanged"] as const;

/**
 * The notification types a `notifications/subscriptions/acknowledged` agrees to (wire input). Fields of
 * the wrong type are left out.
 */
export function readSubscriptionFilter(value: unknown): SubscriptionFilter {
	if (!isObject(value)) return {};
	const filter: SubscriptionFilter = {};
	for (const key of SUBSCRIPTION_FLAGS) {
		const flag = value[key];
		if (typeof flag === "boolean") filter[key] = flag;
	}
	const uris = value.resourceSubscriptions;
	if (Array.isArray(uris) && uris.every((uri) => typeof uri === "string")) filter.resourceSubscriptions = uris;
	return filter;
}

function invalid(message: string): McpError {
	return new McpError(JSON_RPC_ERROR_CODES.invalidRequest, message);
}
