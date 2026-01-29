import type { AssistantMessage, StopReason } from "@kennyfrc/mu-ai";
import { describe, expect, test } from "vitest";
import {
	consumeJsonlChunk,
	createInitialFollowState,
	extractTurnCompleteAssistantMessages,
} from "../src/subscriptions/session-jsonl-follower.js";

function buildAssistantMessage(stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `status:${stopReason}` }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 123,
	};
}

describe("session JSONL follower", () => {
	test("consumeJsonlChunk returns entries only after full line", () => {
		const entry = {
			type: "message",
			message: buildAssistantMessage("stop"),
		};
		const line = JSON.stringify(entry) + "\n";
		const firstHalf = line.slice(0, Math.floor(line.length / 2));
		const secondHalf = line.slice(Math.floor(line.length / 2));

		const initial = createInitialFollowState();
		const partial = consumeJsonlChunk(initial, firstHalf);
		expect(partial.entries).toHaveLength(0);
		expect(partial.nextState.remainder.length).toBeGreaterThan(0);

		const completed = consumeJsonlChunk(partial.nextState, secondHalf);
		expect(completed.entries).toHaveLength(1);
		expect(completed.nextState.remainder).toBe("");
	});

	test("extractTurnCompleteAssistantMessages filters toolUse", () => {
		const toolUseEntry = {
			type: "message",
			message: buildAssistantMessage("toolUse"),
		};
		const stopEntry = {
			type: "message",
			message: buildAssistantMessage("stop"),
		};
		const entries = [toolUseEntry, stopEntry, { type: "session" }];

		const results = extractTurnCompleteAssistantMessages(entries);
		expect(results).toHaveLength(1);
		expect(results[0].stopReason).toBe("stop");
	});
});
