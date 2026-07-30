import { beforeEach, describe, expect, it, vi } from "vitest";

const mistralMock = vi.hoisted(() => ({
	finishReason: "stop" as string,
}));

vi.mock("@mistralai/mistralai", () => {
	class HTTPClient {}

	class Mistral {
		chat = {
			stream: async function* () {
				yield {
					data: {
						id: "mistral-response-id",
						choices: [
							{
								finishReason: mistralMock.finishReason,
								delta: {},
							},
						],
						usage: {
							promptTokens: 1,
							completionTokens: 0,
							totalTokens: 1,
						},
					},
				};
			},
		};
	}

	return { HTTPClient, Mistral };
});

import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";

const model = getModel("mistral", "devstral-medium-latest");
const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

describe("Mistral raw stop reasons", () => {
	beforeEach(() => {
		mistralMock.finishReason = "stop";
	});

	it("preserves raw Mistral finish reasons for successful stops", async () => {
		const message = await streamMistral(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.rawStopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
	});

	it("preserves raw Mistral finish reasons for provider error stops", async () => {
		mistralMock.finishReason = "error";

		const message = await streamMistral(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("error");
		expect(message.errorMessage).toBe("Provider stopped with: error");
	});

	it("treats unknown Mistral finish reasons as provider error stops", async () => {
		mistralMock.finishReason = "unmapped_error";

		const message = await streamMistral(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("unmapped_error");
		expect(message.errorMessage).toBe("Provider stopped with: unmapped_error");
	});
});
