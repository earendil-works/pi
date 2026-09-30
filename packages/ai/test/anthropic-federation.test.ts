import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = vi.hoisted(() => ({
	constructorOpts: undefined as Record<string, unknown> | undefined,
	createParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } },
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 1 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	class FakeAnthropic {
		constructor(opts: Record<string, unknown>) {
			mockState.constructorOpts = opts;
		}
		beta = {
			messages: {
				create: (params: Record<string, unknown>) => {
					mockState.createParams = params;
					return { asResponse: async () => createSseResponse() };
				},
			},
		};
	}

	return { default: FakeAnthropic };
});

const neverAbortedSignal = new AbortController().signal;

const federationEnv = {
	ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
	ANTHROPIC_ORGANIZATION_ID: "org-test",
	ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_test",
	ANTHROPIC_IDENTITY_TOKEN_FILE: "/tmp/identity.jwt",
};

const expectedConfig = {
	organization_id: "org-test",
	workspace_id: undefined,
	authentication: {
		type: "oidc_federation",
		federation_rule_id: "fdrl_test",
		service_account_id: "svac_test",
		identity_token: { source: "file", path: "/tmp/identity.jwt" },
	},
};

const context = normalizeContext({
	systemPrompt: "System prompt.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Claude Test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};

function resolveWithEnv(env: Record<string, string>) {
	return anthropicProvider().auth.apiKey?.resolve({
		ctx: { env: async (name) => env[name], fileExists: async () => false },
		signal: neverAbortedSignal,
	});
}

afterEach(() => {
	mockState.constructorOpts = undefined;
	mockState.createParams = undefined;
});

// https://github.com/earendil-works/pi/issues/10177
describe("Anthropic workload identity federation", () => {
	it("resolves the federation variables as provider env with no request auth", async () => {
		expect(await resolveWithEnv(federationEnv)).toEqual({
			auth: {},
			env: federationEnv,
			source: "workload identity federation",
		});
	});

	it("passes ANTHROPIC_WORKSPACE_ID through when set", async () => {
		const result = await resolveWithEnv({ ...federationEnv, ANTHROPIC_WORKSPACE_ID: "wrkspc_test" });
		expect(result?.env?.ANTHROPIC_WORKSPACE_ID).toBe("wrkspc_test");
	});

	it("is not configured when a federation variable is missing", async () => {
		const { ANTHROPIC_IDENTITY_TOKEN_FILE: _omitted, ...partial } = federationEnv;
		expect(await resolveWithEnv(partial)).toBeUndefined();
	});

	it("keeps API key and auth token precedence over federation", async () => {
		expect(await resolveWithEnv({ ...federationEnv, ANTHROPIC_API_KEY: "api-key" })).toEqual({
			auth: { apiKey: "api-key" },
			source: "ANTHROPIC_API_KEY",
		});
		expect(await resolveWithEnv({ ...federationEnv, ANTHROPIC_AUTH_TOKEN: "auth-token" })).toEqual({
			auth: { headers: { Authorization: "Bearer auth-token" } },
			source: "ANTHROPIC_AUTH_TOKEN",
		});
	});

	it("hands the SDK a federation config instead of a key", async () => {
		await streamAnthropic(anthropicModel, context, { env: federationEnv }).result();

		expect(mockState.constructorOpts?.apiKey).toBeNull();
		expect(mockState.constructorOpts?.authToken).toBeNull();
		expect(mockState.constructorOpts?.config).toEqual(expectedConfig);
		const headers = mockState.constructorOpts?.defaultHeaders as Record<string, string | null>;
		expect(headers.Authorization).toBeUndefined();
		expect(mockState.createParams?.betas ?? []).not.toContain("oauth-2025-04-20");
	});

	it("threads authContext federation variables through Models", async () => {
		const models = createModels({
			authContext: {
				env: async (name) => federationEnv[name as keyof typeof federationEnv],
				fileExists: async () => false,
			},
		});
		models.setProvider(anthropicProvider());

		await models.streamSimple(anthropicModel, context).result();

		expect(mockState.constructorOpts?.apiKey).toBeNull();
		expect(mockState.constructorOpts?.config).toEqual(expectedConfig);
	});

	it("lets an explicit API key win over federation env", async () => {
		await streamAnthropic(anthropicModel, context, { apiKey: "explicit-key", env: federationEnv }).result();

		expect(mockState.constructorOpts?.apiKey).toBe("explicit-key");
		expect(mockState.constructorOpts?.config).toBeUndefined();
	});

	it("does not federate other anthropic-messages providers", async () => {
		const kimi: Model<"anthropic-messages"> = {
			...anthropicModel,
			provider: "kimi-coding",
			baseUrl: "https://api.kimi.com/coding",
		};
		const message = await streamAnthropic(kimi, context, { env: federationEnv }).result();

		expect(message.stopReason).toBe("error");
		expect(mockState.constructorOpts).toBeUndefined();
	});
});
