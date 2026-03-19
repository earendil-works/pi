import type { Message } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

type GetAutoCompactionSourceMessages = (
	this: { agent: { state: { messages: Message[] } } },
	isEmergency: boolean,
) => Message[];

describe("auto-compaction source messages", () => {
	it("drops the trailing toolUse assistant turn before emergency compaction", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Investigate the failing tests" }],
				timestamp: 1,
			},
			{
				role: "assistant",
				content: [
					{ type: "text", text: "I found the failure." },
					{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "npm test" } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
		];

		const method = (
			TuiRenderer.prototype as unknown as {
				getAutoCompactionSourceMessages: GetAutoCompactionSourceMessages;
			}
		).getAutoCompactionSourceMessages;

		const result = method.call(
			{
				agent: {
					state: {
						messages,
					},
				},
			},
			true,
		);

		expect(result).toHaveLength(1);
		expect(result[0]?.role).toBe("user");
	});
});
