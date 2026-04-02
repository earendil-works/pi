import { describe, expect, it } from "vitest";

import { createExecJsonEventProcessor } from "../src/exec/jsonl-event-processor.js";

describe("exec json failure contract (red)", () => {
	it("emits a public error event alongside terminal turn failure for fatal assistant errors", () => {
		const processor = createExecJsonEventProcessor({ threadId: "thread-failure" });

		const assistantMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "" }],
			api: "openai-completions" as const,
			provider: "fixture",
			model: "fixture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error" as const,
			errorMessage: "provider exploded",
			timestamp: Date.now(),
		};

		const events = [
			...processor.consume({ type: "agent_start" }),
			...processor.consume({ type: "turn_start" }),
			...processor.consume({ type: "turn_end", message: assistantMessage, toolResults: [] }),
		];

		expect(events).toContainEqual({ type: "error", error: "provider exploded" });
		expect(events).toContainEqual({ type: "turn.failed", error: "provider exploded" });
	});
});
