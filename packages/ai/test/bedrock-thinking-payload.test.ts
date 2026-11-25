import { describe, expect, it } from "vitest";
import { type BedrockOptions, stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Context, Model } from "../src/types.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";

interface BedrockThinkingPayload {
	additionalModelRequestFields?: {
		thinking?: {
			type: string;
			budget_tokens?: number;
			display?: string;
			block_binding?: { prefix_mismatch_behavior: string };
		};
		output_config?: { effort?: string };
		anthropic_beta?: string[];
		reasoning?: { effort?: string };
		reasoning_effort?: string;
	};
}

const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";
const ADAPTIVE_WITH_BINDING = {
	type: "adaptive",
	display: "summarized",
	block_binding: { prefix_mismatch_behavior: "drop_block" },
};

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"bedrock-converse-stream">,
	options?: BedrockOptions,
): Promise<BedrockThinkingPayload> {
	let capturedPayload: BedrockThinkingPayload | undefined;
	const s = streamBedrock(model, normalizeContext(makeContext()), {
		...options,
		reasoning: options?.reasoning ?? "high",
		onPayload: (payload) => {
			capturedPayload = payload as BedrockThinkingPayload;
			throw new PayloadCaptured();
		},
	});

	for await (const event of s) {
		if (event.type === "error") {
			break;
		}
	}

	if (!capturedPayload) {
		throw new Error("Expected Bedrock payload to be captured before request abort");
	}

	return capturedPayload;
}

describe("Bedrock thinking payload", () => {
	it("uses adaptive thinking for Claude Opus 4.8 when reasoning is enabled", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "global.anthropic.claude-opus-4-8-v1",
			name: "Claude Opus 4.8 (Global)",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([THINKING_BINDING_CONTROLS_BETA]);
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Opus 4.8", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "global.anthropic.claude-opus-4-8-v1",
			name: "Claude Opus 4.8 (Global)",
		};

		const payload = await capturePayload(model, { reasoning: "xhigh" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([THINKING_BINDING_CONTROLS_BETA]);
	});

	it("uses adaptive thinking for Claude Fable 5 when reasoning is enabled", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5");

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([THINKING_BINDING_CONTROLS_BETA]);
	});

	it("uses adaptive thinking for Claude Sonnet 5 when reasoning is enabled", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5");

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([THINKING_BINDING_CONTROLS_BETA]);
	});

	it("uses adaptive thinking for Claude Opus 5 when reasoning is enabled", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-5");

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([THINKING_BINDING_CONTROLS_BETA]);
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Opus 5", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-5");

		const payload = await capturePayload(model, { reasoning: "xhigh" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([THINKING_BINDING_CONTROLS_BETA]);
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Fable 5", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-fable-5");

		const payload = await capturePayload(model, { reasoning: "xhigh" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "xhigh" });
	});

	// https://github.com/earendil-works/pi/issues/10324
	it("sends block_binding and the binding beta for Claude Opus 5.5", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-5-5");

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual(ADAPTIVE_WITH_BINDING);
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual([THINKING_BINDING_CONTROLS_BETA]);
	});

	// Bedrock rejects block_binding on 4.6 models: "Extra inputs are not permitted" (#10324)
	it.each(["global.anthropic.claude-opus-4-6-v1", "global.anthropic.claude-sonnet-4-6"] as const)(
		"omits block_binding for %s",
		async (modelId) => {
			const model = getModel("amazon-bedrock", modelId);

			const payload = await capturePayload(model);

			expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
			expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
		},
	);

	it("omits display for GovCloud model ids on non-adaptive Claude thinking", async () => {
		const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0",
			name: "Claude Sonnet 4.5 (GovCloud)",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual(["interleaved-thinking-2025-05-14"]);
	});

	it("omits display for GovCloud regions on adaptive Claude thinking", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "global.anthropic.claude-opus-4-8-v1",
			name: "Claude Opus 4.8 (Global)",
		};

		const payload = await capturePayload(model, { region: "us-gov-west-1" });

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
		expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
	});
});

