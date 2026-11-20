import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple as streamOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

const model: Model<"openai-responses"> = {
	id: "gpt-6.2-sol",
	name: "GPT-6.2 Sol",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};

function createOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

/** Run one terminal response event carrying `inputTransformations` through the shared stream processor. */
async function processTerminalResponse(
	inputTransformations: unknown,
	status: "completed" | "incomplete" = "completed",
): Promise<AssistantMessage> {
	const response: Record<string, unknown> = {
		id: "resp_transformations",
		status,
		output: [],
		...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
	};
	if (inputTransformations !== undefined) response.input_transformations = inputTransformations;
	async function* events(): AsyncIterable<ResponseStreamEvent> {
		yield {
			type: status === "incomplete" ? "response.incomplete" : "response.completed",
			sequence_number: 0,
			response,
		} as unknown as ResponseStreamEvent;
	}
	const output = createOutput();
	await processResponsesStream(events(), output, new AssistantMessageEventStream(), model);
	return output;
}

const prefixMismatch = { type: "reasoning", id: "rs_edited", action: "removed", reason: "prefix_mismatch" };
const organizationMismatch = { type: "reasoning", id: "rs_org", action: "removed", reason: "organization_mismatch" };
const turnBoundary = { type: "reasoning", id: "rs_old_turn", action: "removed", reason: "turn_boundary" };

describe("OpenAI Responses reasoning removals", () => {
	it("records removed reasoning items with their reasons", async () => {
		const output = await processTerminalResponse([prefixMismatch, turnBoundary, organizationMismatch]);

		expect(output.stopReason).toBe("stop");
		expect(output.diagnostics).toEqual([
			{
				type: "openai_input_transformations",
				timestamp: expect.any(Number),
				details: { transformations: [prefixMismatch, organizationMismatch] },
			},
		]);
	});

	it("records removals on incomplete responses", async () => {
		const output = await processTerminalResponse([prefixMismatch], "incomplete");

		expect(output.stopReason).toBe("length");
		expect(output.diagnostics?.[0]?.details).toEqual({ transformations: [prefixMismatch] });
	});

	it("keeps reasons the SDK does not know yet", async () => {
		const futureReason = { type: "reasoning", id: "rs_future", action: "removed", reason: "future_reason" };
		const output = await processTerminalResponse([futureReason]);

		expect(output.diagnostics?.[0]?.details).toEqual({ transformations: [futureReason] });
	});

	it("ignores turn boundaries, other transformations and malformed reports", async () => {
		// Models before GPT-5.6 report every earlier turn's reasoning as a turn boundary on each request.
		const reports: unknown[] = [
			undefined,
			null,
			[],
			[turnBoundary, turnBoundary],
			{ malformed: true },
			[null, "rs_text", { type: "message", id: "msg_1", action: "removed", reason: "prefix_mismatch" }],
			[{ type: "reasoning", id: "rs_changed", action: "changed", reason: "prefix_mismatch" }],
		];
		for (const report of reports) {
			const output = await processTerminalResponse(report);
			expect(output.stopReason, JSON.stringify(report)).toBe("stop");
			expect(output.diagnostics, JSON.stringify(report)).toBeUndefined();
		}
	});

	it("records removals that Codex reports in response.done", async () => {
		const encoder = new TextEncoder();
		const terminal = {
			type: "response.done",
			response: {
				id: "resp_codex",
				status: "completed",
				output: [],
				input_transformations: [prefixMismatch, turnBoundary],
			},
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(terminal)}\n\n`));
								controller.close();
							},
						}),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
			),
		);
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
			"utf8",
		).toString("base64");
		const codexModel: Model<"openai-codex-responses"> = {
			...model,
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
		};

		const result = await streamOpenAICodexResponses(
			codexModel,
			normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
			{ apiKey: `aaa.${payload}.bbb`, transport: "sse" },
		).result();

		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.diagnostics).toEqual([
			{
				type: "openai_input_transformations",
				timestamp: expect.any(Number),
				details: { transformations: [prefixMismatch] },
			},
		]);
	});
});
