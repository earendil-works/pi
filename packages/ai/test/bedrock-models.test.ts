/**
 * A test suite to ensure all configured Amazon Bedrock models are usable.
 *
 * This is here to make sure we got correct model identifiers from models.dev and other sources.
 * Because Amazon Bedrock requires cross-region inference in some models,
 * plain model identifiers are not always usable and it requires tweaking of model identifiers to use cross-region inference.
 * See https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html#inference-profiles-support-system for more details.
 *
 * This test suite is not enabled by default unless AWS credentials and `BEDROCK_EXTENSIVE_MODEL_TEST` environment variables are set.
 * This test suite takes ~2 minutes to run. Because not all models are available in all regions,
 * it's recommended to use `us-west-2` region for best coverage for running this test suite.
 *
 * You can run this test suite with:
 * ```bash
 * $ AWS_REGION=us-west-2 BEDROCK_EXTENSIVE_MODEL_TEST=1 AWS_PROFILE=... npm test -- ./test/bedrock-models.test.ts
 * ```
 */

import { describe, expect, it } from "vitest";
import { complete } from "../src/index.ts";
import { getModels } from "../src/models.ts";
import type { Context } from "../src/types.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";

describe("Amazon Bedrock Models", () => {
	const models = getModels("amazon-bedrock");

	it("should get all available Bedrock models", () => {
		expect(models.length).toBeGreaterThan(0);
		console.log(`Found ${models.length} Bedrock models`);
	});

	if (hasBedrockCredentials() && process.env.BEDROCK_EXTENSIVE_MODEL_TEST) {
		for (const model of models) {
			it(`should make a simple request with ${model.id}`, { timeout: 10_000 }, async () => {
				const context: Context = {
					systemPrompt: "You are a helpful assistant. Be extremely concise.",
					messages: [
						{
							role: "user",
							content: "Reply with exactly: 'OK'",
							timestamp: Date.now(),
						},
					],
				};

				const response = await complete(model, context);

				expect(response.role).toBe("assistant");
				expect(response.content).toBeTruthy();
				expect(response.content.length).toBeGreaterThan(0);
				expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
				expect(response.usage.output).toBeGreaterThan(0);
				expect(response.errorMessage).toBeFalsy();

				const textContent = response.content
					.filter((b) => b.type === "text")
					.map((b) => (b.type === "text" ? b.text : ""))
					.join("")
					.trim();
				expect(textContent).toBeTruthy();
				console.log(`${model.id}: ${textContent.substring(0, 100)}`);
			});
		}
	}
});
