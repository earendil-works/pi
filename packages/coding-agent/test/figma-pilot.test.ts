import { describe, expect, it } from "vitest";

describe("Figma pilot status", () => {
	it("detects the imported Figma remote server from MCP config", async () => {
		const { detectFigmaPilotServer } = await import("../src/mcp/figma-pilot.js");

		expect(
			detectFigmaPilotServer({
				mcpServers: {
					figma: { url: "https://mcp.figma.com/mcp" },
					other: { url: "https://example.com/mcp" },
				},
			}),
		).toEqual({ serverName: "figma", url: "https://mcp.figma.com/mcp" });
	});

	it("returns connected state when no Figma server is configured", async () => {
		const { buildFigmaPilotStatus } = await import("../src/mcp/figma-pilot.js");

		expect(
			buildFigmaPilotStatus({
				serverName: "figma",
				hasConfiguredServer: false,
				hasAuthenticatedConnection: false,
				hasStoredCredentials: false,
			}),
		).toEqual({
			state: "connected",
			connectedCount: 0,
			totalCount: 0,
		});
	});

	it("returns connected state when authenticated", async () => {
		const { buildFigmaPilotStatus } = await import("../src/mcp/figma-pilot.js");

		expect(
			buildFigmaPilotStatus({
				serverName: "figma",
				hasConfiguredServer: true,
				hasAuthenticatedConnection: true,
				hasStoredCredentials: true,
			}),
		).toEqual({
			state: "connected",
			serverName: "figma",
			connectedCount: 1,
			totalCount: 1,
		});
	});

	it("returns auth_expired when stored credentials exist but not connected", async () => {
		const { buildFigmaPilotStatus } = await import("../src/mcp/figma-pilot.js");

		expect(
			buildFigmaPilotStatus({
				serverName: "figma",
				hasConfiguredServer: true,
				hasAuthenticatedConnection: false,
				hasStoredCredentials: true,
			}),
		).toEqual({
			state: "auth_expired",
			serverName: "figma",
			connectedCount: 0,
			totalCount: 1,
		});
	});

	it("returns auth_required when no stored credentials and not connected", async () => {
		const { buildFigmaPilotStatus } = await import("../src/mcp/figma-pilot.js");

		expect(
			buildFigmaPilotStatus({
				serverName: "figma",
				hasConfiguredServer: true,
				hasAuthenticatedConnection: false,
				hasStoredCredentials: false,
			}),
		).toEqual({
			state: "auth_required",
			serverName: "figma",
			connectedCount: 0,
			totalCount: 1,
		});
	});
});
