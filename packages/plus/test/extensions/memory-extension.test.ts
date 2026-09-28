/**
 * Tests for the memory extension wiring (plus/src/extensions/memory/index.ts):
 * system-prompt index injection, the main-agent-write dedup flag, the
 * agent_settled extraction skip matrix, and the memory_save tool executing
 * through the store.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "vitest";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
} from "../../../coding-agent/src/core/extensions/types.ts";
import type { ExtractDeps } from "../../src/extensions/memory/extract.ts";
import { registerMemory } from "../../src/extensions/memory/index.ts";
import { MemoryStore } from "../../src/extensions/memory/store.ts";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

interface ToolDefinitionLike {
	name: string;
	description: string;
	execute: (...args: unknown[]) => Promise<unknown>;
}

interface CommandLike {
	description: string;
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

interface Harness {
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	tools: Map<string, ToolDefinitionLike>;
	commands: Map<string, CommandLike>;
	notifications: string[];
	store: MemoryStore;
	ctx: ExtensionContext;
	runCalls: unknown[][];
	fire(event: string, eventObj: unknown): Promise<unknown>;
	newCtx(overrides: { mode?: string; messageCount?: number }): ExtensionContext;
}

function harness(): Harness {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mem-ext-"));
	const projectDir = path.join(base, "project");
	const agentDir = path.join(base, "agent");
	const storeDir = path.join(base, "memory");
	fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	// Pin settings to the defaults so a user-level ~/.pi/settings.json cannot
	// leak into the test (an empty "memory" object merges with the defaults).
	fs.writeFileSync(path.join(projectDir, ".pi", "settings.json"), JSON.stringify({ memory: {} }), "utf8");
	process.env[ENV_AGENT_DIR] = agentDir;

	const store = MemoryStore.forDir(storeDir);
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const tools = new Map<string, ToolDefinitionLike>();
	const commands = new Map<string, CommandLike>();
	const notifications: string[] = [];
	const runCalls: unknown[][] = [];
	const runAgent: ExtractDeps["runAgent"] = async (...args: unknown[]) => {
		runCalls.push(args);
		return {} as never;
	};

	const makeCtx = (overrides: { mode?: string; messageCount?: number } = {}): ExtensionContext => {
		const messageCount = overrides.messageCount ?? 20;
		return {
			ui: {
				notify: (message: string) => notifications.push(message),
				setStatus: () => {},
			},
			mode: overrides.mode ?? "tui",
			cwd: projectDir,
			model: undefined,
			sessionManager: {
				getSessionId: () => "session-1",
				buildSessionProjection: () => ({
					entries: [],
					messages: Array.from({ length: messageCount }, (_, i) => ({
						role: "user",
						content: `message ${i}`,
						timestamp: i,
					})),
					thinkingLevel: "none",
					model: null,
				}),
			},
		} as unknown as ExtensionContext;
	};
	const ctx = makeCtx();

	registerMemory(
		{
			registerTool: (tool: ToolDefinitionLike) => {
				tools.set(tool.name, tool);
			},
			registerCommand: (name: string, command: never) => {
				commands.set(name, command);
			},
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI,
		{ storeFor: () => store, runAgent },
	);

	const fire = async (event: string, eventObj: unknown): Promise<unknown> => {
		const handler = handlers.get(event);
		assert.ok(handler, `handler for ${event} must be registered`);
		return handler(eventObj, ctx);
	};

	return {
		handlers,
		tools,
		commands,
		notifications,
		store,
		ctx,
		runCalls,
		fire,
		newCtx: makeCtx,
	};
}

afterEach(() => {
	delete process.env[ENV_AGENT_DIR];
});

/** Flush pending microtasks: the extractor spawns inside a fire-and-forget async IIFE. */
async function flush(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

describe("memory extension wiring", () => {
	it("registers the tools, the /memory command, and all event handlers", () => {
		const h = harness();
		assert.ok(h.tools.has("memory_save"));
		assert.ok(h.tools.has("memory_recall"));
		assert.ok(h.commands.has("memory"));
		for (const event of ["tool_call", "agent_start", "before_agent_start", "agent_settled"]) {
			assert.ok(h.handlers.has(event), `handler for ${event} must be registered`);
		}
	});

	it("injects the MEMORY.md index into the system prompt when memories exist", async () => {
		const h = harness();
		await h.store.save({ name: "Prefers pnpm", description: "package manager", type: "user", body: "Use pnpm." });
		const event = { type: "before_agent_start", prompt: "hi", systemPromptOptions: { sections: {} } };
		await h.fire("before_agent_start", event);
		const sections = (event as BeforeAgentStartEvent).systemPromptOptions.sections as Record<string, string>;
		assert.ok(sections.memory.includes("Prefers pnpm"));
		assert.ok(sections.memory.includes("memory_recall"));
	});

	it("does not inject a memory section when the index is empty", async () => {
		const h = harness();
		const event = { type: "before_agent_start", prompt: "hi", systemPromptOptions: { sections: {} } };
		await h.fire("before_agent_start", event);
		const sections = (event as BeforeAgentStartEvent).systemPromptOptions.sections as Record<string, string>;
		assert.equal(sections.memory, undefined);
	});

	it("does not inject a memory section when the feature is disabled", async () => {
		const h = harness();
		await h.store.save({ name: "Prefers pnpm", description: "package manager", type: "user", body: "Use pnpm." });
		fs.writeFileSync(
			path.join(h.ctx.cwd, ".pi", "settings.json"),
			JSON.stringify({ memory: { enabled: false } }),
			"utf8",
		);
		const event = { type: "before_agent_start", prompt: "hi", systemPromptOptions: { sections: {} } };
		await h.fire("before_agent_start", event);
		const sections = (event as BeforeAgentStartEvent).systemPromptOptions.sections as Record<string, string>;
		assert.equal(sections.memory, undefined);
	});

	it("memory_save tool execute writes through the store", async () => {
		const h = harness();
		const tool = h.tools.get("memory_save");
		assert.ok(tool);
		const result = (await tool.execute(
			"call-1",
			{ name: "Auth decision", description: "JWT over sessions", type: "project", body: "Use JWT." },
			undefined,
			undefined,
			h.ctx,
		)) as { content: { type: string; text: string }[] };
		const listed = await h.store.list();
		assert.equal(listed.length, 1);
		assert.equal(listed[0].name, "Auth decision");
		assert.ok(result.content[0].text.includes("Saved memory"));
	});

	it("skips extraction after the main agent saved a memory, until the next run", async () => {
		const h = harness();
		await h.fire("tool_call", { toolCallId: "1", toolName: "memory_save", input: {} });
		await h.fire("agent_settled", { type: "agent_settled" });
		await flush();
		assert.equal(h.runCalls.length, 0);
		// agent_start clears the dedup flag: extraction may run again.
		await h.fire("agent_start", { type: "agent_start" });
		await h.fire("agent_settled", { type: "agent_settled" });
		await flush();
		assert.equal(h.runCalls.length, 1);
	});

	it("skips extraction in non-interactive modes", async () => {
		const h = harness();
		const jsonCtx = h.newCtx({ mode: "json" });
		const handler = h.handlers.get("agent_settled");
		assert.ok(handler);
		await handler({ type: "agent_settled" }, jsonCtx);
		assert.equal(h.runCalls.length, 0);
	});

	it("skips extraction below the minimum message delta and within the cooldown", async () => {
		const h = harness();
		// 3 messages < default extractMinMessages (8).
		const quietCtx = h.newCtx({ messageCount: 3 });
		const handler = h.handlers.get("agent_settled");
		assert.ok(handler);
		await handler({ type: "agent_settled" }, quietCtx);
		await flush();
		assert.equal(h.runCalls.length, 0);

		// Now settle a large transcript: extraction fires once…
		await handler({ type: "agent_settled" }, h.ctx);
		await flush();
		assert.equal(h.runCalls.length, 1);
		// …and an immediate second settle does not fire again (cooldown +
		// no new messages since the last attempt).
		await handler({ type: "agent_settled" }, h.ctx);
		await flush();
		assert.equal(h.runCalls.length, 1);
	});

	it("passes the project cwd and session model to the extractor", async () => {
		const h = harness();
		await h.fire("agent_settled", { type: "agent_settled" });
		await flush();
		assert.equal(h.runCalls.length, 1);
		const [defaultCwd, dispatchDefaults, agent, task] = h.runCalls[0] as [
			string,
			{ model: string | undefined },
			{ name: string; tools: string[] },
			string,
		];
		assert.equal(defaultCwd, h.ctx.cwd);
		assert.equal(dispatchDefaults.model, undefined); // no session model in the harness
		assert.equal(agent.name, "memory-extractor");
		assert.deepEqual(agent.tools, ["memory_save", "memory_recall"]);
		assert.ok(task.includes("Conversation transcript"));
		assert.ok(task.includes("memory index"));
	});
});
