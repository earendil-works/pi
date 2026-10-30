import { beforeEach, describe, expect, it, vi } from "vitest";
import { allocatedBytes } from "./memory-helpers.ts";

// #9265: Bedrock kept `index`, `partialJson` and the encrypted reasoning bytes on the content blocks while streaming,
// and re-parsed the accumulated tool-call arguments on every delta.

const bedrockMock = vi.hoisted(() => ({ streamEvents: undefined as (() => Iterable<unknown>) | undefined }));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		send(): Promise<unknown> {
			const events = bedrockMock.streamEvents;
			if (!events) return Promise.reject(new Error("mock send"));
			return Promise.resolve({
				$metadata: { httpStatusCode: 200 },
				stream: (async function* () {
					yield* events();
				})(),
			});
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
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"bedrock-converse-stream"> = {
	id: "global.anthropic.claude-test",
	name: "Claude Test",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

const context = normalizeContext({ messages: [{ role: "user", content: "write", timestamp: 0 }] });

const content = Array.from({ length: 20_000 }, (_, line) => `const line${line} = "value ${line}"; // \\ done\n`).join(
	"",
);

function writeCall(size: number) {
	const args = { path: "/src/file.ts", content: content.slice(0, size) };
	return { args, text: JSON.stringify(args) };
}

/** Encrypted reasoning, then a `write` tool call whose arguments arrive in 32-character deltas. */
function* events(text: string): Generator<unknown> {
	yield { messageStart: { role: "assistant" } };
	yield {
		contentBlockDelta: {
			contentBlockIndex: 0,
			delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2]) } },
		},
	};
	yield {
		contentBlockDelta: {
			contentBlockIndex: 0,
			delta: { reasoningContent: { redactedContent: new Uint8Array([3]) } },
		},
	};
	yield { contentBlockStop: { contentBlockIndex: 0 } };
	yield { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tool_1", name: "write" } } } };
	for (let index = 0; index < text.length; index += 32) {
		yield {
			contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: text.slice(index, index + 32) } } },
		};
	}
	yield { contentBlockStop: { contentBlockIndex: 1 } };
	yield { messageStop: { stopReason: "tool_use" } };
}

const BLOCK_KEYS: Record<string, readonly string[]> = {
	text: ["type", "text", "textSignature"],
	thinking: ["type", "thinking", "thinkingSignature", "redacted"],
	toolCall: ["type", "id", "name", "arguments", "argumentsError"],
};

function expectNoStreamState(message: AssistantMessage): void {
	for (const block of message.content) {
		for (const key of Object.keys(block)) expect(BLOCK_KEYS[block.type], `${block.type}.${key}`).toContain(key);
	}
}

describe("Bedrock stream state", () => {
	beforeEach(() => {
		bedrockMock.streamEvents = undefined;
	});

	it("keeps stream state off partial blocks and finishes the tool call with its exact arguments", async () => {
		const { args, text } = writeCall(5_000);
		bedrockMock.streamEvents = () => events(text);
		let shown = -1;
		const stream = streamBedrock(model, context);
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") continue;
			expectNoStreamState(event.partial);
			if (event.type !== "toolcall_delta") continue;
			const call = event.partial.content[event.contentIndex];
			const partial = call?.type === "toolCall" ? call.arguments.content : undefined;
			if (typeof partial !== "string") continue;
			expect(args.content.startsWith(partial)).toBe(true);
			expect(partial.length).toBeGreaterThanOrEqual(shown);
			shown = partial.length;
		}
		const message = await stream.result();
		expect(message.stopReason, message.errorMessage).toBe("toolUse");
		expectNoStreamState(message);
		expect(message.content).toEqual([
			{ type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "AQID", redacted: true },
			{ type: "toolCall", id: "tool_1", name: "write", arguments: args },
		]);
	});

	it("allocates linearly in the argument text", async () => {
		const run = async (size: number) => {
			const { text } = writeCall(size);
			bedrockMock.streamEvents = () => events(text);
			return allocatedBytes(() => streamBedrock(model, context).result());
		};
		const small = await run(25_000);
		const large = await run(250_000);
		expect(large / small).toBeLessThan(25);
		expect(large / writeCall(250_000).text.length).toBeLessThan(5_000);
	});
});
