import { describe, expect, it } from "vitest";

describe("buildMcpStatusLabel", () => {
	it("formats connected status with connected and total server counts", async () => {
		const { buildMcpStatusLabel } = await import("../src/mcp/status.js");
		expect(buildMcpStatusLabel({ state: "connected", connectedCount: 1, totalCount: 2 })).toBe("MCP: 1/2 connected");
	});

	it("formats degraded status with the failing server name", async () => {
		const { buildMcpStatusLabel } = await import("../src/mcp/status.js");
		expect(buildMcpStatusLabel({ state: "degraded", connectedCount: 0, totalCount: 1, serverName: "figma" })).toBe(
			"MCP degraded: figma",
		);
	});

	it("formats auth-failed status distinctly from generic degraded state", async () => {
		const { buildMcpStatusLabel } = await import("../src/mcp/status.js");
		expect(buildMcpStatusLabel({ state: "auth_failed", connectedCount: 0, totalCount: 1, serverName: "figma" })).toBe(
			"MCP auth failed: figma",
		);
	});
});
