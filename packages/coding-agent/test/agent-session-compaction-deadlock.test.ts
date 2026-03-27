/**
 * Regression test: compact() called from inside a tool must not deadlock.
 *
 * Before the fix, AgentSession.compact() called `await this.abort()` which
 * called `waitForIdle()`. But `waitForIdle()` waits for the agent loop to
 * finish, and the agent loop is blocked waiting for the tool that called
 * compact() — circular deadlock.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./test-harness.js";

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(message)), ms);
		void promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

describe("AgentSession compact deadlock regression", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("should not deadlock when compact() is called during tool execution", async () => {
		let resolveToolStarted!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			resolveToolStarted = resolve;
		});

		let resolveCompactionFinished!: () => void;
		const compactionFinished = new Promise<void>((resolve) => {
			resolveCompactionFinished = resolve;
		});

		let compactedDuringTool = false;
		let session = null as Harness["session"] | null;

		const compactTool: AgentTool = {
			name: "compact_self",
			description: "Trigger session compaction",
			label: "compact_self",
			parameters: Type.Object({}),
			execute: async () => {
				if (!session) {
					throw new Error("Session not initialized");
				}

				// Inject a fake extension runner that provides compaction content
				// so we don't need a real LLM call for the summarization step.
				const sessionWithRunner = session as unknown as {
					_extensionRunner?: {
						hasHandlers: (eventType: string) => boolean;
						emit: (event: {
							type: string;
							preparation?: { firstKeptEntryId: string; tokensBefore: number };
						}) => Promise<unknown>;
					};
				};
				sessionWithRunner._extensionRunner = {
					hasHandlers: (eventType: string) => eventType === "session_before_compact",
					emit: async (event: {
						type: string;
						preparation?: { firstKeptEntryId: string; tokensBefore: number };
					}) => {
						if (event.type === "session_before_compact" && event.preparation) {
							return {
								compaction: {
									summary: "summary from test extension",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						}
						return undefined;
					},
				};

				resolveToolStarted();
				await session.compact();
				compactedDuringTool = true;
				resolveCompactionFinished();

				return {
					content: [{ type: "text" as const, text: "tool finished" }],
					details: {},
				};
			},
		};

		harness = createHarness({
			responses: [
				"first response",
				"second response",
				{
					text: "calling compact tool",
					toolCalls: [{ id: "compact-call-1", name: "compact_self", args: {} }],
				},
				"done after compaction",
			],
			tools: [compactTool],
			baseToolsOverride: { compact_self: compactTool },
			settings: {
				compaction: {
					keepRecentTokens: 1,
				},
			},
		});
		session = harness.session;

		// Build up enough conversation history for compaction to work
		await session.prompt("first prompt");
		await session.agent.waitForIdle();

		await session.prompt("second prompt");
		await session.agent.waitForIdle();

		// This prompt triggers the tool call which calls compact() from inside execute()
		const promptPromise = session.prompt("trigger compaction tool");

		// All of these should resolve quickly. If any times out, the deadlock is present.
		await expect(withTimeout(toolStarted, 5000, "tool execution did not start")).resolves.toBeUndefined();
		await expect(
			withTimeout(compactionFinished, 5000, "compact() deadlocked during tool execution"),
		).resolves.toBeUndefined();
		await expect(withTimeout(promptPromise, 5000, "prompt did not settle after compaction")).resolves.toBeUndefined();
		await expect(
			withTimeout(session.agent.waitForIdle(), 5000, "agent did not become idle"),
		).resolves.toBeUndefined();

		expect(compactedDuringTool).toBe(true);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});
});