describe("Bedrock OpenAI reasoning payload", () => {
	// Regression for #9331: the configured thinking level never reached OpenAI models on Bedrock.
	it.each([
		["minimal", "low"],
		["low", "low"],
		["medium", "medium"],
		["high", "high"],
		["xhigh", "xhigh"],
		["max", "max"],
	] as const)("sends reasoning=%s as reasoning.effort=%s for GPT-6 and GPT-5.6", async (reasoning, effort) => {
		for (const id of ["global.openai.gpt-6-sol", "us.openai.gpt-6-luna", "global.openai.gpt-5.6-sol"] as const) {
			const payload = await capturePayload(getModel("amazon-bedrock", id), { reasoning });

			expect(payload.additionalModelRequestFields, id).toEqual({ reasoning: { effort } });
		}
	});

	it("sends reasoning.effort when only model.name identifies a GPT model", async () => {
		const model: Model<"bedrock-converse-stream"> = {
			...getModel("amazon-bedrock", "global.openai.gpt-6-sol"),
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "GPT-6 Sol",
		};

		const payload = await capturePayload(model, { reasoning: "medium" });

		expect(payload.additionalModelRequestFields).toEqual({ reasoning: { effort: "medium" } });
	});

	it("sends flat reasoning_effort for gpt-oss, clamped to high", async () => {
		const model = getModel("amazon-bedrock", "openai.gpt-oss-120b-1:0");

		expect((await capturePayload(model, { reasoning: "minimal" })).additionalModelRequestFields).toEqual({
			reasoning_effort: "low",
		});
		expect((await capturePayload(model, { reasoning: "medium" })).additionalModelRequestFields).toEqual({
			reasoning_effort: "medium",
		});
		expect((await capturePayload(model, { reasoning: "xhigh" })).additionalModelRequestFields).toEqual({
			reasoning_effort: "high",
		});
	});

	it("sends no reasoning fields when reasoning is off", async () => {
		let captured: BedrockThinkingPayload | undefined;
		const s = streamBedrock(getModel("amazon-bedrock", "global.openai.gpt-6-sol"), normalizeContext(makeContext()), {
			onPayload: (payload) => {
				captured = payload as BedrockThinkingPayload;
				throw new PayloadCaptured();
			},
		});
		for await (const event of s) {
			if (event.type === "error") break;
		}

		expect(captured).toBeDefined();
		expect(captured?.additionalModelRequestFields).toBeUndefined();
	});
});

