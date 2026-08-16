import { Type } from "typebox";
import { afterEach, describe, expect, it, test, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { type KiroOAuthCredential, kiroOAuth } from "../src/auth/oauth/kiro.ts";
import { createModels } from "../src/models.ts";
import { KIRO_MODELS, mapKiroCatalogToModels } from "../src/providers/kiro.catalog.ts";
import { fetchKiroModelCatalog } from "../src/providers/kiro.shared.ts";
import { buildKiroRequest, parseKiroEvent, streamKiro } from "../src/providers/kiro.ts";
import { crc32, decodeKiroEventStream, decodeKiroEventStreamMessage } from "../src/providers/kiro-eventstream.ts";
import { kiroProvider } from "../src/providers/kiro-provider.ts";
import type { AssistantMessage, Context, FetchFunction, ToolResultMessage } from "../src/types.ts";

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function eventStreamFrame(payload: string): Uint8Array {
	const payloadBytes = new TextEncoder().encode(payload);
	const totalLength = 16 + payloadBytes.length;
	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, 0, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	frame.set(payloadBytes, 12);
	view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
	return frame;
}

function concatFrames(frames: readonly Uint8Array[]): Uint8Array {
	const result = new Uint8Array(frames.reduce((length, frame) => length + frame.length, 0));
	let offset = 0;
	for (const frame of frames) {
		result.set(frame, offset);
		offset += frame.length;
	}
	return result;
}

const abortSignal = new AbortController().signal;

function assistantToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "tool-1", name: "lookup", arguments: { query: "x" } }],
		api: "kiro-api",
		provider: "kiro",
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function toolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tool-1",
		toolName: "lookup",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 3,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Kiro OAuth", () => {
	it("runs Builder ID device authorization and keeps non-secret routing metadata", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock: FetchFunction = async (input, init) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.endsWith("/client/register")) {
				return jsonResponse({ clientId: "client-fixture", clientSecret: "secret-fixture" });
			}
			if (url.endsWith("/device_authorization")) {
				return jsonResponse({
					deviceCode: "device-fixture",
					userCode: "CODE-FIXTURE",
					verificationUri: "https://device.example.test/verify",
					verificationUriComplete: "https://device.example.test/verify?code=fixture",
					interval: 1,
					expiresIn: 30,
				});
			}
			if (url.endsWith("/token")) {
				return jsonResponse({ accessToken: "access-fixture", refreshToken: "refresh-fixture", expiresIn: 3600 });
			}
			throw new Error(`unexpected Kiro test URL: ${url}`);
		};
		vi.stubGlobal("fetch", fetchMock);

		const notifications: Array<{ type: string; url?: string; message?: string }> = [];
		const credential = await kiroOAuth.login({
			signal: abortSignal,
			prompt: async () => "",
			notify: (event) => notifications.push(event),
		});

		expect(credential.type).toBe("oauth");
		expect(credential.access).toBe("access-fixture");
		expect(credential.refresh).toContain("|idc|us-east-1");
		expect((credential as KiroOAuthCredential).region).toBe("us-east-1");
		expect(notifications).toEqual([
			{
				type: "auth_url",
				url: "https://device.example.test/verify?code=fixture",
				instructions: "Your code: CODE-FIXTURE",
			},
			{ type: "progress", message: "Waiting for Kiro authorization in us-east-1..." },
		]);
		expect(calls.map((call) => call.url)).toEqual([
			"https://oidc.us-east-1.amazonaws.com/client/register",
			"https://oidc.us-east-1.amazonaws.com/device_authorization",
			"https://oidc.us-east-1.amazonaws.com/token",
		]);
	});

	it("refreshes with the registered device client and preserves profile metadata", async () => {
		const fetchMock = vi.fn<FetchFunction>(async () =>
			jsonResponse({ accessToken: "access-refreshed", expiresIn: 1800 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const credential: KiroOAuthCredential = {
			type: "oauth",
			access: "access-old",
			refresh: "refresh-old|client-fixture|secret-fixture|idc|eu-west-1",
			expires: 0,
			clientId: "client-fixture",
			clientSecret: "secret-fixture",
			region: "eu-west-1",
			authMethod: "idc",
			profileArn: "profile-fixture",
		};

		const refreshed = await kiroOAuth.refresh(credential, abortSignal);
		expect(refreshed.access).toBe("access-refreshed");
		expect((refreshed as KiroOAuthCredential).region).toBe("eu-west-1");
		expect((refreshed as KiroOAuthCredential).profileArn).toBe("profile-fixture");
		const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(request.body))).toMatchObject({
			clientId: "client-fixture",
			clientSecret: "secret-fixture",
			refreshToken: "refresh-old",
			grantType: "refresh_token",
		});

		const auth = await kiroOAuth.toAuth(refreshed);
		expect(auth.apiKey).toBe("access-refreshed");
		expect(auth.baseUrl).toBe("https://runtime.eu-central-1.kiro.dev/");
		expect(auth.headers).toEqual({ "x-amzn-kiro-profile-arn": "profile-fixture" });
	});
});

