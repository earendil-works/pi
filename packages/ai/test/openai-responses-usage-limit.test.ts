import { describe, expect, it } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const usageLimitError = {
	code: "subscription_sharing_usage_limit_exceeded",
	message: "Usage limit reached.",
};

const model: Model<"openai-responses"> = {
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const context = normalizeContext({
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
});

async function getErrorMessage(response: Response): Promise<string | undefined> {
	const result = await streamOpenAIResponses(model, context, {
		apiKey: "test",
		fetch: async () => response,
	}).result();
	expect(result.stopReason).toBe("error");
	return result.errorMessage;
}

describe("OpenAI Responses ChatGPT usage limit", () => {
	it("links to ChatGPT usage when the request is rejected", async () => {
		const response = new Response(JSON.stringify({ error: { ...usageLimitError, type: "rate_limit_error" } }), {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		const errorMessage = await getErrorMessage(response);

		expect(errorMessage).toContain("subscription_sharing_usage_limit_exceeded");
		expect(errorMessage).toContain("Check your ChatGPT usage: https://chatgpt.com/settings/usage");
	});

	it("links to ChatGPT usage when the stream fails", async () => {
		const event = {
			type: "response.failed",
			sequence_number: 0,
			response: { id: "resp_failed", status: "failed", error: usageLimitError },
		};
		const response = new Response(`event: response.failed\ndata: ${JSON.stringify(event)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const errorMessage = await getErrorMessage(response);

		expect(errorMessage).toContain("subscription_sharing_usage_limit_exceeded: Usage limit reached.");
		expect(errorMessage).toContain("Check your ChatGPT usage: https://chatgpt.com/settings/usage");
	});
});
