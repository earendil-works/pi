export type McpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface UnauthorizedContext {
	/** The 401 response, or a 403 response whose challenge reports `insufficient_scope`. */
	response: Response;
	serverUrl: URL;
	fetch: McpFetch;
	/** Access token the rejected request carried, if any. A different current token means another request already refreshed it. */
	token?: string;
}

/** Supplies bearer tokens to an MCP HTTP transport and may refresh them after a 401 response. */
export interface AuthProvider {
	/**
	 * Token for the next request. May refresh it over the network first, so the transport calls it only
	 * before requests whose answer it waits for. Closing a session reuses the token of the last request.
	 */
	token(): Promise<string | undefined>;
	onUnauthorized?(context: UnauthorizedContext): Promise<void>;
}
