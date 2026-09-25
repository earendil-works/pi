import { describe, expect, it } from "vitest";
import { mapMcpOAuthError, MCPOAuthErrorCode, isDynamicRegistrationUnsupported } from "./oauth-errors.js";

describe("mapMcpOAuthError", () => {
	it("detects dynamic registration unsupported error", () => {
		const err = new Error('Failed to authenticate "github": Incompatible auth server: does not support dynamic client registration');
		const mapped = mapMcpOAuthError(err, "github");
		expect(mapped.code).toBe(MCPOAuthErrorCode.DynamicRegistrationUnsupported);
		expect(mapped.serverName).toBe("github");
		expect(mapped.actionableMessage).toContain('Failed to authenticate "github" via OAuth');
		expect(mapped.actionableMessage).toContain('does not support dynamic client registration');
	});

	it("falls back to generic for unknown errors", () => {
		const err = new Error("network timeout");
		const mapped = mapMcpOAuthError(err, "github");
		expect(mapped.code).toBe(MCPOAuthErrorCode.Generic);
	});

	it("isDynamicRegistrationUnsupported helper works", () => {
		expect(isDynamicRegistrationUnsupported(new Error("Incompatible auth server: does not support dynamic client registration"))).toBe(true);
		expect(isDynamicRegistrationUnsupported(new Error("some other error"))).toBe(false);
	});
});