describe("Bedrock flat reasoning_effort payload", () => {
	async function captureOffPayload(model: Model<"bedrock-converse-stream">): Promise<BedrockThinkingPayload> {
		let captured: BedrockThinkingPayload | undefined;
		const s = streamBedrock(model, normalizeContext(makeContext()), {
			onPayload: (payload) => {
				captured = payload as BedrockThinkingPayload;
				throw new PayloadCaptured();
			},
		});
		for await (const event of s) {
			if (event.type === "error") break;
		}
		if (!captured) throw new Error("Expected Bedrock payload to be captured before request abort");
		return captured;
	}

	// Regression for #12462: levels came from the generic default and no effort was sent.
	it.each([
		["global.moonshotai.kimi-k3.1", ["off", "low", "medium", "high", "xhigh", "max"]],
		["us.moonshotai.kimi-k3.1", ["off", "low", "medium", "high", "xhigh", "max"]],
		// GLM 5.3 always reasons and rejects none.
		["global.zai.glm-5.3", ["low", "medium", "high", "xhigh", "max"]],
	] as const)("offers the models.dev effort levels for %s", (id, levels) => {
		expect(getSupportedThinkingLevels(getModel("amazon-bedrock", id))).toEqual(levels);
	});

	it.each(["low", "medium", "high", "xhigh", "max"] as const)(
		"sends reasoning=%s as flat reasoning_effort",
		async (reasoning) => {
			for (const id of ["global.moonshotai.kimi-k3.1", "global.zai.glm-5.3"] as const) {
				const payload = await capturePayload(getModel("amazon-bedrock", id), { reasoning });

				expect(payload.additionalModelRequestFields, id).toEqual({ reasoning_effort: reasoning });
			}
		},
	);

	it("sends reasoning_effort=none when reasoning is off and the model maps off", async () => {
		const payload = await captureOffPayload(getModel("amazon-bedrock", "us.moonshotai.kimi-k3.1"));

		expect(payload.additionalModelRequestFields).toEqual({ reasoning_effort: "none" });
	});

	it("sends no reasoning_effort when reasoning is off and the model hides off", async () => {
		const payload = await captureOffPayload(getModel("amazon-bedrock", "us.zai.glm-5.3"));

		expect(payload.additionalModelRequestFields).toBeUndefined();
	});

	it("sends no reasoning_effort when the model lists no effort values", async () => {
		const model: Model<"bedrock-converse-stream"> = {
			...getModel("amazon-bedrock", "global.moonshotai.kimi-k3.1"),
			thinkingLevelMap: undefined,
		};

		const payload = await capturePayload(model, { reasoning: "medium" });

		expect(payload.additionalModelRequestFields).toBeUndefined();
	});
});

describe.skipIf(!hasBedrockCredentials())("Bedrock Claude max tokens E2E", () => {
	it(
		"uses the model maxTokens cap instead of Bedrock's 4096-token default for adaptive Claude models",
		{ retry: 2, timeout: 180000 },
		async () => {
			const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6");
			const model: Model<"bedrock-converse-stream"> = {
				...baseModel,
				maxTokens: 6000,
			};

			const response = await streamBedrock(
				model,
				normalizeContext({
					systemPrompt: "You are a deterministic text generator. Follow the requested output format exactly.",
					messages: [
						{
							role: "user",
							content:
								"Output exactly 5200 repetitions of the token alpha, separated by single spaces. Do not number them. Do not use markdown. Do not add any other text.",
							timestamp: Date.now(),
						},
					],
				}),
				{ reasoning: "low" },
			).result();

			expect(response.stopReason, response.errorMessage).not.toBe("error");
			expect(response.usage.output).toBeGreaterThan(4096);
		},
	);
});

describe("Application inference profile support", () => {
	it("uses adaptive thinking when model.name contains the model name but ARN does not", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "Claude Opus 4.6",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "high" });
	});

	it("injects cache points when model.name identifies a supported Claude model", async () => {
		const baseModel = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "Claude Sonnet 4.6",
		};

		let capturedPayload: any;
		const s = streamBedrock(
			model,
			normalizeContext({
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
			}),
			{
				onPayload: (payload) => {
					capturedPayload = payload;
					throw new PayloadCaptured();
				},
			},
		);

		for await (const event of s) {
			if (event.type === "error") break;
		}

		// System prompt should have a cache point
		expect(capturedPayload.system).toHaveLength(2);
		expect(capturedPayload.system[1]).toHaveProperty("cachePoint");

		// Last user message should have a cache point
		const lastMsg = capturedPayload.messages[capturedPayload.messages.length - 1];
		const lastContent = lastMsg.content[lastMsg.content.length - 1];
		expect(lastContent).toHaveProperty("cachePoint");
	});

	it("falls back to fixed-budget thinking for non-adaptive Claude via model.name", async () => {
		const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
			name: "Claude Sonnet 4.5",
		};

		const payload = await capturePayload(model);

		expect(payload.additionalModelRequestFields?.thinking).toMatchObject({
			type: "enabled",
			budget_tokens: expect.any(Number),
		});
		expect(payload.additionalModelRequestFields?.anthropic_beta).toEqual(["interleaved-thinking-2025-05-14"]);
	});
});
