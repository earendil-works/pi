import { describe, expect, it } from "vitest";

import { createExecJsonEventProcessor } from "../src/exec/jsonl-event-processor.js";

describe("exec json adapter (red)", () => {
	it("normalizes mu runtime events into stable public exec events", () => {
		const processor = createExecJsonEventProcessor({ threadId: "thread-123" });

		const events = [
			...processor.consume({ type: "agent_start" }),
			...processor.consume({ type: "turn_start" }),
			...processor.consume({
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "exec_command",
				args: { cmd: "echo hi" },
			}),
		];

		expect(events).toEqual([
			{ type: "thread.started", thread_id: "thread-123" },
			{ type: "turn.started" },
			{
				type: "item.started",
				item: {
					id: "call-1",
					type: "command_execution",
					command: "echo hi",
					status: "in_progress",
				},
			},
		]);

		const publicEventTypes = events.map((event) => event.type);
		expect(publicEventTypes).not.toContain("turn_start");
		expect(publicEventTypes).not.toContain("tool_execution_start");
	});
});
