import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { Context } from "../src/types.js";

describe.skipIf(!process.env.OPENAI_API_KEY)("openai responses cache affinity e2e", () => {
	it("handles direct OpenAI Responses requests with aligned cache-affinity identifiers", { retry: 2 }, async () => {
		const model = getModel("openai", "gpt-5.4");
		const sessionId = "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3";
		const context: Context = {
			systemPrompt: "You are a helpful assistant. Reply exactly as requested.",
			messages: [
				{
					role: "user",
					content: "Reply with exactly: openai cache affinity e2e success",
					timestamp: Date.now(),
				},
			],
		};

		const response = await complete(model, context, {
			apiKey: process.env.OPENAI_API_KEY!,
			sessionId,
		});

		expect(response.stopReason, response.errorMessage).not.toBe("error");
		expect(response.errorMessage).toBeUndefined();
		expect(response.content.map((block) => (block.type === "text" ? block.text : "")).join("")).toContain(
			"openai cache affinity e2e success",
		);
	});
});
