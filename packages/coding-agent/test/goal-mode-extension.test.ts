import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import goalModeExtension from "../examples/extensions/goal-mode/index.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/index.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type CommandRegistration = {
	handler: CommandHandler;
	argumentHint?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
};

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createTextMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function customData(entry: SessionEntry | undefined): unknown {
	return entry && entry.type === "custom" ? entry.data : undefined;
}

function setup(options: { idle?: boolean; pending?: boolean; flagGoal?: string; flagBudgetTokens?: string } = {}) {
	const commands = new Map<string, CommandHandler>();
	const commandOptions = new Map<string, CommandRegistration>();
	const handlers = new Map<string, EventHandler>();
	const tools = new Map<string, ToolDefinition>();
	const entries: SessionEntry[] = [];

	const sendUserMessage = vi.fn<ExtensionAPI["sendUserMessage"]>();
	const appendEntry = vi.fn<ExtensionAPI["appendEntry"]>((customType: string, data: unknown) => {
		entries.push({
			type: "custom",
			customType,
			data,
			id: `entry-${entries.length}`,
			parentId: entries.length > 0 ? entries[entries.length - 1]!.id : null,
			timestamp: new Date().toISOString(),
		} as SessionEntry);
	});
	const notify = vi.fn();
	const setStatus = vi.fn();
	const setWidget = vi.fn();
	const setTitle = vi.fn();
	const abort = vi.fn();
	let idle = options.idle ?? true;

	const api = {
		registerFlag: vi.fn(),
		registerCommand(name: string, command: CommandRegistration) {
			commandOptions.set(name, command);
			commands.set(name, command.handler);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: EventHandler) {
			handlers.set(event, handler);
		},
		getFlag: vi.fn((name: string) => {
			if (name === "goal") return options.flagGoal;
			if (name === "goal-budget-tokens") return options.flagBudgetTokens;
			return undefined;
		}),
		getSessionName: vi.fn(() => undefined),
		sendUserMessage,
		appendEntry,
	} as unknown as ExtensionAPI;

	goalModeExtension(api);

	const ctx = {
		hasUI: true,
		ui: { notify, setStatus, setWidget, setTitle },
		sessionManager: { getBranch: () => entries },
		isIdle: () => idle,
		hasPendingMessages: () => options.pending ?? false,
		abort,
		mode: "tui",
	} as unknown as ExtensionContext;

	// Reset module-level extension state between setup instances, simulating a
	// fresh session without triggering a new goal.
	handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);

	async function runCommand(name: string, args = ""): Promise<void> {
		const command = commands.get(name);
		if (!command) throw new Error(`Missing command: ${name}`);
		await command(args, ctx);
	}

	async function emit(event: string, payload: unknown): Promise<unknown> {
		const handler = handlers.get(event);
		if (!handler) throw new Error(`Missing handler: ${event}`);
		return await handler(payload, ctx);
	}

	return {
		abort,
		appendEntry,
		commandOptions,
		commands,
		ctx,
		emit,
		entries,
		handlers,
		notify,
		runCommand,
		sendUserMessage,
		setIdle: (value: boolean) => {
			idle = value;
		},
		setStatus,
		setTitle,
		setWidget,
		tools,
	};
}

