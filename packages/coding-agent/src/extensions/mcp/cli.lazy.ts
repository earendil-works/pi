/** Loads `pi mcp` and the MCP runtime only when the command runs (see cli.ts). */
export const loadMcpCommand = () => import("./cli.ts");
