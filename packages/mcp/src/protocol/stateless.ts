// Wire rules of the stateless MCP revision (2026-07-28): request metadata, result types, and the
// `server/discover` result.
import { isObject, JSON_RPC_ERROR_CODES, McpError } from "./jsonrpc.ts";
import type {
	ClientCapabilities,
	DiscoverResult,
	Implementation,
	InputRequest,
	LoggingLevel,
	STATELESS_PROTOCOL_VERSION,
} from "./types.ts";

/** Error code of a request whose `Mcp-*` headers do not match its body (MCP 2026-07-28). */
export const HEADER_MISMATCH_ERROR_CODE = -32020;

/**
 * Error codes MCP 2026-07-28 reserves: header mismatch, missing required client capability, and
 * unsupported protocol version. Only servers of that revision send them.
 */
export const STATELESS_ERROR_CODES: readonly number[] = [HEADER_MISMATCH_ERROR_CODE, -32021, -32022];

/** Whether `error` is an error response only servers of the stateless revision send. */
export function isStatelessRevisionError(error: unknown): boolean {
	return error instanceof McpError && STATELESS_ERROR_CODES.includes(error.code);
}

/** What every stateless request declares about the client in its `_meta`. */
export interface StatelessRequestMeta {
	protocolVersion: typeof STATELESS_PROTOCOL_VERSION;
	clientInfo: Implementation;
	clientCapabilities: ClientCapabilities;
	logLevel: LoggingLevel | undefined;
}

/** `params` with the stateless request metadata added to its `_meta`, keeping the `_meta` keys it has. */
export function withStatelessMeta(
	params: Record<string, unknown> | undefined,
	meta: StatelessRequestMeta,
): Record<string, unknown> {
	return {
		...params,
		_meta: {
			...(isObject(params?._meta) ? params._meta : {}),
			"io.modelcontextprotocol/protocolVersion": meta.protocolVersion,
			"io.modelcontextprotocol/clientInfo": meta.clientInfo,
			"io.modelcontextprotocol/clientCapabilities": meta.clientCapabilities,
			...(meta.logLevel === undefined ? {} : { "io.modelcontextprotocol/logLevel": meta.logLevel }),
		},
	};
}

/** A result of a stateless request, by `resultType`. */
export type StatelessResult =
	| { kind: "complete"; result: unknown }
	| { kind: "input_required"; inputRequests: Record<string, InputRequest>; requestState: string | undefined };

/**
 * Read the `resultType` of a stateless result (wire input). A result without one is complete; unknown
 * result types are invalid.
 */
export function readStatelessResult(method: string, value: unknown): StatelessResult {
	if (!isObject(value)) throw invalid(`Invalid MCP ${method} result`);
	const { resultType, inputRequests, requestState } = value;
	if (resultType === undefined || resultType === "complete") return { kind: "complete", result: value };
	if (resultType !== "input_required") throw invalid(`Unsupported MCP ${method} result type: ${String(resultType)}`);
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

/** Validate a `server/discover` result (wire input), with the server's name and version from its `_meta`. */
export function validateDiscoverResult(value: unknown): { result: DiscoverResult; serverInfo?: Implementation } {
	if (
		!isObject(value) ||
		!Array.isArray(value.supportedVersions) ||
		!value.supportedVersions.every((version) => typeof version === "string") ||
		!isObject(value.capabilities) ||
		(value.instructions !== undefined && typeof value.instructions !== "string")
	) {
		throw invalid("Invalid MCP server/discover result");
	}
	const result = value as unknown as DiscoverResult;
	// Servers SHOULD name themselves, but need not.
	const info = isObject(value._meta) ? value._meta["io.modelcontextprotocol/serverInfo"] : undefined;
	if (!isObject(info) || typeof info.name !== "string" || typeof info.version !== "string") return { result };
	const serverInfo = {
		name: info.name,
		version: info.version,
		...(typeof info.title === "string" ? { title: info.title } : {}),
	};
	return { result, serverInfo };
}

function invalid(message: string): McpError {
	return new McpError(JSON_RPC_ERROR_CODES.invalidRequest, message);
}
