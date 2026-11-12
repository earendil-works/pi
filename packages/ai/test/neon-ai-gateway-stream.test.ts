import { describe, expect, it } from "vitest";
import { NEON_AI_GATEWAY_BASE_URL, neonAIGatewayStreams } from "../src/providers/neon-ai-gateway-stream.ts";
import type { Api, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<Api> = {
	id: "model",
	name: "model",
	api: "anthropic-messages",
	provider: "neon-ai-gateway",
	baseUrl: `${NEON_AI_GATEWAY_BASE_URL}/anthropic`,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const context = normalizeContext({ messages: [] });

function capturingStreams(captured: string[]) {
	return neonAIGatewayStreams({
		stream: (requestModel) => {
			captured.push(requestModel.baseUrl);
			return new AssistantMessageEventStream();
		},
		streamSimple: (requestModel) => {
			captured.push(requestModel.baseUrl);
			return new AssistantMessageEventStream();
		},
	});
}

describe("Neon AI Gateway provider streams", () => {
	it("materializes the branch host before dispatch", () => {
		const captured: string[] = [];
		const streams = capturingStreams(captured);
		const env = { NEON_AI_GATEWAY_BASE_URL: "https://br-example-api.ai.c-1.us-east-2.aws.neon.tech/" };

		streams.stream(model, context, { env });
		streams.streamSimple(model, context, { env });

		expect(captured).toEqual([
			"https://br-example-api.ai.c-1.us-east-2.aws.neon.tech/anthropic",
			"https://br-example-api.ai.c-1.us-east-2.aws.neon.tech/anthropic",
		]);
	});

	it("keeps the placeholder when the provider env does not resolve it", () => {
		const captured: string[] = [];
		capturingStreams(captured).streamSimple(model, context, {});

		expect(captured).toEqual([model.baseUrl]);
	});
});
