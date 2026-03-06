import type { AssistantMessage } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import { assistantMessageUsageSnapshot } from "../src/usage-footer.js";

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.4",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		usageLimits: {
			primary: { usedPercent: 72, windowMinutes: 300, resetsAt: 1730000000 },
			secondary: { usedPercent: 40, windowMinutes: 10080 },
		},
		stopReason: "stop",
		timestamp: 123,
	};
}

describe("assistantMessageUsageSnapshot", () => {
	it("maps codex usage limits into footer chips", () => {
		const snapshot = assistantMessageUsageSnapshot(createAssistantMessage());

		expect(snapshot).toEqual({
			capturedAt: 123,
			primary: {
				label: "5h",
				percentRemaining: 28,
				resetsAt: "2024-10-27T03:33:20.000Z",
			},
			secondary: {
				label: "weekly",
				percentRemaining: 60,
				resetsAt: undefined,
			},
		});
	});
});
