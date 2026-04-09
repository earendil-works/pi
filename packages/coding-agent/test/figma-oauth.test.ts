import { afterEach, describe, expect, it, vi } from "vitest";

describe("Figma MCP OAuth client fallback", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("resolves a static approved client config from the Figma MCP server definition", async () => {
		const { resolveFigmaOAuthClientConfig } = await import("../src/oauth/figma-mcp.js");

		vi.stubEnv("FIGMA_CLIENT_SECRET", "super-secret");

		expect(
			resolveFigmaOAuthClientConfig({
				mcpServers: {
					figma: {
						url: "https://mcp.figma.com/mcp",
						oauth: {
							clientId: "approved-client-id",
							clientSecretEnv: "FIGMA_CLIENT_SECRET",
							redirectUri: "http://127.0.0.1:8788/callback",
						},
					},
				},
			}),
		).toEqual({
			clientId: "approved-client-id",
			clientSecret: "super-secret",
			redirectUri: "http://127.0.0.1:8788/callback",
			serverName: "figma",
			serverUrl: "https://mcp.figma.com/mcp",
		});
	});

	it("returns empty clientId for DCR to handle when no static config is available", async () => {
		const { resolveFigmaOAuthClientConfig } = await import("../src/oauth/figma-mcp.js");

		// When no static config is available, returns empty clientId
		// DCR will provide credentials during loginFigmaMcp
		const result = resolveFigmaOAuthClientConfig({
			mcpServers: {
				figma: { url: "https://mcp.figma.com/mcp" },
			},
		});

		expect(result.clientId).toBe("");
		expect(result.clientSecret).toBeUndefined();
		expect(result.redirectUri).toBe("http://127.0.0.1:8788/callback");
		expect(result.serverName).toBe("figma");
		expect(result.serverUrl).toBe("https://mcp.figma.com/mcp");
	});
});
