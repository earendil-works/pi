/** Loads the MCP client, transports, and OAuth sign-in on first use (see runtime.ts). */
export const loadMcpRuntime = () => import("./runtime.ts");
