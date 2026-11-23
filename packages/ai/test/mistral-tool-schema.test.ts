import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { complete, getModel } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

interface MistralToolPayload {
	tools?: Array<{
		type: "function";
		function: {
			name: string;
			parameters: Record<string, unknown>;
			strict?: boolean;
		};
	}>;
}

describe("Mistral tool schema serialization", () => {
	it("strips TypeBox symbol keys before the SDK validates tool schemas", async () => {
		const model: Model<"mistral-conversations"> = {
			...getModel("mistral", "mistral-medium-latest"),
			baseUrl: "http://127.0.0.1:9",
			compat: { supportsStrictMode: true },
		};
		const parameters = Type.Object({
			nested: Type.Object({
				value: Type.String(),
			}),
		});
		const context: Context = {
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools: [
				{
					name: "inspect_schema",
					description: "Inspect the schema",
					parameters,
					constrainedSampling: { type: "json_schema", strict: "require" },
				},
			],
		};
		let capturedPayload: MistralToolPayload | undefined;

		const response = await complete(model, context, {
			apiKey: "fake-key",
			onPayload: (payload) => {
				capturedPayload = payload as MistralToolPayload;
				return payload;
			},
		});

		expect(capturedPayload?.tools).toHaveLength(1);
		expect(capturedPayload?.tools?.[0]?.function.strict).toBe(true);
		const payloadParameters = capturedPayload?.tools?.[0]?.function.parameters;
		expect(payloadParameters).toBeDefined();
		expect(Object.getOwnPropertySymbols(payloadParameters ?? {})).toHaveLength(0);
		const properties = payloadParameters?.properties;
		expect(properties).toBeTruthy();
		expect(Object.getOwnPropertySymbols((properties as Record<string, unknown>) ?? {})).toHaveLength(0);
		const nested = (properties as Record<string, unknown> | undefined)?.nested;
		expect(nested).toBeTruthy();
		expect(Object.getOwnPropertySymbols((nested as Record<string, unknown>) ?? {})).toHaveLength(0);
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).not.toContain("Input validation failed");
	});

	// #12148: Mistral Large 4 stalls for minutes before strict tool calls.
	it("does not send strict tools unless the model enables strict mode", async () => {
		const model: Model<"mistral-conversations"> = {
			...getModel("mistral", "mistral-large-4"),
			baseUrl: "http://127.0.0.1:9",
		};
		const context: Context = {
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools: [
				{
					name: "read",
					description: "Read a file",
					parameters: Type.Object({ path: Type.String(), limit: Type.Optional(Type.Number()) }),
					constrainedSampling: { type: "json_schema", strict: "prefer" },
				},
			],
		};
		let capturedPayload: MistralToolPayload | undefined;

		await complete(model, context, {
			apiKey: "fake-key",
			onPayload: (payload) => {
				capturedPayload = payload as MistralToolPayload;
				return payload;
			},
		});

		expect(capturedPayload?.tools?.[0]?.function.strict).toBe(false);
		expect(capturedPayload?.tools?.[0]?.function.parameters.required).toEqual(["path"]);
	});
});
