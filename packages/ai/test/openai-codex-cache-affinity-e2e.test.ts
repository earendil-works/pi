import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { Context } from "../src/types.js";
import { resolveApiKey } from "./oauth.js";

const codexToken = await resolveApiKey("openai-codex");

describe("openai-codex cache affinity e2e", () => {
	it.skipIf(!codexToken)("handles SSE requests with aligned cache-affinity identifiers", async () => {
		const model = getModel("openai-codex", "gpt-5.3-codex");
		const sessionId = "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3";
		const context: Context = {
			systemPrompt: "You are a helpful assistant. Reply exactly as requested.",
			messages: [
				{
					role: "user",
					content: "Reply with exactly: cache affinity e2e success",
					timestamp: Date.now(),
				},
			],
		};

		const response = await complete(model, context, {
			apiKey: codexToken,
			sessionId,
			transport: "sse",
		});

		expect(response.stopReason, response.errorMessage).not.toBe("error");
		expect(response.errorMessage).toBeUndefined();
		expect(response.content.map((block) => (block.type === "text" ? block.text : "")).join("")).toContain(
			"cache affinity e2e success",
		);
	});
});
