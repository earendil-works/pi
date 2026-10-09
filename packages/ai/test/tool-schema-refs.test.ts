import { describe, expect, it } from "vitest";
import { resolveJsonSchemaStrictSampling } from "../src/api/constrained-sampling.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model, OpenAICompletionsCompat, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

class PayloadCaptured extends Error {}

const settings = {
	type: "object",
	properties: { notifications: { type: "boolean" } },
	required: ["notifications"],
	additionalProperties: false,
};

function issueTool(): Tool {
	return {
		name: "fixture_record",
		description: "Record a check",
		parameters: {
			type: "object",
			properties: {
				attempts: { type: "integer", enum: [1, 3] },
				settings: { $ref: "#/$defs/Settings" },
			},
			required: ["attempts", "settings"],
			additionalProperties: false,
			$defs: { Settings: settings },
		} as Tool["parameters"],
	};
}

function createModel(provider: string, baseUrl: string, compat?: OpenAICompletionsCompat): Model<"openai-completions"> {
	return {
		id: "nvidia/nemotron-3.5-super-vl-preview",
		name: "Nemotron",
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 1024,
		...(compat ? { compat } : {}),
	};
}

async function captureToolParameters(model: Model<"openai-completions">, tool: Tool): Promise<Record<string, unknown>> {
	let payload: { tools: { function: { parameters: Record<string, unknown> } }[] } | undefined;
	await streamOpenAICompletions(
		model,
		normalizeContext({ messages: [{ role: "user", content: "Use the tool", timestamp: 1 }], tools: [tool] }),
		{
			apiKey: "test",
			onPayload: (value) => {
				payload = value as typeof payload;
				throw new PayloadCaptured();
			},
		},
	).result();
	const parameters = payload?.tools[0]?.function.parameters;
	if (!parameters) throw new Error("Expected tool parameters in the captured payload");
	return parameters;
}

const nvidia = () => createModel("nvidia", "https://integrate.api.nvidia.com/v1");
const custom = (compat?: OpenAICompletionsCompat) => createModel("local-vllm", "http://localhost:8000/v1", compat);

describe("openai-completions inlineSchemaRefs", () => {
	// https://github.com/earendil-works/pi/issues/10270
	it("inlines local references for NVIDIA NIM by default", async () => {
		const tool = issueTool();
		const original = structuredClone(tool.parameters);

		expect(await captureToolParameters(nvidia(), tool)).toEqual({
			type: "object",
			properties: { attempts: { type: "integer", enum: [1, 3] }, settings },
			required: ["attempts", "settings"],
			additionalProperties: false,
		});
		expect(tool.parameters).toEqual(original);
	});

	it("sends references unchanged for other endpoints unless enabled", async () => {
		const tool = issueTool();

		expect(await captureToolParameters(custom(), tool)).toEqual(tool.parameters);
		expect(
			await captureToolParameters(
				createModel("nvidia", "https://integrate.api.nvidia.com/v1", { inlineSchemaRefs: false }),
				tool,
			),
		).toEqual(tool.parameters);
		expect((await captureToolParameters(custom({ inlineSchemaRefs: true }), tool)).properties).toEqual({
			attempts: { type: "integer", enum: [1, 3] },
			settings,
		});
	});

	it("keeps strict fallback for referenced schemas", () => {
		const tool: Tool = { ...issueTool(), constrainedSampling: { type: "json_schema", strict: "prefer" } };
		expect(resolveJsonSchemaStrictSampling(tool, true)).toBeUndefined();
	});
});
