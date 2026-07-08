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

describe("turn_end follow-up injection — prevent premature stop with active todos", () => {
	let setup: MockSetup;

	beforeEach(() => {
		setup = setupMock();
		// Reset module-level state via before_agent_start handler
		setup.handlers["before_agent_start"]({ systemPrompt: "" });
	});

	it("injects follow-up when model stops (no tool calls) with active todos", async () => {
		await setTodos(setup.execute, ["pending", "in_progress", "completed"]);

		await setup.handlers["turn_end"](makeTurnEnd([]));

		expect(setup.sendUserMessageCalls).toHaveLength(1);
		expect(setup.sendUserMessageCalls[0]?.options?.deliverAs).toBe("followUp");
		expect(setup.sendUserMessageCalls[0]?.content).toMatch(/2 incomplete todo item/);
	});

	it("does NOT inject follow-up when model made tool calls (still working)", async () => {
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

	it("safety limit: stops nudging after MAX_FOLLOWUP_NUDGES (3)", async () => {
		await setTodos(setup.execute, ["pending", "in_progress"]);

		for (let i = 0; i < 5; i++) {
			await setup.handlers["turn_end"](makeTurnEnd([]));
		}

		expect(setup.sendUserMessageCalls).toHaveLength(3);
	});

	it("before_agent_start resets the nudge counter", async () => {
		await setTodos(setup.execute, ["pending"]);

		// Exhaust the nudge limit
		for (let i = 0; i < 3; i++) {
			await setup.handlers["turn_end"](makeTurnEnd([]));
		}
		expect(setup.sendUserMessageCalls).toHaveLength(3);

		// Reset via before_agent_start (also clears todoItems)
		setup.handlers["before_agent_start"]({ systemPrompt: "" });
		// Re-set todos since before_agent_start cleared them
		await setTodos(setup.execute, ["pending"]);

		// Should nudge again
		await setup.handlers["turn_end"](makeTurnEnd([]));
		expect(setup.sendUserMessageCalls).toHaveLength(4);
	});

	it("nudge message includes active item count", async () => {
		await setTodos(setup.execute, ["pending", "pending", "in_progress", "in_progress", "completed"]);

		await setup.handlers["turn_end"](makeTurnEnd([]));

		expect(setup.sendUserMessageCalls).toHaveLength(1);
		expect(setup.sendUserMessageCalls[0]?.content).toMatch(/4 incomplete todo item/);
	});
});
