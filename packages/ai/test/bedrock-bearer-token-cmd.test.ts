import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBearerToken } from "../src/providers/amazon-bedrock.js";

const originalToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
const originalCmd = process.env.AWS_BEARER_TOKEN_BEDROCK_CMD;

beforeEach(() => {
	delete process.env.AWS_BEARER_TOKEN_BEDROCK;
	delete process.env.AWS_BEARER_TOKEN_BEDROCK_CMD;
});

afterEach(() => {
	if (originalToken === undefined) {
		delete process.env.AWS_BEARER_TOKEN_BEDROCK;
	} else {
		process.env.AWS_BEARER_TOKEN_BEDROCK = originalToken;
	}
	if (originalCmd === undefined) {
		delete process.env.AWS_BEARER_TOKEN_BEDROCK_CMD;
	} else {
		process.env.AWS_BEARER_TOKEN_BEDROCK_CMD = originalCmd;
	}
});

describe("resolveBearerToken", () => {
	it("returns undefined when neither env var is set", async () => {
		expect(await resolveBearerToken()).toBeUndefined();
	});

	it("returns static token from AWS_BEARER_TOKEN_BEDROCK", async () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK = "static-token-abc";
		expect(await resolveBearerToken()).toBe("static-token-abc");
	});

	it("executes AWS_BEARER_TOKEN_BEDROCK_CMD and returns its output", async () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK_CMD = "echo fresh-token-123";
		expect(await resolveBearerToken()).toBe("fresh-token-123");
	});

	it("trims whitespace from command output", async () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK_CMD = "echo '  token-with-spaces  '";
		expect(await resolveBearerToken()).toBe("token-with-spaces");
	});

	it("prefers AWS_BEARER_TOKEN_BEDROCK_CMD over AWS_BEARER_TOKEN_BEDROCK", async () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK = "static-token";
		process.env.AWS_BEARER_TOKEN_BEDROCK_CMD = "echo cmd-token";
		expect(await resolveBearerToken()).toBe("cmd-token");
	});

	it("falls back to AWS_BEARER_TOKEN_BEDROCK when command returns empty output", async () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK = "fallback-token";
		process.env.AWS_BEARER_TOKEN_BEDROCK_CMD = "printf ''";
		expect(await resolveBearerToken()).toBe("fallback-token");
	});

	it("throws when AWS_BEARER_TOKEN_BEDROCK_CMD is an invalid command", async () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK_CMD = "nonexistent-command-xyz-12345";
		await expect(resolveBearerToken()).rejects.toThrow();
	});
});