describe("Kiro OAuth error handling", () => {
	test("fails immediately for fatal HTTP 400 token errors", async () => {
		const fetchMock: FetchFunction = async (input) => {
			const url = String(input);
			if (url.endsWith("/client/register")) {
				return jsonResponse({ clientId: "client-fixture", clientSecret: "secret-fixture" });
			}
			if (url.endsWith("/device_authorization")) {
				return jsonResponse({
					deviceCode: "device-fixture",
					userCode: "CODE-FIXTURE",
					verificationUri: "https://device.example.test/verify",
					verificationUriComplete: "https://device.example.test/verify?code=fixture",
					interval: 1,
					expiresIn: 30,
				});
			}
			return jsonResponse({ error: "access_denied" }, 400);
		};
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			kiroOAuth.login({
				signal: new AbortController().signal,
				prompt: async () => "",
				notify: () => {},
			}),
		).rejects.toThrow("Kiro authorization failed: access_denied");
	});

	test("reports slow_down instead of treating it as authorization_pending", async () => {
		vi.useFakeTimers();
		try {
			const fetchMock: FetchFunction = async (input) => {
				const url = String(input);
				if (url.endsWith("/client/register")) {
					return jsonResponse({ clientId: "client-fixture", clientSecret: "secret-fixture" });
				}
				if (url.endsWith("/device_authorization")) {
					return jsonResponse({
						deviceCode: "device-fixture",
						userCode: "CODE-FIXTURE",
						verificationUri: "https://device.example.test/verify",
						verificationUriComplete: "https://device.example.test/verify?code=fixture",
						interval: 1,
						expiresIn: 1,
					});
				}
				return jsonResponse({ error: "slow_down" }, 400);
			};
			vi.stubGlobal("fetch", fetchMock);
			const login = kiroOAuth.login({
				signal: new AbortController().signal,
				prompt: async () => "",
				notify: () => {},
			});
			const rejection = expect(login).rejects.toThrow("after one or more slow_down responses");
			await vi.advanceTimersByTimeAsync(1_000);
			await rejection;
		} finally {
			vi.useRealTimers();
		}
	});

	test("bounds an in-flight token poll request with the login request timeout", async () => {
		const timeoutController = new AbortController();
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
		let tokenPollStartedResolve!: () => void;
		const tokenPollStarted = new Promise<void>((resolve) => {
			tokenPollStartedResolve = resolve;
		});
		const fetchMock: FetchFunction = async (input, init) => {
			const url = String(input);
			if (url.endsWith("/client/register")) {
				return jsonResponse({ clientId: "client-fixture", clientSecret: "secret-fixture" });
			}
			if (url.endsWith("/device_authorization")) {
				return jsonResponse({
					deviceCode: "device-fixture",
					userCode: "CODE-FIXTURE",
					verificationUri: "https://device.example.test/verify",
					verificationUriComplete: "https://device.example.test/verify?code=fixture",
					interval: 1,
					expiresIn: 30,
				});
			}
			tokenPollStartedResolve();
			return new Promise<Response>((_resolve, reject) => {
				const requestSignal = init?.signal;
				if (!requestSignal) {
					reject(new Error("Kiro token poll request did not receive an abort signal"));
					return;
				}
				const rejectOnAbort = () => reject(requestSignal.reason ?? new Error("Kiro token poll aborted"));
				if (requestSignal.aborted) rejectOnAbort();
				else requestSignal.addEventListener("abort", rejectOnAbort, { once: true });
			});
		};
		vi.stubGlobal("fetch", fetchMock);

		try {
			const login = kiroOAuth.login({
				signal: new AbortController().signal,
				prompt: async () => "",
				notify: () => {},
			});
			const rejection = expect(login).rejects.toBeDefined();
			await tokenPollStarted;
			timeoutController.abort();
			await rejection;
		} finally {
			timeoutSpy.mockRestore();
		}
	});

	test("rejects a malformed device expiry before starting to poll", async () => {
		const prompts = ["https://start.example.test", "us-east-1"];
		let tokenPolls = 0;
		const fetchMock: FetchFunction = async (input) => {
			const url = String(input);
			if (url.endsWith("/client/register")) {
				return jsonResponse({ clientId: "client-fixture", clientSecret: "secret-fixture" });
			}
			if (url.endsWith("/device_authorization")) {
				return jsonResponse({
					deviceCode: "device-fixture",
					userCode: "CODE-FIXTURE",
					verificationUri: "https://device.example.test/verify",
					verificationUriComplete: "https://device.example.test/verify?code=fixture",
					interval: 1,
					expiresIn: "not-a-number",
				});
			}
			tokenPolls += 1;
			return jsonResponse({ accessToken: "unexpected", refreshToken: "unexpected", expiresIn: 3600 });
		};
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			kiroOAuth.login({
				signal: new AbortController().signal,
				prompt: async () => prompts.shift() ?? "",
				notify: () => {},
			}),
		).rejects.toThrow("Could not find an AWS Identity Center region for the supplied start URL");
		expect(tokenPolls).toBe(0);
	});
});
describe("Kiro management and request transformation", () => {
	it("discovers a profile and fetches a profile-scoped model catalog", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchMock: FetchFunction = async (input, init) => {
			const url = String(input);
			requests.push({ url, init });
			if (url.endsWith("/List-Available-Profiles")) {
				return jsonResponse({ profiles: [{ arn: "profile-fixture" }] });
			}
			return jsonResponse({
				models: [
					{
						modelId: "fixture-model",
						displayName: "Fixture Model",
						tokenLimits: { maxInputTokens: 1234, maxOutputTokens: 567 },
					},
				],
			});
		};

		const result = await fetchKiroModelCatalog(
			{ accessToken: "access-fixture", region: "eu-central-1" },
			undefined,
			fetchMock,
		);
		expect(result.profileArn).toBe("profile-fixture");
		expect(result.response.models[0]?.modelId).toBe("fixture-model");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[1]?.init?.method).toBe("GET");
		expect(requests[1]?.url).toContain("origin=KIRO_CLI");
		expect(requests[1]?.url).toContain("profileArn=profile-fixture");
		expect(new Headers(requests[1]?.init?.headers).get("authorization")).toBe("Bearer access-fixture");

		const models = mapKiroCatalogToModels(result.response.models, "eu-central-1");
		expect(models[0]).toMatchObject({
			id: "fixture-model",
			contextWindow: 1234,
			maxTokens: 567,
			kiroRegion: "eu-central-1",
		});
	});

	it("maps system, tool, assistant, and tool-result history into a Kiro request", () => {
		const model = KIRO_MODELS[0]!;
		const context: Context = {
			systemPrompt: "Use concise answers.",
			tools: [
				{
					name: "lookup",
					description: "Look something up",
					parameters: Type.Object({ query: Type.String() }),
				},
			],
			messages: [
				{ role: "user", content: "Earlier", timestamp: 1 },
				assistantToolCall(),
				toolResult(),
				{ role: "user", content: "Current", timestamp: 4 },
			],
		};

		const request = buildKiroRequest(model, context, "profile-fixture", "conversation-fixture", "high");
		expect(request.profileArn).toBe("profile-fixture");
		expect(request.conversationState.history?.[0]?.userInputMessage?.content).toContain("Earlier");
		expect(request.conversationState.history?.[1]?.assistantResponseMessage?.toolUses?.[0]?.toolUseId).toBe("tool-1");
		expect(
			request.conversationState.history?.[2]?.userInputMessage?.userInputMessageContext?.toolResults?.[0]?.content[0]
				?.text,
		).toBe("result");
		expect(request.conversationState.currentMessage.userInputMessage.content).toBe("Current");
		expect(
			request.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.[0]
				?.toolSpecification.name,
		).toBe("lookup");
	});
});

