import { describe, expect, it } from "vitest";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { getModel } from "../src/compat.ts";
import type { Context, FetchFunction } from "../src/types.ts";

const model = getModel("mistral", "devstral-medium-latest");
const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function createFetch(finishReason: string): FetchFunction {
	return async () =>
		new Response(
			`data: ${JSON.stringify({
				id: "mistral-response-id",
				model: model.id,
				choices: [
					{
						index: 0,
						finish_reason: finishReason,
						delta: {},
					},
				],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 0,
					total_tokens: 1,
				},
			})}\n\ndata: [DONE]\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
}

describe("Mistral raw stop reasons", () => {
	it("preserves raw Mistral finish reasons for successful stops", async () => {
		const message = await streamMistral(model, context, { apiKey: "test", fetch: createFetch("stop") }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.rawStopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
	});

	it("preserves raw Mistral finish reasons for provider error stops", async () => {
		const message = await streamMistral(model, context, { apiKey: "test", fetch: createFetch("error") }).result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("error");
		expect(message.errorMessage).toBe("Provider stopped with: error");
	});

	it("treats unknown Mistral finish reasons as provider error stops", async () => {
		const message = await streamMistral(model, context, {
			apiKey: "test",
			fetch: createFetch("unmapped_error"),
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("unmapped_error");
		expect(message.errorMessage).toBe("Provider stopped with: unmapped_error");
	});
});
