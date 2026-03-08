import { describe, expect, it } from "vitest";
import { shouldPauseAssistantActiveTiming, shouldStartAssistantActiveTiming } from "./tui-renderer.js";

describe("tui renderer assistant-active timing", () => {
	it("starts timing only for streamed assistant text or tool-call deltas", () => {
		expect(
			shouldStartAssistantActiveTiming({ type: "text_delta", contentIndex: 0, delta: "hi", partial: {} as never }),
		).toBe(true);
		expect(
			shouldStartAssistantActiveTiming({
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"command":"echo hi"}',
				partial: {} as never,
			}),
		).toBe(true);

		expect(shouldStartAssistantActiveTiming({ type: "text_start", contentIndex: 0, partial: {} as never })).toBe(
			false,
		);
		expect(shouldStartAssistantActiveTiming({ type: "toolcall_start", contentIndex: 0, partial: {} as never })).toBe(
			false,
		);
		expect(
			shouldStartAssistantActiveTiming({
				type: "thinking_delta",
				contentIndex: 0,
				delta: "plan",
				partial: {} as never,
			}),
		).toBe(false);
	});

	it("pauses timing when streamed assistant text or tool-call streaming ends", () => {
		expect(
			shouldPauseAssistantActiveTiming({ type: "text_end", contentIndex: 0, content: "done", partial: {} as never }),
		).toBe(true);
		expect(
			shouldPauseAssistantActiveTiming({
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { type: "toolCall", id: "call_1", name: "bash", arguments: {} },
				partial: {} as never,
			}),
		).toBe(true);

		expect(
			shouldPauseAssistantActiveTiming({ type: "text_delta", contentIndex: 0, delta: "hi", partial: {} as never }),
		).toBe(false);
		expect(
			shouldPauseAssistantActiveTiming({
				type: "thinking_end",
				contentIndex: 0,
				content: "plan",
				partial: {} as never,
			}),
		).toBe(false);
	});
});
