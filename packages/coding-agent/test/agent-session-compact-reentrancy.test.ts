/**
 * Manual-compaction re-entry guard.
 *
 * `AgentSession.compact()` overwrites `_compactionAbortController` and
 * runs an LLM summary call against `sessionManager.appendCompaction()`.
 * `await this.abort()` only cancels agent work, not compaction, so a
 * concurrent re-entry would orphan the prior controller and race two
 * writers on session state. Guard rejects re-entry up front.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

// Hold the LLM-summary step open so the reentry test can race a second
// compact() against the first while it's still in flight.
let resolveCompact:
	| ((value: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown }) => void)
	| null = null;

vi.mock("../src/core/compaction/index.js", () => ({
	calculateContextTokens: () => 0,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	compact: () =>
		new Promise((resolve) => {
			resolveCompact = resolve as typeof resolveCompact;
		}),
	estimateContextTokens: () => ({ tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null }),
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompaction: () => ({ dummy: true }),
	shouldCompact: () => false,
}));

describe("AgentSession.compact() re-entry", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-compact-reentry-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		resolveCompact = null;
	});

	afterEach(() => {
		// Release the in-flight compaction so vitest doesn't hang on the
		// dangling promise from the first compact() call in each test.
		resolveCompact?.({
			summary: "released",
			firstKeptEntryId: "entry-1",
			tokensBefore: 0,
			details: {},
		});
		session.dispose();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("rejects a second compact() while the first is in flight", async () => {
		const first = session.compact();
		// compact() awaits abort() before assigning _compactionAbortController,
		// so isCompacting flips a few microtasks in. Poll until it does.
		await vi.waitFor(() => expect(session.isCompacting).toBe(true), { timeout: 1000, interval: 5 });

		await expect(session.compact()).rejects.toThrow(/Compaction already in progress/);

		// First call still holds the controller; afterEach releases it.
		void first;
	});
});
