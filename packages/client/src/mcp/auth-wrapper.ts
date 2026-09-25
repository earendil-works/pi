import { mapMcpOAuthError, MCPOAuthErrorCode } from "./oauth-errors.js";

/**
 * Example wrapper around an MCP server authentication call.
 * Replace `performAuth` with the actual MCP SDK call.
 */
export async function authenticateMcpServer(serverName: string, performAuth: () => Promise<void>) {
	try {
		await performAuth();
	} catch (err) {
		const mapped = mapMcpOAuthError(err, serverName);
		// In interactive mode, print actionable message.
		console.error(mapped.actionableMessage);

		// In JSON/RPC mode, you would return a structured error object.
		const structuredError = {
			name: "MCPAuthError",
			code: mapped.code,
			server: serverName,
			message: mapped.actionableMessage,
			original: mapped.originalMessage,
		};

		// Re-throw for upstream handling, but with improved message.
		throw Object.assign(new Error(mapped.actionableMessage), structuredError);
	}
}
