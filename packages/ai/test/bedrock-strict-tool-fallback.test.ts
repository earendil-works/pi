import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	inputs: [] as unknown[],
	respond: undefined as ((attempt: number) => Promise<unknown>) | undefined,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {
		constructor(options: { name: string; message: string }) {
			super(options.message);
			this.name = options.name;
		}
	}

	class BedrockRuntimeClient {
		send(command: { input: unknown }): Promise<unknown> {
			bedrockMock.inputs.push(structuredClone(command.input));
			return bedrockMock.respond!(bedrockMock.inputs.length);
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: { END_TURN: "end_turn" },
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { BedrockRuntimeServiceException } from "@aws-sdk/client-bedrock-runtime";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import type { Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"bedrock-converse-stream"> = {
	id: "us.anthropic.claude-opus-5-5",
	name: "Claude Opus 5.5 (US)",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 100,
	compat: { supportsStrictMode: true },
};

// Observed from live Bedrock with 20 optional parameters across strict tools.
const unionLimitMessage =
	"The model returned the following errors: Schemas contains too many parameters with union types (20 parameters with type arrays or anyOf). This causes exponential compilation cost. Reduce the number of nullable or union-typed parameters (limit: 16 parameters with unions).";

type ToolSpecInput = { toolSpec: { name: string; strict?: boolean; inputSchema: { json: unknown } } };
type CommandInput = { toolConfig: { tools: ToolSpecInput[] }; requestMetadata?: Record<string, string> };

function tool(name: string, strict?: "prefer" | "require"): Tool {
	return {
		name,
		description: "Look up a value",
		parameters: Type.Object({ value: Type.String(), optional: Type.Optional(Type.Number()) }),
		...(strict ? { constrainedSampling: { type: "json_schema", strict } } : {}),
	};
}

function sdkError(name: string, message: string): Error {
	return new BedrockRuntimeServiceException({ name, message, $fault: "client", $metadata: { httpStatusCode: 400 } });
}

function successResponse(): Promise<unknown> {
	return Promise.resolve({
		$metadata: { httpStatusCode: 200 },
		stream: (async function* () {
			yield { messageStart: { role: "assistant" } };
			yield { messageStop: { stopReason: "end_turn" } };
		})(),
	});
}

function run(tools: Tool[], onPayload?: (payload: unknown) => unknown) {
	return streamBedrock(
		model,
		normalizeContext({ tools, messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
		{ cacheRetention: "none", onPayload },
	).result();
}

// Regression tests for https://github.com/earendil-works/pi/issues/11416.
describe("Bedrock preferred strict tool fallback", () => {
	beforeEach(() => {
		bedrockMock.inputs = [];
	});

	it("retries a strict tool limit rejection with preferred tools non-strict and keeps required tools strict", async () => {
		bedrockMock.respond = (attempt) =>
			attempt === 1 ? Promise.reject(sdkError("ValidationException", unionLimitMessage)) : successResponse();
		const onPayload = vi.fn((payload: unknown) => ({ ...(payload as object), requestMetadata: { team: "a" } }));

		const result = await run([tool("preferred", "prefer"), tool("required", "require"), tool("ordinary")], onPayload);

		expect(result.stopReason).toBe("stop");
		expect(onPayload).toHaveBeenCalledTimes(2);
		const [first, second] = bedrockMock.inputs as CommandInput[];
		expect(first.toolConfig.tools[0].toolSpec).toMatchObject({
			strict: true,
			inputSchema: {
				json: {
					required: ["value", "optional"],
					properties: { optional: { anyOf: [{ type: "number" }, { type: "null" }] } },
				},
			},
		});
		expect(second.toolConfig.tools[0].toolSpec.strict).toBeUndefined();
		expect(second.toolConfig.tools[0].toolSpec.inputSchema.json).toEqual({
			type: "object",
			properties: { value: { type: "string" }, optional: { type: "number" } },
			required: ["value"],
		});
		expect(second.toolConfig.tools[1]).toEqual(first.toolConfig.tools[1]);
		expect(second.toolConfig.tools[1].toolSpec.strict).toBe(true);
		expect(second.toolConfig.tools[2]).toEqual(first.toolConfig.tools[2]);
		expect(second.requestMetadata).toEqual({ team: "a" });
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				type: "bedrock_strict_tools_fallback",
				error: { message: unionLimitMessage },
				details: { reason: "strict_tool_limits_exceeded" },
			}),
		]);
	});

	it("does not retry without preferred strict tools", async () => {
		bedrockMock.respond = () => Promise.reject(sdkError("ValidationException", unionLimitMessage));

		const result = await run([tool("required", "require"), tool("ordinary")]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(`Validation error: ${unionLimitMessage}`);
		expect(bedrockMock.inputs).toHaveLength(1);
	});

	it("does not retry other validation errors", async () => {
		bedrockMock.respond = () => Promise.reject(sdkError("ValidationException", "messages: field required"));

		const result = await run([tool("preferred", "prefer")]);

		expect(result.stopReason).toBe("error");
		expect(bedrockMock.inputs).toHaveLength(1);
	});

	it("retries only once", async () => {
		bedrockMock.respond = () => Promise.reject(sdkError("ValidationException", unionLimitMessage));

		const result = await run([tool("preferred", "prefer")]);

		expect(result.stopReason).toBe("error");
		expect(bedrockMock.inputs).toHaveLength(2);
	});
});
