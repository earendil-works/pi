import { afterEach, describe, expect, it } from "vitest";
import { resolveHttpProxyUrlForTarget, UNSUPPORTED_PROXY_PROTOCOL_MESSAGE } from "../src/utils/node-http-proxy.js";

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

	it("rejects SOCKS and PAC proxy URLs explicitly", () => {
		resetProxyEnv();
		process.env.HTTPS_PROXY = "socks5://proxy.example:1080";

		expect(() => resolveHttpProxyUrlForTarget("https://bedrock-runtime.us-east-1.amazonaws.com")).toThrow(
			UNSUPPORTED_PROXY_PROTOCOL_MESSAGE,
		);
	});
});
