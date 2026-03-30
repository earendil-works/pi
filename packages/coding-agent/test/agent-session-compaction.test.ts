/**
 * E2E tests for AgentSession compaction behavior.
 *
 * These tests use real LLM calls (no mocking) to verify:
 * - Manual compaction works correctly
 * - Session persistence during compaction
 * - Compaction entry is saved to session file
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { codingTools } from "../src/core/tools/index.js";
import { API_KEY, createTestResourceLoader } from "./utilities.js";

describe.skipIf(!API_KEY)("AgentSession compaction e2e", () => {
	let session: AgentSession;
	let tempDir: string;
	let sessionManager: SessionManager;
	let events: AgentSessionEvent[];

	beforeEach(() => {
		// Create temp directory for session files
		tempDir = join(tmpdir(), `pi-compaction-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		// Track events
		events = [];
	});

	afterEach(async () => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession(inMemory = false) {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => API_KEY,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant. Be concise.",
				tools: codingTools,
			},
		});

		sessionManager = inMemory ? SessionManager.inMemory() : SessionManager.create(tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		// Use minimal keepRecentTokens so small test conversations have something to summarize
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		// Subscribe to track events
		session.subscribe((event) => {
			events.push(event);
		});

		return session;
	}

	it("should trigger manual compaction via compact()", async () => {
		createSession();

		// Send a few prompts to build up history
		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		// Manually compact
		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.tokensBefore).toBeGreaterThan(0);

		// Verify messages were compacted (should have summary + recent)
		const messages = session.messages;
		expect(messages.length).toBeGreaterThan(0);

		// First message should be the summary (a user message with summary content)
		const firstMsg = messages[0];
		expect(firstMsg.role).toBe("compactionSummary");
	}, 120000);

	it("should maintain valid session state after compaction", async () => {
		createSession();

		// Build up history
		await session.prompt("What is the capital of France? One word answer.");
		await session.agent.waitForIdle();

		await session.prompt("What is the capital of Germany? One word answer.");
		await session.agent.waitForIdle();

		// Compact
		await session.compact();

		// Session should still be usable
		await session.prompt("What is the capital of Italy? One word answer.");
		await session.agent.waitForIdle();

		// Should have messages after compaction
		expect(session.messages.length).toBeGreaterThan(0);

		// The agent should have responded
		const assistantMessages = session.messages.filter((m) => m.role === "assistant");
		expect(assistantMessages.length).toBeGreaterThan(0);
	}, 180000);

	it("should persist compaction to session file", async () => {
		createSession();

		await session.prompt("Say hello");
		await session.agent.waitForIdle();

		await session.prompt("Say goodbye");
		await session.agent.waitForIdle();

		// Compact
		await session.compact();

		// Load entries from session manager
		const entries = sessionManager.getEntries();

		// Should have a compaction entry
		const compactionEntries = entries.filter((e) => e.type === "compaction");
		expect(compactionEntries.length).toBe(1);

		const compaction = compactionEntries[0];
		expect(compaction.type).toBe("compaction");
		if (compaction.type === "compaction") {
			expect(compaction.summary.length).toBeGreaterThan(0);
			expect(typeof compaction.firstKeptEntryId).toBe("string");
			expect(compaction.tokensBefore).toBeGreaterThan(0);
		}
	}, 120000);

	it("should work with --no-session mode (in-memory only)", async () => {
		createSession(true); // in-memory mode

		// Send prompts
		await session.prompt("What is 2+2? Reply with just the number.");
		await session.agent.waitForIdle();

		await session.prompt("What is 3+3? Reply with just the number.");
		await session.agent.waitForIdle();

		// Compact should work even without file persistence
		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);

		// In-memory entries should have the compaction
		const entries = sessionManager.getEntries();
		const compactionEntries = entries.filter((e) => e.type === "compaction");
		expect(compactionEntries.length).toBe(1);
	}, 120000);

	it("should emit compaction events during manual compaction", async () => {
		createSession();

		// Build some history
		await session.prompt("Say hello");
		await session.agent.waitForIdle();

		// Manually trigger compaction and check events
		await session.compact();

		const compactionEvents = events.filter((e) => e.type === "compaction_start" || e.type === "compaction_end");
		expect(compactionEvents).toHaveLength(2);
		expect(compactionEvents[0]).toEqual({ type: "compaction_start", reason: "manual" });
		expect(compactionEvents[1]).toMatchObject({
			type: "compaction_end",
			reason: "manual",
			aborted: false,
			willRetry: false,
		});

		// Regular events should have been emitted
		const messageEndEvents = events.filter((e) => e.type === "message_end");
		expect(messageEndEvents.length).toBeGreaterThan(0);
	}, 120000);
});
