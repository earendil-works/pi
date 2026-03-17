import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";

const mockState = vi.hoisted(() => ({
	constructorOptions: undefined as Record<string, unknown> | undefined,
	streamPayload: undefined as Record<string, unknown> | undefined,
}));

vi.mock("gigachat", () => {
	class FakeGigaChat {
		constructor(options: Record<string, unknown>) {
			mockState.constructorOptions = options;
		}

		async *stream(payload: Record<string, unknown>) {
			mockState.streamPayload = payload;

			if (payload.model === "GigaChat-2-Pro") {
				yield {
					choices: [
						{
							delta: {
								function_call: {
									name: "get_weather",
									arguments: { city: "Moscow" },
								},
							},
							finish_reason: "function_call",
						},
					],
				};
				return;
			}

			yield {
				choices: [
					{
						delta: { content: "Hello" },
						finish_reason: "stop",
					},
				],
			};
		}
	}

	return { default: FakeGigaChat };
});

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
		mockState.streamPayload = undefined;
	});

	it("uses the official client with credentials-based auth and native function calling payloads", async () => {
		process.env.GIGACHAT_CREDENTIALS = "test-gigachat-credentials";
		process.env.GIGACHAT_SCOPE = "GIGACHAT_API_PERS";

		let capturedPayload: unknown;
		const response = await complete(
			getModel("gigachat", "GigaChat-2-Pro"),
			{
				messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
				tools: [
					{
						name: "get_weather",
						description: "Get the weather",
						parameters: Type.Object({
							city: Type.String(),
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
		expect((mockState.constructorOptions as { accessToken?: string } | undefined)?.accessToken).toBeUndefined();
		expect(capturedPayload).toMatchObject({
			model: "GigaChat-2-Pro",
			functions: [
				{
					name: "get_weather",
				},
			],
		});
		expect((capturedPayload as { stream?: boolean }).stream).toBe(true);
		expect(response.stopReason).toBe("toolUse");
		expect(response.content).toEqual([
			{
				type: "toolCall",
				id: "gigachat_0",
				name: "get_weather",
				arguments: { city: "Moscow" },
			},
		]);
	});

	it("uses a provided access token directly and honors the configured base URL override", async () => {
		process.env.GIGACHAT_ACCESS_TOKEN = "eyJ.test.token";
		process.env.GIGACHAT_BASE_URL = "https://gigachat-preview.devices.sberbank.ru/api/v1";

		const response = await complete(getModel("gigachat", "GigaChat-2"), {
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		});

		expect(mockState.constructorOptions).toMatchObject({
			accessToken: "eyJ.test.token",
			model: "GigaChat-2",
			baseUrl: "https://gigachat-preview.devices.sberbank.ru/api/v1",
		});
		expect((mockState.constructorOptions as { credentials?: string } | undefined)?.credentials).toBeUndefined();
		expect(mockState.streamPayload).toMatchObject({
			model: "GigaChat-2",
			stream: true,
			messages: [{ role: "user", content: "Hi" }],
		});
		expect(response.stopReason).toBe("stop");
		expect(response.content[0]).toMatchObject({ type: "text", text: "Hello" });
	});

	it("supports username and password authentication from the environment", async () => {
		process.env.GIGACHAT_USER = "gigachat-user";
		process.env.GIGACHAT_PASSWORD = "gigachat-password";

		const response = await complete(getModel("gigachat", "GigaChat-2"), {
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		});

		expect(mockState.constructorOptions).toMatchObject({
			user: "gigachat-user",
			password: "gigachat-password",
			model: "GigaChat-2",
		});
		expect((mockState.constructorOptions as { credentials?: string } | undefined)?.credentials).toBeUndefined();
		expect((mockState.constructorOptions as { accessToken?: string } | undefined)?.accessToken).toBeUndefined();
		expect(response.stopReason).toBe("stop");
		expect(response.content[0]).toMatchObject({ type: "text", text: "Hello" });
	});

	it("serializes tool results as JSON strings for function messages", async () => {
		process.env.GIGACHAT_CREDENTIALS = "test-gigachat-credentials";

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

		expect(mockState.streamPayload).toMatchObject({
			messages: [
				{ role: "user", content: "Read the file" },
				{ role: "assistant", function_call: { name: "read", arguments: { path: "README.md" } } },
				{ role: "function", name: "read", content: '"file contents"' },
			],
		});
	});
});
