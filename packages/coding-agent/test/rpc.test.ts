import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * RPC mode tests.
 */
describe.skipIf(!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_OAUTH_TOKEN)("RPC mode", () => {
	let client: RpcClient;
	let sessionDir: string;

	beforeEach(() => {
		sessionDir = join(tmpdir(), `pi-rpc-test-${Date.now()}`);
		client = new RpcClient({
			cliPath: join(__dirname, "..", "dist", "cli.js"),
			cwd: join(__dirname, ".."),
			env: { PI_CODING_AGENT_DIR: sessionDir },
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
	});

	afterEach(async () => {
		await client.stop();
		if (sessionDir && existsSync(sessionDir)) {
			rmSync(sessionDir, { recursive: true });
		}
	});

	test("should get state", async () => {
		await client.start();
		const state = await client.getState();

		expect(state.model).toBeDefined();
		expect(state.model?.provider).toBe("anthropic");
		expect(state.model?.id).toBe("claude-sonnet-4-5");
		expect(state.isStreaming).toBe(false);
		expect(state.messageCount).toBe(0);
	}, 30000);

	test("should save messages to session file", async () => {
		await client.start();

		// Send prompt and wait for completion
		const events = await client.promptAndWait("Reply with just the word 'hello'");

		// Should have message events
		const messageEndEvents = events.filter((e) => e.type === "message_end");
		expect(messageEndEvents.length).toBeGreaterThanOrEqual(2); // user + assistant

		// Wait for file writes
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Verify session file
		const sessionsPath = join(sessionDir, "sessions");
		expect(existsSync(sessionsPath)).toBe(true);

		const sessionDirs = readdirSync(sessionsPath);
		expect(sessionDirs.length).toBeGreaterThan(0);

		const cwdSessionDir = join(sessionsPath, sessionDirs[0]);
		const sessionFiles = readdirSync(cwdSessionDir).filter((f) => f.endsWith(".jsonl"));
		expect(sessionFiles.length).toBe(1);

		const sessionContent = readFileSync(join(cwdSessionDir, sessionFiles[0]), "utf8");
		const entries = sessionContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		// First entry should be session header
		expect(entries[0].type).toBe("session");

		// Should have user and assistant messages
		const messages = entries.filter((e: { type: string }) => e.type === "message");
		expect(messages.length).toBeGreaterThanOrEqual(2);

		const roles = messages.map((m: { message: { role: string } }) => m.message.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
	}, 90000);

	test("should handle manual compaction", async () => {
		await client.start();

		// First send a prompt to have messages to compact
		await client.promptAndWait("Say hello");

		// Compact
		const result = await client.compact();
		expect(result.summary).toBeDefined();
		expect(result.tokensBefore).toBeGreaterThan(0);

		// Wait for file writes
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Verify compaction in session file
		const sessionsPath = join(sessionDir, "sessions");
		const sessionDirs = readdirSync(sessionsPath);
		const cwdSessionDir = join(sessionsPath, sessionDirs[0]);
		const sessionFiles = readdirSync(cwdSessionDir).filter((f) => f.endsWith(".jsonl"));
		const sessionContent = readFileSync(join(cwdSessionDir, sessionFiles[0]), "utf8");
		const entries = sessionContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		const compactionEntries = entries.filter((e: { type: string }) => e.type === "compaction");
		expect(compactionEntries.length).toBe(1);
		expect(compactionEntries[0].summary).toBeDefined();
	}, 120000);

	test("should execute bash command", async () => {
		await client.start();

		const result = await client.bash("echo hello");
		expect(result.output.trim()).toBe("hello");
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
	}, 30000);

	test("should add bash output to context", async () => {
		await client.start();

		// First send a prompt to initialize session
		await client.promptAndWait("Say hi");

		// Run bash command
		const uniqueValue = `test-${Date.now()}`;
		await client.bash(`echo ${uniqueValue}`);

		// Wait for file writes
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Verify bash message in session
		const sessionsPath = join(sessionDir, "sessions");
		const sessionDirs = readdirSync(sessionsPath);
		const cwdSessionDir = join(sessionsPath, sessionDirs[0]);
		const sessionFiles = readdirSync(cwdSessionDir).filter((f) => f.endsWith(".jsonl"));
		const sessionContent = readFileSync(join(cwdSessionDir, sessionFiles[0]), "utf8");
		const entries = sessionContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		const bashMessages = entries.filter(
			(e: { type: string; message?: { role: string } }) =>
				e.type === "message" && e.message?.role === "bashExecution",
		);
		expect(bashMessages.length).toBe(1);
		expect(bashMessages[0].message.output).toContain(uniqueValue);
	}, 90000);

	test("should include bash output in LLM context", async () => {
		await client.start();

		// Run a bash command with a unique value
		const uniqueValue = `unique-${Date.now()}`;
		await client.bash(`echo ${uniqueValue}`);

		// Ask the LLM what the output was
		const events = await client.promptAndWait(
			"What was the exact output of the echo command I just ran? Reply with just the value, nothing else.",
		);

		// Find assistant's response
		const messageEndEvents = events.filter((e) => e.type === "message_end") as AgentEvent[];
		const assistantMessage = messageEndEvents.find(
			(e) => e.type === "message_end" && e.message?.role === "assistant",
		) as any;

		expect(assistantMessage).toBeDefined();

		const textContent = assistantMessage.message.content.find((c: any) => c.type === "text");
		expect(textContent?.text).toContain(uniqueValue);
	}, 90000);

	test("should set and get thinking level", async () => {
		await client.start();

		// Set thinking level
		await client.setThinkingLevel("high");

		// Verify via state
		const state = await client.getState();
		expect(state.thinkingLevel).toBe("high");
	}, 30000);

	test("should cycle thinking level", async () => {
		await client.start();

		// Get initial level
		const initialState = await client.getState();
		const initialLevel = initialState.thinkingLevel;

		// Cycle
		const result = await client.cycleThinkingLevel();
		expect(result).toBeDefined();
		expect(result!.level).not.toBe(initialLevel);

		// Verify via state
		const newState = await client.getState();
		expect(newState.thinkingLevel).toBe(result!.level);
	}, 30000);

	test("should get available thinking levels", async () => {
		await client.start();

		const levels = await client.getAvailableThinkingLevels();
		expect(levels.length).toBeGreaterThan(0);

		// The current level reported by get_state must be in the available list
		const state = await client.getState();
		expect(levels).toContain(state.thinkingLevel);

		// cycle_thinking_level must only ever land on levels from get_available_thinking_levels
		const initialLevel = state.thinkingLevel;
		const cycled = await client.cycleThinkingLevel();
		if (cycled) {
			expect(levels).toContain(cycled.level);
			// distinct cycle step (unless only one level)
			if (levels.length > 1) {
				expect(cycled.level).not.toBe(initialLevel);
			}
		}
	}, 30000);

	test("should get available models", async () => {
		await client.start();

		const models = await client.getAvailableModels();
		expect(models.length).toBeGreaterThan(0);

		// All models should have required fields
		for (const model of models) {
			expect(model.provider).toBeDefined();
			expect(model.id).toBeDefined();
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(typeof model.reasoning).toBe("boolean");
		}
	}, 30000);

	test("should get session stats", async () => {
		await client.start();

		// Send a prompt first
		await client.promptAndWait("Hello");

		const stats = await client.getSessionStats();
		expect(stats.sessionFile).toBeDefined();
		expect(stats.sessionId).toBeDefined();
		expect(stats.userMessages).toBeGreaterThanOrEqual(1);
		expect(stats.assistantMessages).toBeGreaterThanOrEqual(1);
	}, 90000);

	test("should create new session", async () => {
		await client.start();

		// Send a prompt
		await client.promptAndWait("Hello");

		// Verify messages exist
		let state = await client.getState();
		expect(state.messageCount).toBeGreaterThan(0);

		// New session
		await client.newSession();

		// Verify messages cleared
		state = await client.getState();
		expect(state.messageCount).toBe(0);
	}, 90000);

	test("should export to HTML", async () => {
		await client.start();

		// Send a prompt first
		await client.promptAndWait("Hello");

		// Export
		const result = await client.exportHtml();
		expect(result.path).toBeDefined();
		expect(result.path.endsWith(".html")).toBe(true);
		expect(existsSync(result.path)).toBe(true);
	}, 90000);

	test("should get last assistant text", async () => {
		await client.start();

		// Initially null
		let text = await client.getLastAssistantText();
		expect(text).toBeUndefined();

		// Send prompt
		await client.promptAndWait("Reply with just: test123");

		// Should have text now
		text = await client.getLastAssistantText();
		expect(text).toContain("test123");
	}, 90000);

	test("should get session entries with since cursor", async () => {
		await client.start();

		await client.promptAndWait("Reply with just 'ok'");

		const { entries, leafId } = await client.getEntries();
		expect(entries.length).toBeGreaterThanOrEqual(2); // user + assistant
		for (const entry of entries) {
			expect(entry.id).toBeDefined();
		}
		expect(leafId).toBe(entries[entries.length - 1].id);

		// since cursor returns only entries strictly after the given id
		const since = await client.getEntries(entries[0].id);
		expect(since.entries.map((e) => e.id)).toEqual(entries.slice(1).map((e) => e.id));
		expect(since.leafId).toBe(leafId);

		// unknown since id is an error response
		await expect(client.getEntries("nonexistent-id")).rejects.toThrow("Entry not found");
	}, 90000);

	test("should get session tree", async () => {
		await client.start();

		await client.promptAndWait("Reply with just 'ok'");

		const { entries, leafId } = await client.getEntries();
		const { tree, leafId: treeLeafId } = await client.getTree();
		expect(treeLeafId).toBe(leafId);

		// Single root whose chain matches the entries
		expect(tree.length).toBe(1);
		const chainIds: string[] = [];
		let nodes = tree;
		while (nodes.length === 1) {
			chainIds.push(nodes[0].entry.id);
			nodes = nodes[0].children;
		}
		expect(nodes.length).toBe(0);
		expect(chainIds).toEqual(entries.map((e) => e.id));
	}, 90000);

	test("should retain pre-compaction entries in get_entries", async () => {
		await client.start();

		await client.promptAndWait("Reply with just 'ok'");
		const before = await client.getEntries();

		await client.compact();

		const after = await client.getEntries();
		// Append-only: pre-compaction entries are still there, in the same order
		expect(after.entries.slice(0, before.entries.length).map((e) => e.id)).toEqual(before.entries.map((e) => e.id));
		expect(after.entries.some((e) => e.type === "compaction")).toBe(true);
	}, 120000);

	test("should set and get session name", async () => {
		await client.start();

		// Initially undefined
		let state = await client.getState();
		expect(state.sessionName).toBeUndefined();

		// Send a prompt first - session files are only written after first assistant message
		await client.promptAndWait("Reply with just 'ok'");

		// Set name
		await client.setSessionName("my-test-session");

		// Verify via state
		state = await client.getState();
		expect(state.sessionName).toBe("my-test-session");

		// Wait for file writes
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Verify session_info entry in session file
		const sessionsPath = join(sessionDir, "sessions");
		const sessionDirs = readdirSync(sessionsPath);
		const cwdSessionDir = join(sessionsPath, sessionDirs[0]);
		const sessionFiles = readdirSync(cwdSessionDir).filter((f) => f.endsWith(".jsonl"));
		const sessionContent = readFileSync(join(cwdSessionDir, sessionFiles[0]), "utf8");
		const entries = sessionContent
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));

		const sessionInfoEntries = entries.filter((e: { type: string }) => e.type === "session_info");
		expect(sessionInfoEntries.length).toBe(1);
		expect(sessionInfoEntries[0].name).toBe("my-test-session");
	}, 60000);
});
