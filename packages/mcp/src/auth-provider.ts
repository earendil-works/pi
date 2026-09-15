import type { McpFetch } from "./streamable-http.ts";

export interface UnauthorizedContext {
	response: Response;
	serverUrl: URL;
	fetch: McpFetch;
}

/** Supplies bearer tokens to an MCP HTTP transport and may refresh them after a 401 response. */
export interface AuthProvider {
	token(): Promise<string | undefined>;
	onUnauthorized?(context: UnauthorizedContext): Promise<void>;
}
