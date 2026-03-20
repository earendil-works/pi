import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";

const mockState = vi.hoisted(() => ({
	constructorOptions: undefined as Record<string, unknown> | undefined,
	requestConfig: undefined as Record<string, unknown> | undefined,
	responseChunks: [] as string[],
	responseStatus: 200,
	responseHeaders: {
		"content-type": "text/event-stream; charset=utf-8",
	} as Record<string, string>,
	nextAccessToken: "gigachat-sdk-access-token",
	updateTokenCalls: 0,
}));

vi.mock("gigachat", () => {
	class FakeGigaChat {
		_client: {
			request: (config: Record<string, unknown>) => Promise<{
				status: number;
				headers: Record<string, string>;
				data: AsyncIterable<string>;
			}>;
		};
		_settings: Record<string, unknown>;
		_accessToken?: { access_token?: string; expires_at?: number };

		constructor(options: Record<string, unknown>) {
			mockState.constructorOptions = options;
			this._settings = options;
			if (typeof options.accessToken === "string") {
				this._accessToken = { access_token: options.accessToken, expires_at: 0 };
			}
			this._client = {
				request: async (config: Record<string, unknown>) => {
					mockState.requestConfig = config;
					return {
						status: mockState.responseStatus,
						headers: { ...mockState.responseHeaders },
						data: createAsyncIterable(mockState.responseChunks),
					};
				},
			};
		}

		get useAuth(): boolean {
			return Boolean(this._settings.credentials || (this._settings.user && this._settings.password));
		}

		checkValidityToken(): boolean {
			return Boolean(this._accessToken);
		}

		resetToken(): void {
			this._accessToken = undefined;
		}

		async updateToken(): Promise<void> {
			mockState.updateTokenCalls += 1;
			this._accessToken = {
				access_token: mockState.nextAccessToken,
				expires_at: Date.now() + 60_000,
			};
		}
	}

	function createAsyncIterable(chunks: string[]): AsyncIterable<string> {
		return {
			async *[Symbol.asyncIterator]() {
				for (const chunk of chunks) {
					yield chunk;
				}
			},
		};
	}

	return { default: FakeGigaChat };
});