describe("Kiro EventStream and runtime", () => {
	it("validates CRCs and reassembles split frames", async () => {
		const frame = eventStreamFrame(JSON.stringify({ content: "hello" }));
		expect(new TextDecoder().decode(decodeKiroEventStreamMessage(frame).payload)).toBe(
			JSON.stringify({ content: "hello" }),
		);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(frame.slice(0, 7));
				controller.enqueue(frame.slice(7));
				controller.close();
			},
		});
		const messages = [];
		for await (const message of decodeKiroEventStream(stream)) messages.push(message);
		expect(messages).toHaveLength(1);
		expect(new TextDecoder().decode(messages[0]!.payload)).toBe(JSON.stringify({ content: "hello" }));
		const corrupt = frame.slice();
		corrupt[8] ^= 1;
		expect(() => decodeKiroEventStreamMessage(corrupt)).toThrow("prelude CRC");
	});

	it("parses native events and emits a complete text/tool runtime response", async () => {
		expect(parseKiroEvent({ content: "hello" })).toEqual({ type: "content", data: "hello" });
		expect(parseKiroEvent({ text: "reason" })).toEqual({ type: "thinkingText", data: "reason" });
		expect(parseKiroEvent({ name: "lookup", toolUseId: "tool-1", input: { query: "x" }, stop: true })).toEqual({
			type: "toolUse",
			data: { name: "lookup", toolUseId: "tool-1", input: JSON.stringify({ query: "x" }), stop: true },
		});
		expect(parseKiroEvent({ usage: { inputTokens: 10, outputTokens: 4 } })).toEqual({
			type: "usage",
			data: { inputTokens: 10, outputTokens: 4 },
		});

		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const responseBody = concatFrames([
			eventStreamFrame(JSON.stringify({ text: "reason" })),
			eventStreamFrame(JSON.stringify({ content: "hello" })),
			eventStreamFrame(JSON.stringify({ name: "lookup", toolUseId: "tool-1", input: { query: "x" }, stop: true })),
			eventStreamFrame(JSON.stringify({ usage: { inputTokens: 10, outputTokens: 4 } })),
		]);
		const fetchMock: FetchFunction = async (input, init) => {
			requests.push({ url: String(input), init });
			return new Response(responseBody, { status: 200 });
		};
		const model = KIRO_MODELS[0]!;
		const context: Context = { messages: [{ role: "user", content: "Current", timestamp: 1 }] };
		let sentRequest: unknown;
		const result = await streamKiro(model, context, {
			apiKey: JSON.stringify({ token: "access-fixture", region: "eu-central-1", profileArn: "profile-fixture" }),
			fetch: fetchMock,
			sessionId: "conversation-fixture",
			onPayload: (payload) => {
				sentRequest = payload;
			},
		}).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "reason" },
			{ type: "text", text: "hello" },
			{ type: "toolCall", id: "tool-1", name: "lookup", arguments: { query: "x" } },
		]);
		expect(result.usage.input).toBe(10);
		expect(result.usage.output).toBe(4);
		expect(requests[0]?.url).toBe("https://runtime.eu-central-1.kiro.dev/generateAssistantResponse");
		expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer access-fixture");
		expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
			profileArn: "profile-fixture",
			conversationState: { conversationId: "conversation-fixture" },
		});
		expect(sentRequest).toMatchObject({ profileArn: "profile-fixture" });
	});
});

