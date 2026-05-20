import { describe, expect, it } from "vitest";
import {
	type AgentBusMirrorContext,
	addressFingerprint,
	agentSessionEventToAgentBusEvents,
	createAgentBusEvent,
} from "../src/core/agent-bus.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";

const context = {
	source: "pi-agent",
	harness: "pi-agent",
	sessionId: "session-1",
	cwd: "/repo",
	sessionFile: "/tmp/session.jsonl",
} satisfies AgentBusMirrorContext;

const deterministic = {
	now: () => new Date("2026-05-20T00:00:00.000Z"),
	id: () => "event-1",
};

describe("agent bus projection", () => {
	it("creates stable v0 events with provenance", () => {
		const event = createAgentBusEvent("agent.started", {}, context, deterministic);

		expect(event).toEqual({
			schemaVersion: "v0",
			id: "event-1",
			source: "pi-agent",
			harness: "pi-agent",
			sessionId: "session-1",
			cwd: "/repo",
			kind: "agent.started",
			ts: "2026-05-20T00:00:00.000Z",
			payload: {},
			provenance: {
				cwd: "/repo",
				sessionFile: "/tmp/session.jsonl",
			},
		});
	});

	it("redacts queued message text by default", () => {
		const events = agentSessionEventToAgentBusEvents(
			{
				type: "queue_update",
				steering: ["secret steering"],
				followUp: ["secret follow-up"],
			},
			context,
			deterministic,
		);

		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("queue.changed");
		expect(events[0]?.payload).toEqual({
			steeringCount: 1,
			followUpCount: 1,
			steering: undefined,
			followUp: undefined,
		});
		expect(JSON.stringify(events)).not.toContain("secret");
	});

	it("includes queued message text when sensitive data is explicitly enabled", () => {
		const events = agentSessionEventToAgentBusEvents(
			{
				type: "queue_update",
				steering: ["visible steering"],
				followUp: ["visible follow-up"],
			},
			context,
			{ ...deterministic, includeSensitiveData: true },
		);

		expect(events[0]?.payload).toEqual({
			steeringCount: 1,
			followUpCount: 1,
			steering: ["visible steering"],
			followUp: ["visible follow-up"],
		});
	});

	it("skips high-volume message updates unless requested", () => {
		const messageUpdate = {
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
		} as AgentSessionEvent;

		expect(agentSessionEventToAgentBusEvents(messageUpdate, context, deterministic)).toEqual([]);

		const events = agentSessionEventToAgentBusEvents(messageUpdate, context, {
			...deterministic,
			includeMessageUpdates: true,
		});

		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("message.updated");
		expect(events[0]?.payload).toEqual({
			message: {
				role: "assistant",
				content: { kind: "array", length: 1, blockTypes: ["text"] },
			},
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: { kind: "string", length: 5 },
			},
		});
	});

	it("summarizes tool arguments instead of mirroring them by default", () => {
		const events = agentSessionEventToAgentBusEvents(
			{
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: "echo secret" },
			},
			context,
			deterministic,
		);

		expect(events[0]?.payload).toEqual({
			toolCallId: "call-1",
			toolName: "bash",
			args: { kind: "object", keys: ["command"] },
		});
		expect(JSON.stringify(events)).not.toContain("echo secret");
	});

	it("fingerprints addresses compatibly with the envelope schema", () => {
		expect(addressFingerprint({ kind: "session", harness: "pi-agent", sessionId: "s1", host: "host" })).toBe(
			"session:pi-agent:s1:host",
		);
		expect(addressFingerprint({ kind: "role", role: "project-lead", project: "nineight" })).toBe(
			"role:project-lead:nineight::",
		);
	});
});
