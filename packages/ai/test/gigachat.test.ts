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
			dangerouslyAllowBrowser: true,
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
});
