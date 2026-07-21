import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AmazonBedrockMantleOpenAIResponsesOptions,
	stream as streamAmazonBedrockMantleOpenAIResponses,
} from "../src/api/amazon-bedrock-mantle-openai-responses.ts";
import { resolveBedrockMantleEndpoint } from "../src/api/amazon-bedrock-mantle-region.ts";
import { AMAZON_BEDROCK_MANTLE_OPENAI_RESPONSES_MODELS } from "../src/providers/amazon-bedrock-mantle-openai-responses.models.ts";
import type { Context, Model } from "../src/types.ts";

const TEMPLATE_BASE_URL = `https://bedrock-mantle.\${AWS_REGION}.api.aws/openai/v1`;
const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function completedResponse(): Response {
	const event = {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_bedrock_mantle_test",
			status: "completed",
			output: [],
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	};
	return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function captureRequestUrl(
	model: Model<"amazon-bedrock-mantle-openai-responses">,
	options: AmazonBedrockMantleOpenAIResponsesOptions,
): Promise<string> {
	let url: string | undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		url = new Request(input, init).url;
		return completedResponse();
	});

	const result = await streamAmazonBedrockMantleOpenAIResponses(model, context, {
		bearerToken: "test-token",
		...options,
	}).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	expect(url).toBeDefined();
	return url!;
}

describe("Amazon Bedrock Mantle region routing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("generates region-placeholder endpoints", () => {
		for (const model of Object.values(AMAZON_BEDROCK_MANTLE_OPENAI_RESPONSES_MODELS)) {
			expect(model.baseUrl).toBe(TEMPLATE_BASE_URL);
		}
	});

	it("uses the requested region when the model is available there", async () => {
		const model = AMAZON_BEDROCK_MANTLE_OPENAI_RESPONSES_MODELS["openai.gpt-5.4"];
		expect(await captureRequestUrl(model, { env: { AWS_REGION: "us-west-2" } })).toBe(
			"https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses",
		);
	});

	it("falls back when the model is unavailable in the requested region", async () => {
		const model = AMAZON_BEDROCK_MANTLE_OPENAI_RESPONSES_MODELS["openai.gpt-5.6-sol"];
		expect(await captureRequestUrl(model, { env: { AWS_REGION: "us-west-2" } })).toBe(
			"https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses",
		);
	});

	it.each([
		["openai.gpt-5.4", "us-gov-west-1", "us-gov-west-1"],
		["openai.gpt-5.5", "us-west-2", "us-east-2"],
		["openai.gpt-5.6-sol", "us-west-2", "us-east-2"],
		["openai.gpt-5.6-terra", "us-west-2", "us-west-2"],
		["openai.gpt-5.6-luna", "us-west-2", "us-west-2"],
		["xai.grok-4.3", "us-west-2", "us-west-2"],
	])("routes %s requested in %s through %s", (modelId, requestedRegion, expectedRegion) => {
		expect(resolveBedrockMantleEndpoint(modelId, TEMPLATE_BASE_URL, { region: requestedRegion })).toEqual({
			baseUrl: `https://bedrock-mantle.${expectedRegion}.api.aws/openai/v1`,
			region: expectedRegion,
		});
	});

	it("uses the explicit region before scoped environment values", () => {
		expect(
			resolveBedrockMantleEndpoint("openai.gpt-5.6-terra", TEMPLATE_BASE_URL, {
				region: "us-east-1",
				env: { AWS_REGION: "us-west-2", AWS_DEFAULT_REGION: "us-east-2" },
			}),
		).toEqual({
			baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
			region: "us-east-1",
		});
	});

	it("uses AWS_DEFAULT_REGION when AWS_REGION is unset", () => {
		expect(
			resolveBedrockMantleEndpoint("openai.gpt-5.4", TEMPLATE_BASE_URL, {
				env: { AWS_REGION: " ", AWS_DEFAULT_REGION: "us-west-2" },
			}),
		).toEqual({
			baseUrl: "https://bedrock-mantle.us-west-2.api.aws/openai/v1",
			region: "us-west-2",
		});
	});

	it("preserves an explicit fixed endpoint and its signing region", () => {
		expect(
			resolveBedrockMantleEndpoint("openai.gpt-5.6-sol", "https://bedrock-mantle.us-east-1.api.aws/openai/v1", {
				env: { AWS_REGION: "us-east-2" },
			}),
		).toEqual({
			baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
			region: "us-east-1",
		});
	});
});
