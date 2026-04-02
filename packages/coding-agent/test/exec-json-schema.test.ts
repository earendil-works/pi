import { describe, expect, it } from "vitest";

import { isExecEvent } from "../src/exec/exec-events.js";

describe("exec json schema", () => {
	it("accepts the public dotted exec event names and rejects raw internal names", () => {
		expect(isExecEvent({ type: "thread.started", thread_id: "session-1" })).toBe(true);
		expect(
			isExecEvent({
				type: "item.completed",
				item: {
					id: "item_1",
					type: "agent_message",
					text: "done",
				},
			}),
		).toBe(true);

		expect(isExecEvent({ type: "turn_start" })).toBe(false);
		expect(isExecEvent({ type: "tool_execution_start", toolName: "exec_command" })).toBe(false);
	});
});
