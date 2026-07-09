import { beforeEach, describe, expect, it } from "vitest";
import { registerTools } from "../tools.ts";
import type { TodoItem } from "../tools.ts";
import type { ExtensionAPI, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

type Execute = (
	toolCallId: string,
	params: { items: TodoItem[] },
) => Promise<{ content: Array<{ type: string; text: string }>; details: { error?: string; items?: TodoItem[] } }>;

interface MockSetup {
	execute: Execute;
	handlers: Record<string, (event: unknown) => unknown>;
	sendUserMessageCalls: Array<{ content: string; options?: { deliverAs?: string } }>;
}

function setupMock(): MockSetup {
	const handlers: Record<string, (event: unknown) => unknown> = {};
	const tools = new Map<string, { name: string; execute: Execute }>();
	const sendUserMessageCalls: MockSetup["sendUserMessageCalls"] = [];

	const pi = {
		on: (event: string, handler: (event: unknown) => unknown) => {
			handlers[event] = handler;
		},
		registerTool: (tool: { name: string; execute: Execute }) => {
			tools.set(tool.name, tool);
		},
		sendUserMessage: (content: string, options?: { deliverAs?: string }) => {
			sendUserMessageCalls.push({ content, options });
			return Promise.resolve();
		},
	} as unknown as ExtensionAPI;

	registerTools(pi);

	const tool = tools.get("todowrite");
	if (!tool) throw new Error("todowrite tool not registered");

	return { execute: tool.execute, handlers, sendUserMessageCalls };
}

function makeAssistantMessage(stopReason?: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Done" }],
		stopReason: stopReason ?? "stop",
		timestamp: Date.now(),
	} as AgentMessage;
}

function makeTurnEnd(toolResults: unknown[], stopReason?: string): TurnEndEvent {
	return {
		type: "turn_end",
		turnIndex: 0,
		message: makeAssistantMessage(stopReason),
		toolResults: toolResults as TurnEndEvent["toolResults"],
	};
}

async function setTodos(execute: Execute, statuses: Array<TodoItem["status"]>): Promise<void> {
	const items = statuses.map((status, i) => ({
		id: String(i + 1),
		content: `task ${i + 1}`,
		status,
	}));
	const result = await execute("setup", { items });
	if (result.details.error) throw new Error(`Failed to set todos: ${result.details.error}`);
}

describe("turn_end does not force continuation (Claude Code-style)", () => {
	let setup: MockSetup;

	beforeEach(() => {
		setup = setupMock();
		// Reset module-level state via before_agent_start handler
		setup.handlers["before_agent_start"]({ systemPrompt: "" });
	});

	it("does NOT inject follow-up when model stops with no tool calls and active todos (prevents dead loop)", async () => {
		await setTodos(setup.execute, ["pending", "in_progress", "completed"]);

		await setup.handlers["turn_end"](makeTurnEnd([]));

		expect(setup.sendUserMessageCalls).toHaveLength(0);
	});

	it("does NOT inject follow-up when model made tool calls", async () => {
		await setTodos(setup.execute, ["pending", "in_progress"]);

		await setup.handlers["turn_end"](makeTurnEnd([{ role: "toolResult", content: [], toolCallId: "tc1", timestamp: Date.now() }]));

		expect(setup.sendUserMessageCalls).toHaveLength(0);
	});

	it("does NOT inject follow-up when all todos are completed/cancelled", async () => {
		await setTodos(setup.execute, ["completed", "cancelled"]);

		await setup.handlers["turn_end"](makeTurnEnd([]));

		expect(setup.sendUserMessageCalls).toHaveLength(0);
	});

	it("does NOT inject follow-up on error/aborted stop reason", async () => {
		await setTodos(setup.execute, ["pending", "in_progress"]);

		await setup.handlers["turn_end"](makeTurnEnd([], "error"));
		expect(setup.sendUserMessageCalls).toHaveLength(0);

		await setup.handlers["turn_end"](makeTurnEnd([], "aborted"));
		expect(setup.sendUserMessageCalls).toHaveLength(0);
	});

	it("context-hook still nudges at roundsSinceTodo >= 3 (Claude Code-style soft nag, no forced continuation)", async () => {
		await setTodos(setup.execute, ["pending", "in_progress"]);

		// Three text-only turns increment roundsSinceTodo to 3. turn_end must NOT
		// force a follow-up — that would reset the counter and starve the
		// context-hook nag (the dead-loop root cause).
		await setup.handlers["turn_end"](makeTurnEnd([]));
		await setup.handlers["turn_end"](makeTurnEnd([]));
		await setup.handlers["turn_end"](makeTurnEnd([]));

		const messages: AgentMessage[] = [];
		setup.handlers["context"]({ messages });

		expect(messages).toHaveLength(1);
		const pushed = messages[0] as { content?: Array<{ type: string; text?: string }> };
		expect(pushed.content?.[0]?.text).toMatch(/todos stale/);
	});
});
