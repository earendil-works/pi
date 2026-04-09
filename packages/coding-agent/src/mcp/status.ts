export type McpStatusState = "connected" | "degraded" | "auth_failed" | "auth_expired" | "auth_required";

export interface McpStatusSnapshot {
	state: McpStatusState;
	connectedCount: number;
	totalCount: number;
	serverName?: string;
}

export function buildMcpStatusLabel(snapshot: McpStatusSnapshot): string {
	if (snapshot.state === "connected") {
		return `MCP: ${snapshot.connectedCount}/${snapshot.totalCount} connected`;
	}

	if (snapshot.state === "auth_failed") {
		return snapshot.serverName ? `MCP auth failed: ${snapshot.serverName}` : "MCP auth failed";
	}

	if (snapshot.state === "auth_expired") {
		return snapshot.serverName ? `MCP auth expired: ${snapshot.serverName}` : "MCP auth expired";
	}

	if (snapshot.state === "auth_required") {
		return snapshot.serverName ? `MCP auth required: ${snapshot.serverName}` : "MCP auth required";
	}

	return snapshot.serverName ? `MCP degraded: ${snapshot.serverName}` : "MCP degraded";
}
