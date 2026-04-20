import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEnvApiKey } from "../src/env-api-keys.js";

const BEDROCK_ENV_VARS = [
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_BEARER_TOKEN_BEDROCK_CMD",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of BEDROCK_ENV_VARS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of BEDROCK_ENV_VARS) {
		if (saved[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = saved[key];
		}
	}
});

describe("getEnvApiKey amazon-bedrock", () => {
	it("returns undefined when no credentials are set", () => {
		expect(getEnvApiKey("amazon-bedrock")).toBeUndefined();
	});

	it("returns authenticated for AWS_BEARER_TOKEN_BEDROCK", () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK = "some-token";
		expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
	});

	it("returns authenticated for AWS_BEARER_TOKEN_BEDROCK_CMD", () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK_CMD = "echo token";
		expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
	});

	it("returns authenticated for AWS_PROFILE", () => {
		process.env.AWS_PROFILE = "my-profile";
		expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
	});

	it("returns authenticated for IAM key pair", () => {
		process.env.AWS_ACCESS_KEY_ID = "AKIA...";
		process.env.AWS_SECRET_ACCESS_KEY = "secret";
		expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
	});

	it("returns undefined for partial IAM keys (access key only)", () => {
		process.env.AWS_ACCESS_KEY_ID = "AKIA...";
		expect(getEnvApiKey("amazon-bedrock")).toBeUndefined();
	});
});
