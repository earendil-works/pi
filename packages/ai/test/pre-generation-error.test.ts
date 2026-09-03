import { describe, expect, it } from "vitest";
import { streamSimple as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { streamSimple as streamAzure } from "../src/api/azure-openai-responses.ts";
import { streamSimple as streamGoogle } from "../src/api/google-generative-ai.ts";
import { streamSimple as streamMistral } from "../src/api/mistral-conversations.ts";
import { streamSimple as streamCodex } from "../src/api/openai-codex-responses.ts";
import { streamSimple as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { streamSimple as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Api, AssistantMessageEventStream, Model } from "../src/types.ts";

function model<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: "test-model",
		name: "Test",
		api,
		provider: "test-provider",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000,
		maxTokens: 100,
	};
}

async function expectPreGenerationError(create: () => AssistantMessageEventStream): Promise<void> {
	const stream = create();
	const events = [];
	for await (const event of stream) events.push(event);
	expect(events.map((event) => event.type)).toEqual(["error"]);
	expect(await stream.result()).toMatchObject({ stopReason: "error", content: [] });
}

describe("direct API pre-generation errors", () => {
	it("return an error stream instead of throwing synchronously when auth is missing", async () => {
		await expectPreGenerationError(() => streamAnthropic(model("anthropic-messages"), { messages: [] }, {}));
		await expectPreGenerationError(() => streamAzure(model("azure-openai-responses"), { messages: [] }, {}));
		await expectPreGenerationError(() => streamGoogle(model("google-generative-ai"), { messages: [] }, {}));
		await expectPreGenerationError(() => streamMistral(model("mistral-conversations"), { messages: [] }, {}));
		await expectPreGenerationError(() => streamCodex(model("openai-codex-responses"), { messages: [] }, {}));
		await expectPreGenerationError(() => streamOpenAICompletions(model("openai-completions"), { messages: [] }, {}));
		await expectPreGenerationError(() => streamOpenAIResponses(model("openai-responses"), { messages: [] }, {}));
	});
});
