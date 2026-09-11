import { afterEach, describe, expect, it } from "vitest";
import { resolveHttpProxyUrlForTarget, UNSUPPORTED_PROXY_PROTOCOL_MESSAGE } from "../src/utils/node-http-proxy.ts";

const PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"npm_config_http_proxy",
	"npm_config_https_proxy",
	"npm_config_proxy",
	"npm_config_no_proxy",
] as const;

const originalEnv = new Map<string, string | undefined>();
for (const key of PROXY_ENV_KEYS) {
	originalEnv.set(key, process.env[key]);
}

function resetProxyEnv(): void {
	for (const key of PROXY_ENV_KEYS) {
		delete process.env[key];
	}
}

afterEach(() => {
	resetProxyEnv();
	for (const [key, value] of originalEnv) {
		if (value !== undefined) {
			process.env[key] = value;
		}
	}
});

describe("node HTTP proxy resolution", () => {
	it("respects NO_PROXY exclusions", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "http://proxy.example:8080";
		process.env.NO_PROXY = "bedrock-runtime.us-east-1.amazonaws.com";

		expect(resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com")).toBeUndefined();
	});

	it("resolves HTTP and HTTPS proxy URLs", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "http://proxy.example:8080";

		expect(resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com")?.toString()).toBe(
			"http://proxy.example:8080/",
		);
	});

	it("prefers scoped proxy env aliases before process env aliases", () => {
		resetProxyEnv();
		process.env.https_proxy = "http://process-proxy.example:8080";

		expect(
			resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com", {
				HTTPS_PROXY: "http://scoped-proxy.example:8080",
			})?.toString(),
		).toBe("http://scoped-proxy.example:8080/");
	});

	it("rejects SOCKS and PAC proxy URLs explicitly", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "socks5://proxy.example:1080";

		expect(() => resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com")).toThrow(
			UNSUPPORTED_PROXY_PROTOCOL_MESSAGE,
		);
	});

	it("handles subdomain wildcards, IPv6, and ports in NO_PROXY", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "http://proxy.example:8080";
		process.env.NO_PROXY = "example.com, .wildcard.org, *.star.net, ::1, [2001:db8::1], 127.0.0.1:8080";

		expect(resolveHttpProxyUrlForTarget("https://example.com")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://api.example.com")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://wildcard.org")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://api.wildcard.org")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://star.net")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://api.star.net")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://notexample.com")?.toString()).toBe("http://proxy.example:8080/");

		expect(resolveHttpProxyUrlForTarget("https://[::1]:80")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://[2001:db8::1]")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://127.0.0.1:8080")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://127.0.0.1:3000")?.toString()).toBe("http://proxy.example:8080/");
	});
});
