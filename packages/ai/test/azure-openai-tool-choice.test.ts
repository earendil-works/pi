import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream, streamSimple } from "../src/api/azure-openai-responses.ts";
import type { Model } from "../src/types.ts";

const model: Model<"azure-openai-responses"> = {
	id: "test-deployment",
	name: "Test Deployment",
	api: "azure-openai-responses",
	provider: "azure-openai-responses",
	baseUrl: "http://127.0.0.1:9/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

describe("Azure OpenAI tool choice", () => {
	it("forwards provider-specific tool choice while preserving tool definitions", async () => {
		let payload: unknown;
		const result = stream(
			model,
			{
				messages: [{ role: "user", content: "Summarize this", timestamp: 1 }],
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: Type.Object({ path: Type.String() }),
					},
				],
			},
			{
				apiKey: "test-key",
				toolChoice: "required",
				onPayload: (requestPayload) => {
					payload = requestPayload;
					throw new Error("payload captured");
				},
			},
		);

		await result.result();

		expect(payload).toMatchObject({ tool_choice: "required" });
		expect((payload as { tools?: unknown[] }).tools).toHaveLength(1);
	});

	it("forwards provider-neutral tool choice from simple options", async () => {
		let payload: unknown;
		const result = streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Summarize this", timestamp: 1 }],
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: Type.Object({ path: Type.String() }),
					},
				],
			},
			{
				apiKey: "test-key",
				toolChoice: "none",
				onPayload: (requestPayload) => {
					payload = requestPayload;
					throw new Error("payload captured");
				},
			},
		);

		await result.result();

		expect(payload).toMatchObject({ tool_choice: "none" });
		expect((payload as { tools?: unknown[] }).tools).toHaveLength(1);
	});
});
