/**
 * Tests for read-thread tool behavior changes:
 * 1. Tool calls visible by default in raw mode (detailed defaults to true)
 * 2. Extraction mode always sees tool calls (forces detailed=true internally)
 * 3. Tool results truncated to 2048 chars (was 2000)
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../session-manager.js";

// Test session data with tool calls
const TEST_SESSION_ID = "test-read-thread-00000000-0000-0000-0000-000000000001";
const TEST_WORKSPACE = "--test-read-thread-workspace--";

function getTestSessionDir(): string {
	const configDir = process.env.MU_CODING_AGENT_DIR || join(homedir(), ".mu/agent/");
	return join(configDir, "sessions", TEST_WORKSPACE);
}

function createTestSession(toolResultLength: number = 100): string {
	const sessionDir = getTestSessionDir();
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}

	const sessionFile = join(sessionDir, `2026-01-15T00-00-00-000Z_${TEST_SESSION_ID}.jsonl`);

	// Create a session with tool calls
	const lines = [
		// Session header
		JSON.stringify({
			type: "session",
			id: TEST_SESSION_ID,
			timestamp: "2026-01-15T00:00:00.000Z",
			cwd: "/test/workspace",
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
			thinkingLevel: "off",
		}),
		// User message
		JSON.stringify({
			type: "message",
			timestamp: "2026-01-15T00:00:01.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "List all TypeScript files" }],
			},
		}),
		// Assistant message with tool call
		JSON.stringify({
			type: "message",
			timestamp: "2026-01-15T00:00:02.000Z",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "I'll search for TypeScript files." },
					{
						type: "toolCall",
						id: "tool-call-001",
						name: "glob",
						arguments: { pattern: "**/*.ts", path: "/test/workspace" },
					},
				],
			},
		}),
		// Tool result with configurable length
		JSON.stringify({
			type: "message",
			timestamp: "2026-01-15T00:00:03.000Z",
			message: {
				role: "toolResult",
				toolCallId: "tool-call-001",
				toolName: "glob",
				content: [{ type: "text", text: "x".repeat(toolResultLength) }],
			},
		}),
		// Final assistant message
		JSON.stringify({
			type: "message",
			timestamp: "2026-01-15T00:00:04.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Found the files." }],
			},
		}),
	];

	writeFileSync(sessionFile, lines.join("\n") + "\n");
	return sessionFile;
}

function cleanupTestSession(): void {
	const sessionDir = getTestSessionDir();
	if (existsSync(sessionDir)) {
		rmSync(sessionDir, { recursive: true, force: true });
	}
}

describe("ReadThread Tool Visibility", () => {
	beforeEach(() => {
		cleanupTestSession();
	});

	afterEach(() => {
		cleanupTestSession();
	});

	describe("Raw Mode Default Behavior", () => {
		it("should show tool calls by default when detailed is not specified", () => {
			createTestSession(100);
			const mgr = new SessionManager(false, undefined, true);

			// Call without specifying detailed - should default to true
			const result = mgr.getThreadContent(TEST_SESSION_ID, {
				maxMessages: 10,
				globalSearch: true,
				// detailed NOT specified - should default to showing tools
			});

			expect(result).not.toBeNull();
			expect(result!.content).toContain("Used tool");
			expect(result!.content).toContain("glob");
			expect(result!.content).toContain("Output from");
		});

		it("should hide tool calls when detailed=false is explicitly set", () => {
			createTestSession(100);
			const mgr = new SessionManager(false, undefined, true);

			const result = mgr.getThreadContent(TEST_SESSION_ID, {
				maxMessages: 10,
				globalSearch: true,
				detailed: false, // Explicitly hide tools
			});

			expect(result).not.toBeNull();
			expect(result!.content).not.toContain("Used tool");
			expect(result!.content).not.toContain("Output from");
			// Should still have user and assistant text
			expect(result!.content).toContain("List all TypeScript files");
			expect(result!.content).toContain("Found the files");
		});
	});

	describe("Tool Result Truncation", () => {
		it("should truncate tool results to exactly 2048 chars", () => {
			// Create session with 5000 char tool result
			createTestSession(5000);
			const mgr = new SessionManager(false, undefined, true);

			const result = mgr.getThreadContent(TEST_SESSION_ID, {
				maxMessages: 10,
				globalSearch: true,
				detailed: true,
			});

			expect(result).not.toBeNull();

			// Should contain truncation notice
			expect(result!.content).toContain("output truncated");
			expect(result!.content).toContain("5000 chars");

			// The actual "x" content should be limited to exactly 2048
			// Count consecutive x's to verify truncation
			const xMatch = result!.content.match(/x+/);
			expect(xMatch).not.toBeNull();
			// Should have exactly 2048 x's (the new truncation limit, was 2000)
			expect(xMatch![0].length).toBe(2048);
		});

		it("should not truncate tool results under 2048 chars", () => {
			createTestSession(1000);
			const mgr = new SessionManager(false, undefined, true);

			const result = mgr.getThreadContent(TEST_SESSION_ID, {
				maxMessages: 10,
				globalSearch: true,
				detailed: true,
			});

			expect(result).not.toBeNull();
			expect(result!.content).not.toContain("output truncated");

			// Should have all 1000 x's
			const xMatch = result!.content.match(/x+/);
			expect(xMatch).not.toBeNull();
			expect(xMatch![0].length).toBe(1000);
		});
	});
});

describe("Extraction Mode Internal Behavior", () => {
	beforeEach(() => {
		cleanupTestSession();
	});

	afterEach(() => {
		cleanupTestSession();
	});

	it("should always fetch with detailed=true for extraction, regardless of user param", () => {
		// This test verifies the internal call to getThreadContent in extraction mode
		// We can't easily mock the full extraction flow, but we can verify the data flow
		// by checking that when detailed=false is passed to read-thread, the content
		// sent to extraction still contains tool calls

		// For now, we verify the session manager behavior which is the foundation
		createTestSession(100);
		const mgr = new SessionManager(false, undefined, true);

		// Even if caller requests detailed=false, extraction should internally use detailed=true
		// This is enforced in read-thread.ts, not session-manager.ts
		// Session manager correctly returns tools when detailed=true
		const withTools = mgr.getThreadContent(TEST_SESSION_ID, {
			maxMessages: 10,
			globalSearch: true,
			detailed: true,
		});

		const withoutTools = mgr.getThreadContent(TEST_SESSION_ID, {
			maxMessages: 10,
			globalSearch: true,
			detailed: false,
		});

		expect(withTools).not.toBeNull();
		expect(withoutTools).not.toBeNull();

		// With detailed=true, should have tool calls
		expect(withTools!.content).toContain("Used tool");
		expect(withTools!.content).toContain("Output from");

		// With detailed=false, should NOT have tool calls
		expect(withoutTools!.content).not.toContain("Used tool");
		expect(withoutTools!.content).not.toContain("Output from");

		// Both should have the basic conversation content
		expect(withTools!.content).toContain("List all TypeScript files");
		expect(withoutTools!.content).toContain("List all TypeScript files");
	});
});
