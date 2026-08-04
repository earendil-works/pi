import type { Api, AssistantMessage, Model, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { encodeServerMessage, PROTOCOL_VERSION } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import {
	sanitizeProtocolDetails,
	toProtocolAssistantMessage,
	toProtocolJsonValue,
	toProtocolModelMetadata,
	toProtocolToolResultMessage,
	toProtocolUserMessage,
} from "../src/protocol.ts";

const model = {
	id: "model-1",
	name: "Model One",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "https://example.test",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
	contextWindow: 100_000,
	maxTokens: 10_000,
} satisfies Model<Api>;

type ProtocolTranscriptItem =
	| ReturnType<typeof toProtocolAssistantMessage>
	| ReturnType<typeof toProtocolUserMessage>
	| ReturnType<typeof toProtocolToolResultMessage>;

function assertValidServerPayload(item: ProtocolTranscriptItem): void {
	expect(() =>
		encodeServerMessage({
			type: "hello",
			version: PROTOCOL_VERSION,
			connectionId: "connection-1",
			snapshot: {
				serverId: "server-1",
				protocolVersion: PROTOCOL_VERSION,
				revision: 0,
				sessions: [
					{
						id: "session-1",
						cwd: "/workspace",
						createdAt: 1,
						updatedAt: 1,
						phase: "idle",
						model: { provider: "test-provider", id: "model-1" },
						thinkingLevel: "off",
						attached: true,
						locked: true,
					},
				],
				models: [toProtocolModelMetadata(model, true)],
			},
		}),
	).not.toThrow();

	expect(() =>
		encodeServerMessage({
			type: "event",
			event: {
				type: "session_snapshot",
				snapshot: {
					id: "session-1",
					cwd: "/workspace",
					createdAt: 1,
					updatedAt: 1,
					phase: "idle",
					model: { provider: "test-provider", id: "model-1" },
					thinkingLevel: "off",
					attached: true,
					locked: true,
					revision: 1,
					transcript: [item],
					queuedSteer: [],
					queuedSteerCount: 0,
				},
			},
		}),
	).not.toThrow();
}

describe("pi-ai protocol bridge", () => {
	test("maps model metadata and produces protocol-valid output", () => {
		const result = toProtocolModelMetadata(model, true);

		expect(result).toMatchObject({
			provider: "test-provider",
			id: "model-1",
			api: "test-api",
			input: ["text", "image"],
			authenticated: true,
		});
		expect(result.supportedThinkingLevels).toContain("off");
	});

	test("exhaustively maps assistant content and stop reasons", () => {
		const message = {
			role: "assistant",
			content: [
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "hmm", redacted: false },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
			],
			api: "test-api",
			provider: "test-provider",
			model: "model-1",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				totalTokens: 10,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
			},
			stopReason: "toolUse",
			timestamp: 123,
		} satisfies AssistantMessage;

		const result = toProtocolAssistantMessage(message, { id: "message-1" });

		expect(result).toMatchObject({
			id: "message-1",
			status: "complete",
			stopReason: "toolUse",
			model: { provider: "test-provider", id: "model-1" },
		});
		expect(result.content).toEqual([
			{ type: "text", text: "hello" },
			{ type: "thinking", thinking: "hmm", redacted: false },
			{ type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "README.md" } },
		]);
		assertValidServerPayload(result);
	});

	test("maps user and tool messages without leaking non-JSON details", () => {
		const user = {
			role: "user",
			content: "hello",
			timestamp: 1,
		} satisfies UserMessage;
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const tool = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			details: circular,
			isError: false,
			timestamp: 2,
		} satisfies ToolResultMessage;
		const call = {
			type: "toolCall",
			id: "call-1",
			name: "read",
			arguments: { path: "README.md" },
		} satisfies ToolCall;

		const userResult = toProtocolUserMessage(user, { id: "user-1" });
		expect(userResult).toMatchObject({
			id: "user-1",
			content: [{ type: "text", text: "hello" }],
		});
		assertValidServerPayload(userResult);

		const toolResult = toProtocolToolResultMessage(tool, {
			id: "tool-1",
			call,
		});
		expect(toolResult).toMatchObject({
			id: "tool-1",
			toolName: "read",
			input: { path: "README.md" },
			details: { self: "[Circular]" },
			status: "complete",
		});
		assertValidServerPayload(toolResult);
	});

	test("rejects tool results associated with a different call", () => {
		const call = {
			type: "toolCall",
			id: "call-1",
			name: "read",
			arguments: { path: "README.md" },
		} satisfies ToolCall;
		const result = {
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 2,
		} satisfies ToolResultMessage;

		expect(() => toProtocolToolResultMessage(result, { id: "tool-1", call })).toThrow(/tool call/i);
		expect(() =>
			toProtocolToolResultMessage({ ...result, toolCallId: "call-1", toolName: "write" }, { id: "tool-1", call }),
		).toThrow(/tool call/i);
	});

	test("derives streaming status from a pending stop reason", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			api: "test-api",
			provider: "test-provider",
			model: "model-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: 123,
		} satisfies AssistantMessage;

		const result = toProtocolAssistantMessage(message, { id: "message-pending" });
		expect(result).toMatchObject({ status: "streaming" });
		expect(result).not.toHaveProperty("stopReason");
		assertValidServerPayload(result);
	});

	test("preserves optional non-empty assistant error messages", () => {
		const message = {
			role: "assistant",
			content: [],
			api: "test-api",
			provider: "test-provider",
			model: "model-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			timestamp: 123,
		} satisfies AssistantMessage;

		const resultWithoutMessage = toProtocolAssistantMessage(message, { id: "message-error" });
		expect(resultWithoutMessage).toMatchObject({ status: "error", stopReason: "error" });
		expect(resultWithoutMessage).not.toHaveProperty("errorMessage");
		assertValidServerPayload(resultWithoutMessage);
		expect(() => toProtocolAssistantMessage({ ...message, errorMessage: "" }, { id: "message-error" })).toThrow(
			TypeError,
		);
		const resultWithMessage = toProtocolAssistantMessage(
			{ ...message, errorMessage: "failed" },
			{ id: "message-error" },
		);
		expect(resultWithMessage).toMatchObject({ status: "error", stopReason: "error", errorMessage: "failed" });
		assertValidServerPayload(resultWithMessage);
	});

	test("rejects invalid source identifiers and timestamps", () => {
		const message = {
			role: "assistant",
			content: [{ type: "toolCall", id: "", name: "read", arguments: {} }],
			api: "test-api",
			provider: "test-provider",
			model: "model-1",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		} satisfies AssistantMessage;

		expect(() => toProtocolAssistantMessage(message, { id: "assistant-1" })).toThrow(/tool call id/i);
		expect(() =>
			toProtocolUserMessage({ role: "user", content: "hello", timestamp: Number.NaN }, { id: "user-1" }),
		).toThrow(/timestamp/i);
	});

	test("rejects lossy tool input conversions", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(() => toProtocolJsonValue(Number.POSITIVE_INFINITY)).toThrow(TypeError);
		expect(() => toProtocolJsonValue(1n)).toThrow(TypeError);
		expect(() => toProtocolJsonValue(undefined)).toThrow(TypeError);
		expect(() => toProtocolJsonValue(circular)).toThrow(TypeError);
	});

	test("rejects sparse execution data and normalizes sparse diagnostic arrays", () => {
		const sparse = new Array<unknown>(2);
		sparse[1] = "value";

		expect(() => toProtocolJsonValue(sparse)).toThrow(/undefined/i);
		expect(sanitizeProtocolDetails(sparse)).toEqual([null, "value"]);
	});
});