describe("goal-mode example extension", () => {
	it("registers /goal with a usage hint and subcommand completions", () => {
		const { commandOptions } = setup();
		const goalCommand = commandOptions.get("goal");

		expect(goalCommand?.argumentHint).toBe("<objective> [--tokens N] [--cost N] | pause | resume | clear");
		expect(goalCommand?.getArgumentCompletions?.("")).toEqual([
			{ value: "pause", label: "pause", description: "Pause the active goal" },
			{ value: "resume", label: "resume", description: "Resume a paused goal" },
			{ value: "clear", label: "clear", description: "Clear the goal" },
		]);
		expect(goalCommand?.getArgumentCompletions?.("re")).toEqual([
			{ value: "resume", label: "resume", description: "Resume a paused goal" },
		]);
		expect(goalCommand?.getArgumentCompletions?.("Fix tests")).toBeNull();
	});

	it("sets a goal, persists it, and starts work", async () => {
		const { entries, runCommand, sendUserMessage, setStatus, setTitle, setWidget } = setup();

		await runCommand("goal", "Fix the flaky suite --tokens 100");

		const goalEntry = entries.find((entry) => entry.type === "custom" && entry.customType === "goal-mode");
		expect(goalEntry).toBeDefined();
		expect(customData(goalEntry)).toMatchObject({
			objective: "Fix the flaky suite",
			status: "active",
			budget: { tokens: 100 },
		});
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(sendUserMessage.mock.calls[0]?.[0]).toContain("Fix the flaky suite");
		expect(setStatus).toHaveBeenLastCalledWith("goal-mode", "mode: goal");
		expect(setWidget).toHaveBeenLastCalledWith("goal-mode", [
			"[GOAL MODE]",
			"Objective: Fix the flaky suite",
			"Budget: tokens 100",
		]);
		expect(setTitle).toHaveBeenLastCalledWith("[GOAL MODE] Fix the flaky suite");
	});

	it("replaces an active goal while streaming by aborting and restarting after settle", async () => {
		const { abort, emit, runCommand, sendUserMessage, setIdle } = setup({ idle: false });

		await runCommand("goal", "First goal");
		expect(abort).toHaveBeenCalledTimes(1);
		expect(sendUserMessage).not.toHaveBeenCalled();
		await emit("agent_start", { type: "agent_start" });

		await runCommand("goal", "Second goal");
		expect(abort).toHaveBeenCalledTimes(2);
		expect(sendUserMessage).not.toHaveBeenCalled();

		setIdle(true);
		await emit("agent_settled", { type: "agent_settled" });

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(sendUserMessage.mock.calls[0]?.[0]).toContain("Second goal");
	});

	it("ignores turn_end events from a goal that was replaced mid-run", async () => {
		const { abort, emit, entries, runCommand, sendUserMessage, setIdle } = setup({ idle: false });

		await runCommand("goal", "First goal");
		expect(abort).toHaveBeenCalledTimes(1);
		await emit("agent_start", { type: "agent_start" });

		await runCommand("goal", "Second goal");
		expect(abort).toHaveBeenCalledTimes(2);

		await emit("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: createAssistantMessage("First goal progress"),
			toolResults: [],
		});

		const latest = customData(entries.at(-1)) as { objective?: string; progress?: string[] };
		expect(latest.objective).toBe("Second goal");
		expect(latest.progress ?? []).not.toContain(expect.stringContaining("First goal progress"));

		setIdle(true);
		await emit("agent_settled", { type: "agent_settled" });
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(sendUserMessage.mock.calls[0]?.[0]).toContain("Second goal");
	});

	it("does not restart a cleared goal after an in-flight set was aborted", async () => {
		const { abort, emit, runCommand, sendUserMessage, setIdle } = setup({ idle: false });

		await runCommand("goal", "First goal");
		await emit("agent_start", { type: "agent_start" });
		await runCommand("goal", "clear");
		expect(abort).toHaveBeenCalledTimes(2);

		setIdle(true);
		await emit("agent_settled", { type: "agent_settled" });

		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("does not queue a second continuation while one is already queued", async () => {
		const { emit, runCommand, sendUserMessage } = setup();

		await runCommand("goal", "First goal");
		expect(sendUserMessage).toHaveBeenCalledTimes(1);

		await runCommand("goal", "First goal");
		expect(sendUserMessage).toHaveBeenCalledTimes(1);

		await emit("agent_start", { type: "agent_start" });
		await runCommand("goal", "First goal");
		expect(sendUserMessage).toHaveBeenCalledTimes(2);
	});

	it("resumes an active goal that stopped after a no-tool-call turn", async () => {
		const { emit, runCommand, sendUserMessage } = setup();

		await runCommand("goal", "Fix tests");
		await emit("agent_start", { type: "agent_start" });
		await emit("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: createAssistantMessage("I checked, nothing to change"),
			toolResults: [],
		});

		await runCommand("goal", "resume");

		expect(sendUserMessage).toHaveBeenCalledTimes(2);
		expect(sendUserMessage.mock.calls[1]?.[0]).toContain("Fix tests");
	});

	it("reloads goal state after session tree navigation", async () => {
		const { emit, entries, runCommand, setStatus } = setup();

		await runCommand("goal", "Fix tests");
		entries.push({
			type: "custom",
			customType: "goal-mode",
			data: null,
			id: "cleared",
			parentId: "goal-entry",
			timestamp: new Date().toISOString(),
		} as SessionEntry);

		await emit("session_tree", { type: "session_tree", newLeafId: "cleared", oldLeafId: "goal-entry" });

		expect(setStatus).toHaveBeenLastCalledWith("goal-mode", "mode: build");
	});

	it("pauses, resumes, and clears a goal", async () => {
		const { abort, entries, runCommand, setStatus, setTitle, setWidget } = setup();

		await runCommand("goal", "Fix tests");
		await runCommand("goal", "pause");
		expect(customData(entries.at(-1))).toMatchObject({ status: "paused" });
		expect(setStatus).toHaveBeenLastCalledWith("goal-mode", "mode: goal");
		expect(setWidget).toHaveBeenLastCalledWith("goal-mode", ["[GOAL PAUSED]", "Objective: Fix tests"]);
		expect(abort).toHaveBeenCalledTimes(1);

		await runCommand("goal", "resume");
		expect(customData(entries.at(-1))).toMatchObject({ status: "active" });
		expect(setStatus).toHaveBeenLastCalledWith("goal-mode", "mode: goal");

		await runCommand("goal", "clear");
		expect(customData(entries.at(-1))).toBeNull();
		expect(setStatus).toHaveBeenLastCalledWith("goal-mode", "mode: build");
		expect(setWidget).toHaveBeenLastCalledWith("goal-mode", undefined);
		expect(setTitle).toHaveBeenLastCalledWith(expect.stringContaining("pi - "));
		expect(abort).toHaveBeenCalledTimes(2);
	});

	it("tracks tool usage and progress on turn end", async () => {
		const { emit, runCommand, entries } = setup();

		await runCommand("goal", "Fix tests");
		await emit("agent_start", { type: "agent_start" });
		const assistant = createAssistantMessage("Ran the suite and fixed one failure");
		await emit("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: assistant,
			toolResults: [{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], timestamp: 0 }],
		});

		const latest = customData(entries.at(-1)) as {
			lastTurnHadToolCall?: boolean;
			progress?: string[];
		};
		expect(latest.lastTurnHadToolCall).toBe(true);
		expect(latest.progress?.[0]).toContain("Ran the suite");
	});

	it("continues only when the goal is active, idle, and the last turn used a tool", async () => {
		const { emit, runCommand, sendUserMessage } = setup();

		await runCommand("goal", "Fix tests");
		await emit("agent_start", { type: "agent_start" });
		const assistant = createAssistantMessage("checked the suite");
		await emit("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: assistant,
			toolResults: [{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], timestamp: 0 }],
		});
		await emit("agent_settled", { type: "agent_settled" });

		expect(sendUserMessage).toHaveBeenCalledTimes(2);
	});

	it("does not spin after a turn with no tool calls", async () => {
		const { emit, notify, runCommand, sendUserMessage, setWidget } = setup();

		await runCommand("goal", "Fix tests");
		await emit("agent_start", { type: "agent_start" });
		await emit("turn_end", {
			type: "turn_end",
			turnIndex: 1,
			message: createAssistantMessage("I checked and the suite is green"),
			toolResults: [],
		});
		await emit("agent_settled", { type: "agent_settled" });

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("no tool calls"), "info");
		expect(setWidget).toHaveBeenLastCalledWith("goal-mode", expect.arrayContaining(["[GOAL MODE (WAITING)]"]));
	});

	it("respects queued user input before auto-continuing", async () => {
		const { emit, runCommand, sendUserMessage } = setup({ pending: true });

		await runCommand("goal", "Fix tests");
		await emit("agent_start", { type: "agent_start" });
		await emit("agent_settled", { type: "agent_settled" });

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("marks the goal budget-limited instead of continuing", async () => {
		const { emit, runCommand, entries } = setup();

		await runCommand("goal", "Fix tests --tokens 10");
		await emit("agent_start", { type: "agent_start" });
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "mock",
				usage: {
					input: 10,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
			id: "usage",
			parentId: null,
			timestamp: new Date().toISOString(),
		} as SessionEntry);
		await emit("agent_settled", { type: "agent_settled" });

		expect(customData(entries.at(-1))).toMatchObject({ status: "budget_limited" });
	});

	it("resumes a budget-limited goal with a fresh baseline", async () => {
		const { emit, entries, notify, runCommand, sendUserMessage } = setup();

		await runCommand("goal", "Fix tests --tokens 10");
		await emit("agent_start", { type: "agent_start" });
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "mock",
				usage: {
					input: 10,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
			id: "usage",
			parentId: null,
			timestamp: new Date().toISOString(),
		} as SessionEntry);
		await emit("agent_settled", { type: "agent_settled" });
		expect(customData(entries.at(-1))).toMatchObject({ status: "budget_limited" });

		await runCommand("goal", "resume");

		expect(customData(entries.at(-1))).toMatchObject({
			status: "active",
			baseline: { tokens: 20, cost: 0 },
		});
		expect(sendUserMessage).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenCalledWith("Goal resumed.", "info");
	});

	it("shows usage in /goal view for non-active budgets", async () => {
		const { emit, entries, notify, runCommand } = setup();

		await runCommand("goal", "Fix tests --tokens 10");
		await emit("agent_start", { type: "agent_start" });
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "mock",
				usage: {
					input: 10,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
			id: "usage",
			parentId: null,
			timestamp: new Date().toISOString(),
		} as SessionEntry);
		await emit("agent_settled", { type: "agent_settled" });

		await runCommand("goal");

		expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("tokens 20/10"), "info");
	});

	it("injects budget usage into the active goal context", async () => {
		const { emit, entries, runCommand } = setup();

		await runCommand("goal", "Fix tests --tokens 100");
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "mock",
				usage: {
					input: 50,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 50,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
			id: "usage",
			parentId: null,
			timestamp: new Date().toISOString(),
		} as SessionEntry);

		const result = (await emit("context", {
			type: "context",
			messages: [createTextMessage("hello")],
		})) as { messages: AgentMessage[] };
		const context = result.messages.at(-1) as { content?: string };
		expect(context.content).toContain("Budget: tokens 50/100");
	});

	it("does not auto-continue after session tree navigation", async () => {
		const { emit, entries, runCommand, sendUserMessage, setStatus } = setup();

		await runCommand("goal", "Fix tests");
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		const goalEntry = entries.find((entry) => entry.type === "custom" && entry.customType === "goal-mode");
		const goalData = customData(goalEntry);

		entries.push({
			type: "custom",
			customType: "goal-mode",
			data: null,
			id: "cleared",
			parentId: goalEntry?.id ?? null,
			timestamp: new Date().toISOString(),
		} as SessionEntry);
		await emit("session_tree", { type: "session_tree", newLeafId: "cleared", oldLeafId: "goal-entry" });
		expect(setStatus).toHaveBeenLastCalledWith("goal-mode", "mode: build");

		entries.push({
			type: "custom",
			customType: "goal-mode",
			data: goalData,
			id: "goal-again",
			parentId: "cleared",
			timestamp: new Date().toISOString(),
		} as SessionEntry);
		await emit("session_tree", { type: "session_tree", newLeafId: "goal-again", oldLeafId: "cleared" });
		expect(setStatus).toHaveBeenLastCalledWith("goal-mode", "mode: goal");
		await emit("agent_settled", { type: "agent_settled" });
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("injects active goal context and removes stale context", async () => {
		const { emit, runCommand } = setup();
		const stale = {
			role: "custom",
			customType: "goal-mode-context",
			content: "old",
			display: false,
			timestamp: 0,
		} as AgentMessage;

		await runCommand("goal", "Fix tests");
		const activeResult = (await emit("context", {
			type: "context",
			messages: [createTextMessage("hello"), stale],
		})) as { messages: AgentMessage[] };
		expect(activeResult.messages).toHaveLength(2);
		expect(activeResult.messages[1]).toMatchObject({ customType: "goal-mode-context" });

		await runCommand("goal", "pause");
		const pausedResult = (await emit("context", {
			type: "context",
			messages: [createTextMessage("hello"), stale],
		})) as { messages: AgentMessage[] };
		expect(pausedResult.messages).toHaveLength(1);
		expect(pausedResult.messages[0]).toMatchObject({ role: "user" });
	});

	it("registers a complete_goal tool that requires evidence", async () => {
		const { ctx, entries, runCommand, tools } = setup();
		await runCommand("goal", "Fix tests");

		const tool = tools.get("complete_goal");
		expect(tool).toBeDefined();
		const result = await tool!.execute(
			"call-1",
			{ evidence: "  suite   passes with 0 failures  " },
			undefined,
			undefined,
			ctx,
		);

		expect(result.terminate).toBe(true);
		expect(customData(entries.at(-1))).toMatchObject({
			status: "complete",
			lastCompletionEvidence: "suite passes with 0 failures",
		});
		expect(result.details).toEqual({
			objective: "Fix tests",
			evidence: "suite passes with 0 failures",
		});
	});

	it("rejects completion evidence that is too short", async () => {
		const { ctx, runCommand, tools } = setup();
		await runCommand("goal", "Fix tests");

		const tool = tools.get("complete_goal");
		await expect(tool!.execute("call-1", { evidence: "done" }, undefined, undefined, ctx)).rejects.toThrow(
			"at least 20 characters",
		);
	});

	it("starts a goal from the --goal startup flag", async () => {
		const { emit, sendUserMessage, entries } = setup({ flagGoal: "Startup goal" });

		await emit("session_start", { type: "session_start", reason: "startup" });

		expect(customData(entries.at(-1))).toMatchObject({ objective: "Startup goal", status: "active" });
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(sendUserMessage.mock.calls[0]?.[0]).toContain("Startup goal");
	});

	it("warns instead of silently ignoring an invalid budget startup flag", async () => {
		const { emit, notify } = setup({ flagGoal: "Startup goal", flagBudgetTokens: "abc" });

		await emit("session_start", { type: "session_start", reason: "startup" });

		expect(notify).toHaveBeenCalledWith("Ignoring invalid --goal-budget-tokens value: abc", "warning");
	});
});
