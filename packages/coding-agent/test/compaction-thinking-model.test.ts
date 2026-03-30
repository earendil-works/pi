/**
 * Test for compaction with thinking models.
 *
 * Tests both:
 * - Claude via Antigravity (google-gemini-cli API)
 * - Claude via real Anthropic API (anthropic-messages API)
 *
 * Reproduces issue where compact fails when maxTokens < thinkingBudget.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getModel, type Model } from "@mariozechner/pi-ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { codingTools } from "../src/core/tools/index.js";
import {
	API_KEY,
	createTestResourceLoader,
	getRealAuthStorage,
	hasAuthForProvider,
	resolveApiKey,
} from "./utilities.js";

// Check for auth
const HAS_ANTIGRAVITY_AUTH = hasAuthForProvider("google-antigravity");
const HAS_ANTHROPIC_AUTH = !!API_KEY;

describe.skipIf(!HAS_ANTIGRAVITY_AUTH)("Compaction with thinking models (Antigravity)", () => {
	let session: AgentSession;
	let tempDir: string;
	let apiKey: string;

	beforeAll(async () => {
		const key = await resolveApiKey("google-antigravity");
		if (!key) throw new Error("Failed to resolve google-antigravity API key");
		apiKey = key;
	});

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-thinking-compaction-test-${Date.now()}`);
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

	function createSession(
		modelId: "claude-opus-4-5-thinking" | "claude-sonnet-4-5",
		thinkingLevel: ThinkingLevel = "high",
	) {
		const model = getModel("google-antigravity", modelId);
		if (!model) {
			throw new Error(`Model not found: google-antigravity/${modelId}`);
		}

		const agent = new Agent({
			getApiKey: () => apiKey,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant. Be concise.",
				tools: codingTools,
				thinkingLevel,
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		// Use minimal keepRecentTokens so small test conversations have something to summarize
		// settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });

		const authStorage = getRealAuthStorage();
		const modelRegistry = ModelRegistry.create(authStorage);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		session.subscribe(() => {});

		return session;
	}

	it("should compact successfully with claude-opus-4-5-thinking and thinking level high", async () => {
		createSession("claude-opus-4-5-thinking", "high");

		// Send a simple prompt
		await session.prompt("Write down the first 10 prime numbers.");
		await session.agent.waitForIdle();

		// Verify we got a response
		const messages = session.messages;
		expect(messages.length).toBeGreaterThan(0);

		const assistantMessages = messages.filter((m) => m.role === "assistant");
		expect(assistantMessages.length).toBeGreaterThan(0);

		// Now try to compact - this should not throw
		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.tokensBefore).toBeGreaterThan(0);

		// Verify session is still usable after compaction
		const messagesAfterCompact = session.messages;
		expect(messagesAfterCompact.length).toBeGreaterThan(0);
		expect(messagesAfterCompact[0].role).toBe("compactionSummary");
	}, 180000);

	it("should compact successfully with claude-sonnet-4-5 (non-thinking) for comparison", async () => {
		createSession("claude-sonnet-4-5", "off");

		await session.prompt("Write down the first 10 prime numbers.");
		await session.agent.waitForIdle();

		const messages = session.messages;
		expect(messages.length).toBeGreaterThan(0);

		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);
	}, 180000);
});

// ============================================================================
// Real Anthropic API tests (for comparison)
// ============================================================================

describe.skipIf(!HAS_ANTHROPIC_AUTH)("Compaction with thinking models (Anthropic)", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-thinking-compaction-anthropic-test-${Date.now()}`);
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

	function createSession(model: Model<any>, thinkingLevel: ThinkingLevel = "high") {
		const agent = new Agent({
			getApiKey: () => API_KEY,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant. Be concise.",
				tools: codingTools,
				thinkingLevel,
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);

		const authStorage = getRealAuthStorage();
		const modelRegistry = ModelRegistry.create(authStorage);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		session.subscribe(() => {});

		return session;
	}

	it("should compact successfully with claude-sonnet-4-5 and thinking level high", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		createSession(model, "high");

		// Send a simple prompt
		await session.prompt("Write down the first 10 prime numbers.");
		await session.agent.waitForIdle();

		// Verify we got a response
		const messages = session.messages;
		expect(messages.length).toBeGreaterThan(0);

		const assistantMessages = messages.filter((m) => m.role === "assistant");
		expect(assistantMessages.length).toBeGreaterThan(0);

		// Now try to compact - this should not throw
		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.tokensBefore).toBeGreaterThan(0);

		// Verify session is still usable after compaction
		const messagesAfterCompact = session.messages;
		expect(messagesAfterCompact.length).toBeGreaterThan(0);
		expect(messagesAfterCompact[0].role).toBe("compactionSummary");
	}, 180000);
});