describe("Kiro provider discovery", () => {
	it("registers /login-compatible OAuth and refreshes profile-scoped models", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("kiro", async () => ({
			type: "oauth",
			access: "access-fixture",
			refresh: "refresh-fixture",
			expires: Date.now() + 60_000,
			region: "eu-central-1",
			profileArn: "profile-fixture",
		}));
		const fetchMock: FetchFunction = async (input) => {
			expect(String(input)).toContain("List-Available-Models");
			return jsonResponse({ models: [{ modelId: "fixture-model", displayName: "Fixture Model" }] });
		};
		vi.stubGlobal("fetch", fetchMock);

		const provider = kiroProvider();
		expect(provider.id).toBe("kiro");
		expect(provider.auth.oauth?.name).toContain("Kiro");
		const models = createModels({ credentials });
		models.setProvider(provider);
		const refreshResult = await models.refresh({ providers: ["kiro"] });
		expect(refreshResult.errors.size).toBe(0);
		expect(models.getModel("kiro", "fixture-model")).toMatchObject({
			name: "Fixture Model",
			provider: "kiro",
			api: "kiro-api",
		});
	});
});

describe("Kiro Models.login wiring", () => {
	it("persists the device-code credential through the provider login entry", async () => {
		const fetchMock: FetchFunction = async (input) => {
			const url = String(input);
			if (url.endsWith("/client/register")) {
				return jsonResponse({ clientId: "client-fixture", clientSecret: "secret-fixture" });
			}
			if (url.endsWith("/device_authorization")) {
				return jsonResponse({
					deviceCode: "device-fixture",
					userCode: "CODE-FIXTURE",
					verificationUri: "https://device.example.test/verify",
					verificationUriComplete: "https://device.example.test/verify?code=fixture",
					interval: 1,
					expiresIn: 30,
				});
			}
			if (url.endsWith("/token")) {
				return jsonResponse({ accessToken: "access-fixture", refreshToken: "refresh-fixture", expiresIn: 3600 });
			}
			throw new Error(`unexpected Kiro login URL: ${url}`);
		};
		vi.stubGlobal("fetch", fetchMock);
		const credentials = new InMemoryCredentialStore();
		const models = createModels({ credentials });
		models.setProvider(kiroProvider());

		const credential = await models.login("kiro", "oauth", {
			signal: abortSignal,
			prompt: async () => "",
			notify: () => {},
		});

		expect(credential.type).toBe("oauth");
		expect((await credentials.read("kiro"))?.type).toBe("oauth");
		expect(await models.checkAuth("kiro")).toMatchObject({ type: "oauth" });
	});
});
