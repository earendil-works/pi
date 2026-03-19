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
	it("applies pure Morph compaction as actual replacement history plus checkpoint footer", () => {
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

		expect(messages).toHaveLength(2);
		expect(messages[0]).toEqual(replacementMessages[0]);
		expect(messages[1]?.role).toBe("user");
		expect(flattenText(messages[1]!)).toBe(`---

**CHECKPOINT**
You are continuing from a compacted conversation. See your goal below.

**Goal**
Fix the login page tests

**Thread Context**
Parent thread ID: thread-123
Use \`read_thread\` if you need more detail from the parent thread.

---`);

		const joined = messages.map(flattenText).join("\n\n");
		expect(joined).not.toContain("Use this compacted checkpoint as the active context");
		expect(joined).not.toContain("## Progress");
	});
});