function toSSEChunk(payload: Record<string, unknown>): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("GigaChat Provider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.GIGACHAT_CREDENTIALS;
		delete process.env.GIGACHAT_ACCESS_TOKEN;
		delete process.env.GIGACHAT_SCOPE;
		delete process.env.GIGACHAT_BASE_URL;
		delete process.env.GIGACHAT_USER;
		delete process.env.GIGACHAT_PASSWORD;
		mockState.constructorOptions = undefined;
		mockState.requestConfig = undefined;
		mockState.responseChunks = [];
		mockState.responseStatus = 200;
		mockState.responseHeaders = {
			"content-type": "text/event-stream; charset=utf-8",
		};
		mockState.nextAccessToken = "gigachat-sdk-access-token";
		mockState.updateTokenCalls = 0;
	});

	it("uses the official client with credentials-based auth and survives SSE chunks split mid-JSON string", async () => {
		process.env.GIGACHAT_CREDENTIALS = "test-gigachat-credentials";
		process.env.GIGACHAT_SCOPE = "GIGACHAT_API_PERS";

		const rawEvent = toSSEChunk({
			choices: [
				{
					delta: {
						function_call: {
							name: "write",
							arguments: {
								path: "calculator.py",
								content: "def add(x, y):\n    return x + y\n",
							},
						},
					},
					finish_reason: "function_call",
				},
			],
			usage: {
				prompt_tokens: 10,
				completion_tokens: 20,
				total_tokens: 30,
			},
		});
		const splitIndex = rawEvent.indexOf("return x + y");
		mockState.responseChunks = [rawEvent.slice(0, splitIndex), rawEvent.slice(splitIndex)];

		let capturedPayload: unknown;
		const response = await complete(
			getModel("gigachat", "GigaChat-2-Pro"),
			{
				messages: [{ role: "user", content: "Write the file", timestamp: Date.now() }],
				tools: [
					{
						name: "write",
						description: "Write a file",
						parameters: Type.Object({
							path: Type.String(),
							content: Type.String(),
						}),
					},
				],
			},
			{
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		expect(mockState.constructorOptions).toMatchObject({
			credentials: "test-gigachat-credentials",
			scope: "GIGACHAT_API_PERS",
			model: "GigaChat-2-Pro",
			baseUrl: "https://gigachat.devices.sberbank.ru/api/v1",
			dangerouslyAllowBrowser: false,
		});
		expect(mockState.updateTokenCalls).toBe(1);
		expect(mockState.requestConfig).toMatchObject({
			method: "POST",
			url: "/chat/completions",
			responseType: "stream",
			headers: {
				Accept: "text/event-stream",
				"Cache-Control": "no-store",
				Authorization: "Bearer gigachat-sdk-access-token",
			},
		});
		expect(capturedPayload).toMatchObject({
			model: "GigaChat-2-Pro",
			functions: [
				{
					name: "write",
				},
			],
		});
		expect((capturedPayload as { stream?: boolean }).stream).toBe(true);
		expect(response.stopReason).toBe("toolUse");
		expect(response.usage).toMatchObject({
			input: 10,
			output: 20,
			totalTokens: 30,
		});
		expect(response.content).toEqual([
			{
				type: "toolCall",
				id: "gigachat_0",
				name: "write",
				arguments: {
					path: "calculator.py",
					content: "def add(x, y):\n    return x + y\n",
				},
			},
		]);
	});

	it("uses a provided access token directly and honors the configured base URL override", async () => {
		process.env.GIGACHAT_ACCESS_TOKEN = "eyJ.test.token";
		process.env.GIGACHAT_BASE_URL = "https://gigachat-preview.devices.sberbank.ru/api/v1";
		mockState.responseChunks = [
			toSSEChunk({
				choices: [
					{
						delta: { content: "Hello" },
						finish_reason: "stop",
					},
				],
			}),
		];

		const response = await complete(getModel("gigachat", "GigaChat-2"), {
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		});

		expect(mockState.constructorOptions).toMatchObject({
			accessToken: "eyJ.test.token",
			model: "GigaChat-2",
			baseUrl: "https://gigachat-preview.devices.sberbank.ru/api/v1",
		});
		expect((mockState.constructorOptions as { credentials?: string } | undefined)?.credentials).toBeUndefined();
		expect(mockState.updateTokenCalls).toBe(0);
		expect(mockState.requestConfig).toMatchObject({
			data: {
				model: "GigaChat-2",
				stream: true,
				messages: [{ role: "user", content: "Hi" }],
			},
		});
		expect(response.stopReason).toBe("stop");
		expect(response.content[0]).toMatchObject({ type: "text", text: "Hello" });
	});

	it("supports username and password authentication from the environment", async () => {
		process.env.GIGACHAT_USER = "gigachat-user";
		process.env.GIGACHAT_PASSWORD = "gigachat-password";
		mockState.responseChunks = [
			toSSEChunk({
				choices: [
					{
						delta: { content: "Hello" },
						finish_reason: "stop",
					},
				],
			}),
		];

		const response = await complete(getModel("gigachat", "GigaChat-2"), {
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		});

		expect(mockState.constructorOptions).toMatchObject({
			user: "gigachat-user",
			password: "gigachat-password",
			model: "GigaChat-2",
		});
		expect(mockState.updateTokenCalls).toBe(1);
		expect(mockState.requestConfig).toMatchObject({
			headers: {
				Authorization: "Bearer gigachat-sdk-access-token",
			},
		});
		expect(response.stopReason).toBe("stop");
		expect(response.content[0]).toMatchObject({ type: "text", text: "Hello" });
	});

	it("serializes tool results as JSON strings for function messages", async () => {
		process.env.GIGACHAT_CREDENTIALS = "test-gigachat-credentials";
		mockState.responseChunks = [
			toSSEChunk({
				choices: [
					{
						delta: { content: "Hello" },
						finish_reason: "stop",
					},
				],
			}),
		];

		await complete(getModel("gigachat", "GigaChat-2"), {
			messages: [
				{ role: "user", content: "Read the file", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
					api: "gigachat",
					provider: "gigachat",
					model: "GigaChat-2",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		});

		expect(mockState.requestConfig).toMatchObject({
			data: {
				messages: [
					{ role: "user", content: "Read the file" },
					{ role: "assistant", function_call: { name: "read", arguments: { path: "README.md" } } },
					{ role: "function", name: "read", content: '"file contents"' },
				],
			},
		});
	});
});
