import Anthropic from "@anthropic-ai/sdk";
import type { BetaTool, MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { type AnthropicOptions, stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamPiMessages } from "../src/api/pi-messages.ts";
import type { Model, Tool, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const grammarError =
	"The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.";
const model: Model<"anthropic-messages"> = {
	id: "claude-haiku-4-5",
	name: "Test Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://anthropic.example",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 100,
	compat: { supportsStrictTools: true },
};

function tool(name: string, strict?: "prefer" | "require"): Tool {
	return {
		name,
		description: "Look up a value",
		parameters: Type.Object({ value: Type.String(), optional: Type.Optional(Type.Number()) }),
		...(strict ? { constrainedSampling: { type: "json_schema", strict } } : {}),
	};
}

function context(tools: Tool[]): TranscriptContext {
	return normalizeContext({ tools, messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
}

function errorResponse(message = grammarError, status = 400, type = "invalid_request_error"): Response {
	return Response.json({ type: "error", error: { type, message } }, { status });
}

function successResponse(): Response {
	const events = [
		{
			type: "message_start",
			message: { id: "msg_test", model: model.id, usage: { input_tokens: 10, output_tokens: 0 } },
		},
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function harness(respond: (payload: MessageCreateParamsStreaming, attempt: number) => Response) {
	const payloads: MessageCreateParamsStreaming[] = [];
	const fetch: NonNullable<AnthropicOptions["fetch"]> = async (_input, init) => {
		const payload = JSON.parse(init?.body as string) as MessageCreateParamsStreaming;
		payloads.push(payload);
		return respond(payload, payloads.length);
	};
	return { payloads, options: { apiKey: "test-key", fetch, maxRetries: 0 } satisfies AnthropicOptions };
}

// Regression tests for https://github.com/earendil-works/pi/issues/10409.
describe("Anthropic preferred strict tool fallback", () => {
	it.each([
		grammarError,
		// Observed from the live API: 32 strict tools, then 20 tools with 24 optional fields each.
		"Too many strict tools (32). The maximum number of strict tools supported is 20. Try reducing the number of tools marked as strict.",
		"Schemas contains too many parameters with union types (480 parameters with type arrays or anyOf). This causes exponential compilation cost. Reduce the number of nullable or union-typed parameters (limit: 16 parameters with unions).",
	])("retries %s with original non-strict schemas and preserves required tools", async (message) => {
		const preferred = tool("preferred", "prefer");
		const required = tool("required", "require");
		const ordinary = tool("ordinary");
		const transcript = context([preferred, required, ordinary]);
		const original = JSON.stringify(transcript);
		// Use the real SDK's HTTP error parsing, not a synthetic thrown Error.
		const { payloads, options } = harness((_payload, attempt) =>
			attempt === 1 ? errorResponse(message) : successResponse(),
		);
		const onPayload = vi.fn((payload: unknown) => ({
			...(payload as MessageCreateParamsStreaming),
			inference_geo: "us",
			stream: false,
		}));
		const onResponse = vi.fn();
		const stream = streamAnthropic(model, transcript, { ...options, onPayload, onResponse, cacheRetention: "long" });
		const events: string[] = [];
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(events).toEqual(["start", "done"]);
		expect(payloads).toHaveLength(2);
		expect(onPayload).toHaveBeenCalledTimes(2);
		expect(onResponse).toHaveBeenCalledTimes(1);
		const first = payloads[0].tools as BetaTool[];
		const second = payloads[1].tools as BetaTool[];
		expect(first[0]).toMatchObject({
			strict: true,
			input_schema: {
				required: ["value", "optional"],
				properties: { optional: { anyOf: [{ type: "number" }, { type: "null" }] } },
			},
		});
		expect(second[0].strict).toBeUndefined();
		expect(second[0].input_schema).toEqual({
			type: "object",
			properties: { value: { type: "string" }, optional: { type: "number" } },
			required: ["value"],
		});
		expect(second[1]).toEqual(first[1]);
		expect(second[1].strict).toBe(true);
		expect(second[2]).toEqual(first[2]);
		expect(second[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(payloads.map((payload) => payload.stream)).toEqual([true, true]);
		expect(payloads[1]).toMatchObject({ inference_geo: "us" });
		expect(JSON.stringify(transcript)).toBe(original);
		expect(result.diagnostics?.[0]).toMatchObject({
			type: "anthropic_strict_tools_fallback",
			details: { reason: "strict_tool_limits_exceeded" },
		});
	});

	it("downgrades inline additions and same-name redefinitions without downgrading require", async () => {
		const transcript = context([tool("lookup", "require")]);
		transcript.messages.push(
			{ role: "system", content: "", toolsAdded: [tool("lookup", "prefer")], timestamp: 2 },
			{ role: "system", content: "", toolsAdded: [tool("lookup", "require")], timestamp: 3 },
		);
		const { payloads, options } = harness((_payload, attempt) =>
			attempt === 1 ? errorResponse() : successResponse(),
		);
		const result = await streamAnthropic(
			{
				...model,
				compat: { ...model.compat, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
			},
			transcript,
			{ ...options, apiKey: "sk-ant-oat-test" },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(payloads).toHaveLength(2);
		expect(payloads[1].tools).toEqual(payloads[0].tools);
		const additions = payloads.map((payload) =>
			payload.messages.flatMap((message) =>
				Array.isArray(message.content)
					? message.content.flatMap((block) =>
							block.type === "tool_addition" && block.tool.type === "tool_definition"
								? [block.tool.definition as BetaTool]
								: [],
						)
					: [],
			),
		);
		expect(additions[0].map((definition) => definition.strict)).toEqual([true, true]);
		expect(additions[1].map((definition) => definition.strict)).toEqual([undefined, true]);
		expect(additions[1][0].input_schema.required).toEqual(["value"]);
		expect(additions[1][1]).toEqual(additions[0][1]);
	});

	it.each([
		["required", [tool("lookup", "require")]],
		["ordinary", [tool("lookup")]],
		[
			"locally unsupported prefer",
			[{ ...tool("lookup", "prefer"), parameters: Type.Object({ value: Type.Number({ minimum: 1 }) }) }],
		],
	])("does not retry a %s tool set", async (_name, tools) => {
		const { payloads, options } = harness(() => errorResponse());
		const result = await streamAnthropic(model, context(tools), options).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(grammarError);
		expect(payloads).toHaveLength(1);
	});

	it.each([
		["unrelated 400", "Invalid tool schema", 400, "invalid_request_error"],
		["wrong error type", grammarError, 400, "authentication_error"],
		["wrong HTTP status", grammarError, 500, "invalid_request_error"],
	])("does not downgrade on %s", async (_name, message, status, type) => {
		const { payloads, options } = harness(() => errorResponse(message, status, type));
		const result = await streamAnthropic(model, context([tool("lookup", "prefer")]), options).result();
		expect(result.stopReason).toBe("error");
		expect(payloads).toHaveLength(1);
	});

	it("surfaces a second rejection rather than retrying again", async () => {
		const { payloads, options } = harness((_payload, attempt) =>
			errorResponse(attempt === 1 ? grammarError : "Required grammar is still too large"),
		);
		const result = await streamAnthropic(
			model,
			context([tool("lookup", "prefer"), tool("required", "require")]),
			options,
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Required grammar is still too large");
		expect(payloads).toHaveLength(2);
		expect((payloads[1].tools as BetaTool[])[1].strict).toBe(true);
	});

	it("does not downgrade a hook exception, even if it looks like the provider rejection", async () => {
		const { payloads, options } = harness(() => successResponse());
		const result = await streamAnthropic(model, context([tool("lookup", "prefer")]), {
			...options,
			onPayload: () => {
				throw Anthropic.APIError.generate(
					400,
					{ error: { type: "invalid_request_error", message: grammarError } },
					grammarError,
					new Headers(),
				);
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(payloads).toHaveLength(0);
		expect(result.diagnostics).toBeUndefined();
	});

	it("honors cancellation before the fallback attempt", async () => {
		const controller = new AbortController();
		const { payloads, options } = harness(() => {
			controller.abort();
			return errorResponse();
		});
		const result = await streamAnthropic(model, context([tool("lookup", "prefer")]), {
			...options,
			signal: controller.signal,
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(payloads).toHaveLength(1);
	});

	it("does not retry an SSE error after response headers", async () => {
		const { payloads, options } = harness(
			() =>
				new Response(
					`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: grammarError } })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		const result = await streamAnthropic(model, context([tool("lookup", "prefer")]), options).result();
		expect(result.stopReason).toBe("error");
		expect(payloads).toHaveLength(1);
	});

	it("does not disable strict sampling on later requests", async () => {
		const { payloads, options } = harness((_payload, attempt) =>
			attempt === 1 ? errorResponse() : successResponse(),
		);
		const transcript = context([tool("lookup", "prefer")]);
		await streamAnthropic(model, transcript, options).result();
		await streamAnthropic(model, transcript, options).result();
		expect(payloads.map((payload) => (payload.tools as BetaTool[])[0].strict)).toEqual([true, undefined, true]);
	});

	it("preserves prefer through pi-messages so the gateway's Anthropic adapter can fall back", async () => {
		const { payloads, options } = harness((_payload, attempt) =>
			attempt === 1 ? errorResponse() : successResponse(),
		);
		const transcript = context([tool("lookup", "prefer")]);
		const gatewayModel: Model<"pi-messages"> = {
			...model,
			api: "pi-messages",
			provider: "radius",
			baseUrl: "https://radius.example/v1",
			compat: undefined,
		};
		const result = await streamPiMessages(gatewayModel, transcript, {
			apiKey: "radius-test",
			fetch: async (_input, init) => {
				const request = JSON.parse(init?.body as string) as { context: TranscriptContext };
				expect(request.context).toEqual(JSON.parse(JSON.stringify(transcript)));
				const upstream = await streamAnthropic(model, request.context, options).result();
				return new Response(
					`data: ${JSON.stringify({ type: "done", reason: upstream.stopReason, usage: upstream.usage })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(payloads.map((payload) => (payload.tools as BetaTool[])[0].strict)).toEqual([true, undefined]);
	});
});
