export const MCPOAuthErrorCode = {
	DynamicRegistrationUnsupported: "MCP_OAUTH_DYNAMIC_REGISTRATION_UNSUPPORTED" as const,
	Generic: "MCP_OAUTH_ERROR" as const,
} as const;

export type MCPOAuthErrorCode = typeof MCPOAuthErrorCode[keyof typeof MCPOAuthErrorCode];

export interface MCPOAuthErrorInfo {
	code: MCPOAuthErrorCode;
	serverName?: string;
	originalMessage: string;
	actionableMessage: string;
}

const DYNAMIC_REGISTRATION_UNSUPPORTED_RE =
	/Incompatible auth server.*does not support dynamic client registration/i;

/**
 * Maps raw MCP OAuth errors to structured, user-actionable errors.
 */
export function mapMcpOAuthError(error: unknown, serverName?: string): MCPOAuthErrorInfo {
	const message = error instanceof Error ? error.message : String(error);

	if (DYNAMIC_REGISTRATION_UNSUPPORTED_RE.test(message)) {
		const actionable = [
			`Failed to authenticate "${serverName ?? "server"}" via OAuth.`,
			``,
			`Reason: The auth server does not support dynamic client registration.`,
			``,
			`Fix:`,
			`1. Use a pre-registered OAuth app for this server:`,
			`   - Set the server's client ID/secret in your Pi config, or`,
			`   - Run \`pi mcp auth-start ${serverName ?? "server"}\` to start a manual device flow.`,
			`2. If you control the MCP server config, ensure clientRegistrationEndpoint is disabled for this server.`,
			``,
			`See docs: https://pi.dev/docs/mcp-auth`,
		].join("\n");

		return {
			code: MCPOAuthErrorCode.DynamicRegistrationUnsupported,
			serverName,
			originalMessage: message,
			actionableMessage: actionable,
		};
	}

	return {
		code: MCPOAuthErrorCode.Generic,
		serverName,
		originalMessage: message,
		actionableMessage: `Failed to authenticate "${serverName ?? "server"}" via OAuth: ${message}`,
	};
}

/**
 * Helper to check if an error is the dynamic registration unsupported case.
 */
export function isDynamicRegistrationUnsupported(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return DYNAMIC_REGISTRATION_UNSUPPORTED_RE.test(message);
}
