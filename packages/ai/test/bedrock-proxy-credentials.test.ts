import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamBedrock } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Context } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

describe("bedrock proxy credentials", () => {
	let proxy: Server;
	let proxyUrl: string;
	let connectTargets: string[];
	let awsDir: string;

	beforeEach(async () => {
		connectTargets = [];
		proxy = createServer((_req, res) => {
			res.writeHead(502).end();
		});
		proxy.on("connect", (req, socket) => {
			connectTargets.push(req.url ?? "");
			socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

		awsDir = mkdtempSync(join(tmpdir(), "pi-bedrock-proxy-"));
		const configFile = join(awsDir, "config");
		const startUrl = "https://example.awsapps.com/start";
		writeFileSync(
			configFile,
			[
				"[profile sso]",
				`sso_start_url = ${startUrl}`,
				"sso_region = us-east-1",
				"sso_account_id = 123456789012",
				"sso_role_name = Example",
				"",
			].join("\n"),
		);
		const cacheDir = join(awsDir, ".aws", "sso", "cache");
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(
			join(cacheDir, `${createHash("sha1").update(startUrl).digest("hex")}.json`),
			JSON.stringify({
				startUrl,
				region: "us-east-1",
				accessToken: "example-token",
				expiresAt: "2099-01-01T00:00:00Z",
			}),
		);
		for (const name of [
			"AWS_ACCESS_KEY_ID",
			"AWS_SECRET_ACCESS_KEY",
			"AWS_SESSION_TOKEN",
			"AWS_BEARER_TOKEN_BEDROCK",
			"AWS_BEDROCK_SKIP_AUTH",
			"AWS_PROFILE",
			"https_proxy",
			"ALL_PROXY",
			"all_proxy",
			"NO_PROXY",
			"no_proxy",
		]) {
			vi.stubEnv(name, undefined);
		}
		vi.stubEnv("AWS_CONFIG_FILE", configFile);
		vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", join(awsDir, "credentials"));
		vi.stubEnv("AWS_REGION", "us-east-1");
		vi.stubEnv("HOME", awsDir);
		vi.stubEnv("USERPROFILE", awsDir);
		// Keep the credential request off the real network when it bypasses the proxy.
		vi.stubEnv("AWS_ENDPOINT_URL_SSO", "https://sso.invalid");
		vi.stubEnv("HTTPS_PROXY", proxyUrl);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		rmSync(awsDir, { recursive: true, force: true });
		await new Promise<void>((resolve) => proxy.close(() => resolve()));
	});

	// Regression test for #12353: profile credential requests must use the proxy too.
	it("resolves profile credentials through the configured proxy", async () => {
		const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const result = await streamBedrock(model, context, { cacheRetention: "none", profile: "sso" }).result();

		expect(result.stopReason).toBe("error");
		expect(connectTargets).toContain("sso.invalid:443");
	});
});
