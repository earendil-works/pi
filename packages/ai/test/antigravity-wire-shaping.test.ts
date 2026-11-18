import { describe, expect, it } from "vitest";
import { antigravityDisplayModelName } from "../src/api/antigravity/models.ts";
import { buildRequest, convertMessages, formatUserTurnText } from "../src/api/antigravity/stream.ts";
import type { GeminiTextPart } from "../src/api/antigravity/types.ts";
import { antigravityRequestEnvelope, resolveSessionTrajectory } from "../src/api/antigravity/util.ts";
import { antigravityProvider } from "../src/providers/antigravity.ts";
import type { AssistantMessage } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model = antigravityProvider()
	.getModels()
	.find((model) => model.id === "gemini-3.8-flash")!;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NEGATIVE_INT64 = /^-\d{1,19}$/;

function assistant(modelId: string): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: modelId,
		content: [{ type: "text", text: "ok" }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

describe("antigravity wire shaping (snoop capture 2026-11-18)", () => {
	it("swaps pi's default identity line for agy's <identity> section", async () => {
		const preamble =
			"You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.\n\n<tools>\n- read: Read file contents\n</tools>";
		const request = await buildRequest(
			model,
			normalizeContext({ systemPrompt: preamble, messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
			"project",
			{},
			"gemini-3.8-flash-medium",
		);
		const text = request.request.systemInstruction.parts[0].text;
		expect(
			text.startsWith(
				"<identity>\nYou are Antigravity, a powerful agentic AI assistant designed by the Google Deepmind team.\n",
			),
		).toBe(true);
		expect(text).toContain("User requests are enclosed within <USER_REQUEST> tags.\n</identity>\n");
		// The rest of pi's preamble survives the swap.
		expect(text).toContain("Help users inspect files, run commands, and modify code.");
		expect(text).toContain("- read: Read file contents");
		expect(text).not.toMatch(/inside pi/i);
	});

	it("wraps user turns in <USER_REQUEST> + <ADDITIONAL_METADATA> and reports a model change from None", async () => {
		const contents = convertMessages(
			model,
			normalizeContext({ messages: [{ role: "user", content: "Reply with the single word: ok", timestamp: 1 }] }),
			"gemini-3.8-flash-medium",
		);
		expect(contents).toHaveLength(1);
		const text = (contents[0].parts[0] as GeminiTextPart).text;
		expect(
			text.startsWith(
				"<USER_REQUEST>\nReply with the single word: ok\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ",
			),
		).toBe(true);
		expect(text).toMatch(
			/\.\n<\/ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.8 Flash \(Medium\)\. /,
		);
		expect(text.endsWith("</USER_SETTINGS_CHANGE>")).toBe(true);
	});

	it("emits no settings change once the current model has answered, and one on a family switch", () => {
		const sameModel = convertMessages(
			model,
			normalizeContext({
				messages: [
					{ role: "user", content: "hi", timestamp: 1 },
					assistant("gemini-3.8-flash"),
					{ role: "user", content: "again", timestamp: 3 },
				],
			}),
			"gemini-3.8-flash-medium",
		);
		expect((sameModel[2].parts[0] as { text: string }).text).not.toContain("<USER_SETTINGS_CHANGE>");

		const switched = convertMessages(
			model,
			normalizeContext({
				messages: [
					{ role: "user", content: "hi", timestamp: 1 },
					assistant("gemini-4-carbon"),
					{ role: "user", content: "again", timestamp: 3 },
				],
			}),
			"gemini-3.8-flash-medium",
		);
		expect((switched[2].parts[0] as { text: string }).text).toContain(
			"from Gemini 4 Carbon to Gemini 3.8 Flash (Medium)",
		);
	});

	it("wraps every user turn and keeps tool-result turns bare", () => {
		const contents = convertMessages(
			model,
			normalizeContext({
				messages: [
					{ role: "user", content: "first", timestamp: 1 },
					{
						...assistant("gemini-3.8-flash"),
						content: [{ type: "toolCall", id: "call/1", name: "read", arguments: { path: "a" } }],
						stopReason: "toolUse",
					},
					{
						role: "toolResult",
						toolCallId: "call/1",
						toolName: "read",
						content: [{ type: "text", text: "contents" }],
						isError: false,
						timestamp: 3,
					},
				],
			}),
			"gemini-3.8-flash-medium",
		);
		expect((contents[0].parts[0] as { text: string }).text.startsWith("<USER_REQUEST>\nfirst\n</USER_REQUEST>")).toBe(
			true,
		);
		const toolTurn = contents[2].parts[0] as { functionResponse: unknown };
		expect("functionResponse" in toolTurn).toBe(true);
	});

	it("formats user turns with an injectable local time", () => {
		expect(formatUserTurnText("hi", { localTime: "2026-11-18T09:32:27-08:00" })).toBe(
			"<USER_REQUEST>\nhi\n</USER_REQUEST>\n" +
				"<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-18T09:32:27-08:00.\n</ADDITIONAL_METADATA>",
		);
	});

	it("derives v4 cascade/trajectory ids and a stable negative-int64 session id per session", async () => {
		const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });
		const first = await resolveSessionTrajectory(context, "session-a");
		const second = await resolveSessionTrajectory(context, "session-a");
		const other = await resolveSessionTrajectory(context, "session-b");
		expect(first.conversationId).toMatch(UUID_V4);
		expect(first.trajectoryId).toMatch(UUID_V4);
		expect(first.sessionInt64Id).toMatch(NEGATIVE_INT64);
		expect(Number(first.sessionInt64Id)).toBeLessThan(0);
		expect(second).toEqual(first);
		expect(other.conversationId).not.toEqual(first.conversationId);
		expect(other.sessionInt64Id).not.toEqual(first.sessionInt64Id);
	});

	it("labels requests with cascade_id/root_cascade_id and sorts label keys like the Go client", async () => {
		const { conversationId, trajectoryId } = await resolveSessionTrajectory(
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
			"session-a",
		);
		const envelope = await antigravityRequestEnvelope("gemini-3.8-flash-medium", {
			isClaude: false,
			isNonGemini: false,
			step: 1,
			lastStepIndex: "0",
			requestIndex: 0,
			conversationId,
			trajectoryId,
			modelEnum: "MODEL_PLACEHOLDER_M319",
		});
		expect(Object.keys(envelope.labels)).toEqual([
			"cascade_id",
			"last_step_index",
			"model_enum",
			"request_id",
			"root_cascade_id",
			"trajectory_id",
			"used_claude",
			"used_claude_conservative",
			"used_non_gemini_model",
		]);
		expect(envelope.labels.cascade_id).toBe(conversationId);
		expect(envelope.labels.root_cascade_id).toBe(conversationId);
		expect(envelope.labels.request_id).toBe(`${trajectoryId}-0`);
		expect(envelope.requestId).toBe(`agent/${conversationId}/${envelope.requestId.split("/")[2]}/${trajectoryId}/1`);
		expect(envelope.sessionId).toMatch(NEGATIVE_INT64);
	});

	it("sends the envelope session id, not the harness UUIDv7, in the request", async () => {
		const request = await buildRequest(
			model,
			normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
			"project",
			{ sessionId: "01a1efb7-a0cd-74a7-9a8a-4c661647b1c3" },
			"gemini-3.8-flash-medium",
		);
		expect(request.request.sessionId).toMatch(NEGATIVE_INT64);
		expect(request.request.labels!.cascade_id).toBe(request.requestId.split("/")[1]);
	});

	it("maps runtime ids to the client's display names", () => {
		expect(antigravityDisplayModelName("gemini-3.8-flash-medium")).toBe("Gemini 3.8 Flash (Medium)");
		expect(antigravityDisplayModelName("gemini-3.5-flash-extra-low")).toBe("Gemini 3.5 Flash (Low)");
		expect(antigravityDisplayModelName("gemini-3.1-pro-low")).toBe("Gemini 3.1 Pro (Low)");
		expect(antigravityDisplayModelName("gemini-4-carbon-high")).toBe("Gemini 4 Carbon (High)");
		expect(antigravityDisplayModelName("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
	});
});
