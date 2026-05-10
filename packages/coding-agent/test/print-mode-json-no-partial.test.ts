import { describe, expect, it } from "vitest";
import { serializeJsonEvent } from "../src/modes/print-mode.js";

// `serializeJsonEvent` is the per-line serializer used by `pi --mode json`.
// When `--json-no-partial` is passed, it strips the accumulated-state
// `partial` field (and the wrapping `message`) from `message_update` delta
// events, turning O(n²) NDJSON growth into O(n) of new content.

const fakePartial = {
	role: "assistant",
	content: [{ type: "text", text: "Hello world" }],
};
const fakeAgentMessage = { role: "assistant", id: "m1", content: [{ type: "text", text: "Hello world" }] };

const deltaEvent = (innerType: string) => ({
	type: "message_update",
	message: fakeAgentMessage,
	assistantMessageEvent: {
		type: innerType,
		contentIndex: 0,
		delta: " world",
		partial: fakePartial,
	},
});

describe("serializeJsonEvent — default (jsonNoPartial=false)", () => {
	it("emits the full event including partial and message for delta events", () => {
		const out = JSON.parse(serializeJsonEvent(deltaEvent("text_delta"), false));
		expect(out.type).toBe("message_update");
		expect(out.message).toEqual(fakeAgentMessage);
		expect(out.assistantMessageEvent.partial).toEqual(fakePartial);
		expect(out.assistantMessageEvent.delta).toBe(" world");
	});

	it("passes non-message_update events through unchanged", () => {
		const event = { type: "agent_end", messages: [fakeAgentMessage] };
		const out = JSON.parse(serializeJsonEvent(event, false));
		expect(out).toEqual(event);
	});
});

describe("serializeJsonEvent — jsonNoPartial=true", () => {
	it.each(["text_delta", "thinking_delta", "toolcall_delta"] as const)(
		"strips partial + message from message_update for %s",
		(innerType) => {
			const out = JSON.parse(serializeJsonEvent(deltaEvent(innerType), true));
			expect(out.type).toBe("message_update");
			expect(out.message).toBeUndefined();
			expect(out.assistantMessageEvent.partial).toBeUndefined();
			expect(out.assistantMessageEvent.type).toBe(innerType);
			expect(out.assistantMessageEvent.contentIndex).toBe(0);
			expect(out.assistantMessageEvent.delta).toBe(" world");
		},
	);

	it("keeps partial on *_start and *_end events (consolidated content stays)", () => {
		const startEvent = {
			type: "message_update",
			message: fakeAgentMessage,
			assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: fakePartial },
		};
		const endEvent = {
			type: "message_update",
			message: fakeAgentMessage,
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello world", partial: fakePartial },
		};
		const startOut = JSON.parse(serializeJsonEvent(startEvent, true));
		const endOut = JSON.parse(serializeJsonEvent(endEvent, true));
		expect(startOut.assistantMessageEvent.partial).toEqual(fakePartial);
		expect(startOut.message).toEqual(fakeAgentMessage);
		expect(endOut.assistantMessageEvent.content).toBe("Hello world");
		expect(endOut.assistantMessageEvent.partial).toEqual(fakePartial);
	});

	it("passes non-message_update events through unchanged", () => {
		const events = [
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "turn_end", message: fakeAgentMessage, toolResults: [] },
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} },
			{ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: "ok", isError: false },
			{ type: "agent_end", messages: [fakeAgentMessage] },
		];
		for (const event of events) {
			expect(JSON.parse(serializeJsonEvent(event, true))).toEqual(event);
		}
	});

	it("handles malformed events safely (passes through)", () => {
		expect(serializeJsonEvent(null, true)).toBe("null");
		expect(serializeJsonEvent({ type: "message_update" }, true)).toBe(JSON.stringify({ type: "message_update" }));
	});

	it("turns O(n²) growth into O(n) for a 100-token simulated stream", () => {
		// Without the flag, every line carries the full prior accumulated text.
		// With the flag, every line carries only the new chunk.
		const tokens = 100;
		let accumulated = "";
		let withPartialBytes = 0;
		let withoutPartialBytes = 0;
		for (let i = 0; i < tokens; i++) {
			const chunk = `chunk-${i}-${"x".repeat(64)}`;
			accumulated += chunk;
			const event = {
				type: "message_update",
				message: { role: "assistant", content: [{ type: "text", text: accumulated }] },
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: chunk,
					partial: { role: "assistant", content: [{ type: "text", text: accumulated }] },
				},
			};
			withPartialBytes += serializeJsonEvent(event, false).length;
			withoutPartialBytes += serializeJsonEvent(event, true).length;
		}
		expect(withoutPartialBytes).toBeLessThan(withPartialBytes / 5);
	});
});
