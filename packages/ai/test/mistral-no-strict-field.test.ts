import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/mistral-conversations.ts";
import { complete, getModel } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface MistralWireTool {
	type: string;
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
		strict?: boolean;
	};
}

describe("Mistral tool wire format", () => {
	it("never sends a strict field on tool functions", async () => {
		const model: Model<"mistral-conversations"> = {
			...getModel("mistral", "devstral-medium-latest"),
			baseUrl: "http://127.0.0.1:9",
		};
		// Mix a constrained tool (which resolves strict sampling) with a plain tool,
		// mirroring real requests: pi's built-ins opt into constrained sampling while
		// extension tools do not.
		const context: Context = {
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools: [
				{
					name: "constrained_tool",
					description: "Opted into strict JSON schema sampling",
					parameters: Type.Object({ value: Type.String() }),
					constrainedSampling: { type: "json_schema", strict: "require" },
				},
				{
					name: "plain_tool",
					description: "No constrained sampling",
					parameters: Type.Object({ other: Type.Optional(Type.String()) }),
				},
			],
		};

		let capturedTools: MistralWireTool[] | undefined;
		await complete(model, context, {
			apiKey: "fake-key",
			onPayload: (payload) => {
				capturedTools = (payload as { tools?: MistralWireTool[] }).tools;
				return payload;
			},
		});

		expect(capturedTools).toHaveLength(2);
		// Mistral mangles streamed tool-call arguments (truncated to the first
		// property, or fragment soup) for at least the zai-glm models whenever any
		// tool function carries a strict field — true or false, uniformly or mixed.
		// The field must be absent everywhere.
		for (const tool of capturedTools ?? []) {
			expect("strict" in tool.function).toBe(false);
			expect(tool.function.strict).toBeUndefined();
		}
	});

	it("uses reasoning_effort for zai-glm-5-3 instead of the ignored prompt_mode", async () => {
		const model: Model<"mistral-conversations"> = {
			...getModel("mistral", "zai-glm-5-3"),
			baseUrl: "http://127.0.0.1:9",
		};
		const context: Context = {
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
		};

		let captured: Record<string, unknown> | undefined;
		const stream = streamSimple(model, normalizeContext(context), {
			apiKey: "fake-key",
			reasoning: "high",
			onPayload: (payload) => {
				captured = payload as Record<string, unknown>;
				return payload;
			},
		});
		await stream.result();

		expect(captured?.reasoningEffort).toBeDefined();
		expect(captured?.promptMode).toBeUndefined();
	});
});
