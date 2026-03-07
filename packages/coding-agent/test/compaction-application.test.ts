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

describe("compaction application invariants", () => {
	it("still appends a structured summary when remote/native replacement history exists but no formatted summary was provided", () => {
		const replacementMessages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "Opaque remote compacted history" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5",
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
			goal: "Continue the release workflow",
			formattedMessage: "",
			parentSessionId: "thread-123",
			fileTokens: 1,
			replacementMessages,
			keyFiles: ["src/auth.ts"],
		});

		expect(messages.length).toBeGreaterThan(replacementMessages.length);

		const appendedSummary = messages[messages.length - 1];
		expect(appendedSummary?.role).toBe("user");
		const text =
			typeof appendedSummary?.content === "string"
				? appendedSummary.content
				: (appendedSummary?.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join("\n") ?? "");

		expect(text).toContain("## Goal");
		expect(text).toContain("### Done");
		expect(text).toContain("### In Progress");
		expect(text).toContain("## Next Steps");
		expect(text).toContain("**Parent Thread:** `thread-123`");
		expect(text).toContain("Use `read_thread` with this ID to reference the original conversation.");
	});

	it("guarantees every applied compaction leaves a resumable structured checkpoint even if the remote window is opaque-only", () => {
		const replacementMessages: Message[] = [
			{
				role: "user",
				content: [],
				timestamp: 1,
			},
		];

		const messages = buildMessages({
			handoffType: "explicit",
			goal: "Recover the exact current state",
			formattedMessage: "",
			parentSessionId: "thread-456",
			fileTokens: 1,
			replacementMessages,
			keyFiles: [],
		});

		const summaryMessages = messages.filter((message) => {
			if (message.role !== "user" || typeof message.content === "string") return false;
			const text = message.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			return text.includes("## Goal") && text.includes("## Next Steps");
		});

		expect(summaryMessages).toHaveLength(1);
	});
});
