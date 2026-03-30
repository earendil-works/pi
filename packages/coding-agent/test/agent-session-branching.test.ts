/**
 * Tests for AgentSession forking behavior.
 *
 * These tests verify:
 * - Forking from a single message works
 * - Forking in --no-session mode (in-memory only)
 * - getUserMessagesForForking returns correct entries
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { codingTools } from "../src/core/tools/index.js";
import { API_KEY, createTestResourceLoader } from "./utilities.js";

describe.skipIf(!API_KEY)("AgentSession forking", () => {
	let session: AgentSession;
	let tempDir: string;
	let sessionManager: SessionManager;

	beforeEach(() => {
		// Create temp directory for session files
		tempDir = join(tmpdir(), `pi-branching-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession(noSession: boolean = false) {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => API_KEY,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant. Be extremely concise, reply with just a few words.",
				tools: codingTools,
			},
		});

		sessionManager = noSession ? SessionManager.inMemory() : SessionManager.create(tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		// Must subscribe to enable session persistence
		session.subscribe(() => {});

		return session;
	}

	it("should allow forking from single message", async () => {
		createSession();

		// Send one message
		await session.prompt("Say hello");
		await session.agent.waitForIdle();

		// Should have exactly 1 user message available for forking
		const userMessages = session.getUserMessagesForForking();
		expect(userMessages.length).toBe(1);
		expect(userMessages[0].text).toBe("Say hello");

		// Fork from the first message
		const result = await session.fork(userMessages[0].entryId);
		expect(result.selectedText).toBe("Say hello");
		expect(result.cancelled).toBe(false);

		// After forking, conversation should be empty (forked before the first message)
		expect(session.messages.length).toBe(0);

		// Session file path should be set, but file is created lazily after first assistant message
		expect(session.sessionFile).not.toBeNull();
		expect(existsSync(session.sessionFile!)).toBe(false);
	});

	it("should support in-memory forking in --no-session mode", async () => {
		createSession(true);

		// Verify sessions are disabled
		expect(session.sessionFile).toBeUndefined();

		// Send one message
		await session.prompt("Say hi");
		await session.agent.waitForIdle();

		// Should have 1 user message
		const userMessages = session.getUserMessagesForForking();
		expect(userMessages.length).toBe(1);

		// Verify we have messages before forking
		expect(session.messages.length).toBeGreaterThan(0);

		// Fork from the first message
		const result = await session.fork(userMessages[0].entryId);
		expect(result.selectedText).toBe("Say hi");
		expect(result.cancelled).toBe(false);

		// After forking, conversation should be empty
		expect(session.messages.length).toBe(0);

		// Session file should still be undefined (no file created)
		expect(session.sessionFile).toBeUndefined();
	});

	it("should fork from middle of conversation", async () => {
		createSession();

		// Send multiple messages
		await session.prompt("Say one");
		await session.agent.waitForIdle();

		await session.prompt("Say two");
		await session.agent.waitForIdle();

		await session.prompt("Say three");
		await session.agent.waitForIdle();

		// Should have 3 user messages
		const userMessages = session.getUserMessagesForForking();
		expect(userMessages.length).toBe(3);

		// Fork from second message (keeps first message + response)
		const secondMessage = userMessages[1];
		const result = await session.fork(secondMessage.entryId);
		expect(result.selectedText).toBe("Say two");

		// After forking, should have first user message + assistant response
		expect(session.messages.length).toBe(2);
		expect(session.messages[0].role).toBe("user");
		expect(session.messages[1].role).toBe("assistant");
	});
});
