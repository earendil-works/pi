import type { Message } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import type { HandoffDetails } from "../src/tools/handoff.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

type BuildContextCompactionMessages = (
	this: { agent: { state: { model: null } } },
	details: HandoffDetails & { parentSessionId: string | null },
) => Message[];

function buildMessages(details: HandoffDetails & { parentSessionId: string | null }): Message[] {
	const build = (
		TuiRenderer.prototype as unknown as { buildContextCompactionMessages: BuildContextCompactionMessages }
	).buildContextCompactionMessages;

	return build.call(
		{
			agent: {
				state: {
					model: null,
				},
			},
		},
		details,
	);
}

function flattenText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

describe("Morph compaction application", () => {
	it("keeps the compacted replacement message untouched", () => {
		const replacementMessages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "Morph-compacted visible history" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
		];

		const messages = buildMessages({
			handoffType: "explicit",
			goal: "Fix the login page tests",
			formattedMessage: "## Goal\nFix the login page tests",
			parentSessionId: "thread-123",
			fileTokens: 42,
			replacementMessages,
			keyFiles: ["src/login.ts"],
			compactionApplicationMode: "goal-plus-replacement-history",
			compactionNotificationLabel: "Morph compaction",
		});

		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("assistant");
		expect(flattenText(messages[0]!)).toBe("Morph-compacted visible history");

		const joined = messages.map(flattenText).join("\n\n");
		expect(joined).not.toContain("**CHECKPOINT**");
	});
});
