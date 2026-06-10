import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			bedrockMock.constructorCalls.push(config);
		}

		send(): Promise<never> {
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { AUTHENTICATED_SENTINEL } from "../src/env-api-keys.ts";
import { getModel } from "../src/models.ts";
import type { BedrockOptions } from "../src/providers/amazon-bedrock.ts";
import { streamBedrock, streamSimpleBedrock } from "../src/providers/amazon-bedrock.ts";
import type { Context, Model } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const TOUCHED_ENV = ["AWS_BEARER_TOKEN_BEDROCK", "AWS_BEDROCK_SKIP_AUTH"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	bedrockMock.constructorCalls.length = 0;
	for (const key of TOUCHED_ENV) {
		originalEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of TOUCHED_ENV) {
		if (originalEnv[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = originalEnv[key];
		}
	}
});

function getModelFixture(): Model<"bedrock-converse-stream"> {
	return getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
}

async function captureClientConfig(
	options: BedrockOptions,
): Promise<{ token?: { token?: string }; authSchemePreference?: string[] }> {
	await streamBedrock(getModelFixture(), context, { cacheRetention: "none", ...options }).result();
	expect(bedrockMock.constructorCalls).toHaveLength(1);
	return bedrockMock.constructorCalls[0] as {
		token?: { token?: string };
		authSchemePreference?: string[];
	};
}

describe("bedrock bearer token resolution", () => {
	it("uses the resolved apiKey as a bearer token when no env var or option is set", async () => {
		const config = await captureClientConfig({ apiKey: "gateway-token-123" });
		expect(config.token).toEqual({ token: "gateway-token-123" });
		expect(config.authSchemePreference).toEqual(["httpBearerAuth"]);
	});

	it("prefers the explicit bearerToken option over the apiKey", async () => {
		const config = await captureClientConfig({ apiKey: "gateway-token-123", bearerToken: "explicit-token" });
		expect(config.token).toEqual({ token: "explicit-token" });
		expect(config.authSchemePreference).toEqual(["httpBearerAuth"]);
	});

	it("prefers AWS_BEARER_TOKEN_BEDROCK over the apiKey", async () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK = "env-token";
		const config = await captureClientConfig({ apiKey: "gateway-token-123" });
		expect(config.token).toEqual({ token: "env-token" });
		expect(config.authSchemePreference).toEqual(["httpBearerAuth"]);
	});

	it("never promotes the <authenticated> sentinel to a bearer token", async () => {
		const config = await captureClientConfig({ apiKey: AUTHENTICATED_SENTINEL });
		expect(config.token).toBeUndefined();
		expect(config.authSchemePreference).toBeUndefined();
	});

	it("uses SigV4 (no bearer token) when no apiKey, env var, or option is present", async () => {
		const config = await captureClientConfig({});
		expect(config.token).toBeUndefined();
		expect(config.authSchemePreference).toBeUndefined();
	});

	it("disables bearer auth when AWS_BEDROCK_SKIP_AUTH=1, even with an apiKey", async () => {
		process.env.AWS_BEDROCK_SKIP_AUTH = "1";
		const config = await captureClientConfig({ apiKey: "gateway-token-123" });
		expect(config.token).toBeUndefined();
		expect(config.authSchemePreference).toBeUndefined();
	});

	it("flows the apiKey through the streamSimple entrypoint", async () => {
		await streamSimpleBedrock(getModelFixture(), context, {
			cacheRetention: "none",
			apiKey: "simple-token",
		}).result();
		expect(bedrockMock.constructorCalls).toHaveLength(1);
		const config = bedrockMock.constructorCalls[0] as { token?: { token?: string }; authSchemePreference?: string[] };
		expect(config.token).toEqual({ token: "simple-token" });
		expect(config.authSchemePreference).toEqual(["httpBearerAuth"]);
	});
});
