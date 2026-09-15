/**
 * Unit tests for AgentSession.forgetMessages (/forget).
 *
 * These tests do not call the model: the conversation is built by appending
 * entries directly to the session manager, and forgetMessages is pure
 * session-state manipulation.
 */

import { readdirSync } from "fs";
import { dirname } from "path";
import { describe, expect, it } from "vitest";
import { loadEntriesFromFile } from "../src/core/session-manager.ts";
import { assistantMsg, createTestSession, type TestSessionContext, userMsg } from "./utilities.ts";

function buildConversation(ctx: TestSessionContext): void {
	const sm = ctx.session.sessionManager;
	sm.appendMessage(userMsg("one"));
	sm.appendMessage(assistantMsg("A1"));
	sm.appendMessage(userMsg("two"));
	sm.appendMessage(assistantMsg("A2"));
	sm.appendMessage(userMsg("three"));
	sm.appendMessage(assistantMsg("A3"));
}

function contextTexts(session: TestSessionContext["session"]): string {
	return session.agent.state.messages
		.map((m) => {
			if ("content" in m) {
				const c = (m as { content: unknown }).content;
				return typeof c === "string" ? c : JSON.stringify(c);
			}
			return "";
		})
		.join("\n");
}

describe("AgentSession.forgetMessages", () => {
	it("soft (default): removes turns from context but keeps them in the file", async () => {
		const ctx = await createTestSession();
		try {
			const { session, sessionManager } = ctx;
			buildConversation(ctx);

			const result = await session.forgetMessages(2);

			expect(result.removedUserTurns).toBe(2);
			expect(result.removedMessages).toBe(4); // u2, a2, u3, a3
			expect(result.hard).toBe(false);
			expect(result.removedTokensApprox).toBeGreaterThan(0);

			// Model context is rebuilt to the retained path only
			const texts = contextTexts(session);
			expect(texts).toContain("one");
			expect(texts).toContain("A1");
			expect(texts).not.toContain("two");
			expect(texts).not.toContain("three");

			// Leaf is at the user-message boundary (a1, parent of u2)
			const entries = sessionManager.getEntries();
			const a1 = entries.find((e) => e.type === "message" && e.message.role === "assistant")!;
			expect(sessionManager.getLeafId()).toBe(a1.id);

			// File is unchanged: header + all 6 entries
			const fileEntries = loadEntriesFromFile(sessionManager.getSessionFile()!);
			expect(fileEntries).toHaveLength(7);

			// No branch summary was created
			expect(entries.filter((e) => e.type === "branch_summary")).toHaveLength(0);
		} finally {
			ctx.cleanup();
		}
	});

	it("counts tool-call traffic inside a turn (user + toolCall + toolResult + final answer)", async () => {
		const ctx = await createTestSession();
		try {
			const { session, sessionManager } = ctx;
			sessionManager.appendMessage(userMsg("setup"));
			sessionManager.appendMessage(assistantMsg("S1"));

			// A turn where the assistant calls a tool before answering
			sessionManager.appendMessage(userMsg("how many C's are in catacomb"));
			sessionManager.appendMessage({
				role: "assistant" as const,
				content: [
					{
						type: "toolCall" as const,
						id: "tc1",
						name: "bash",
						arguments: { command: "echo -n catacomb | grep -o c | wc -l" },
					},
				],
				api: "anthropic-messages" as const,
				provider: "anthropic",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse" as const,
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({
				role: "toolResult" as const,
				toolCallId: "tc1",
				toolName: "bash",
				content: [{ type: "text" as const, text: "2" }],
				isError: false,
				timestamp: Date.now(),
			});
			sessionManager.appendMessage(assistantMsg("two C's"));

			const result = await session.forgetMessages(1);

			expect(result.removedUserTurns).toBe(1);
			expect(result.removedMessages).toBe(4);
			expect(result.removedByRole).toEqual({ user: 1, assistant: 2, toolResult: 1 });

			// Context is rebuilt to the setup turn; no dangling tool traffic remains
			const texts = contextTexts(session);
			expect(texts).toContain("setup");
			expect(texts).not.toContain("catacomb");
			expect(texts).not.toContain("toolResult");
		} finally {
			ctx.cleanup();
		}
	});

	it("hard: rewrites the file to the retained path and writes no backup", async () => {
		const ctx = await createTestSession();
		try {
			const { session, sessionManager } = ctx;
			buildConversation(ctx);
			const file = sessionManager.getSessionFile()!;

			const result = await session.forgetMessages(2, { hard: true });

			expect(result.hard).toBe(true);

			// File now contains only header + u1 + a1
			const fileEntries = loadEntriesFromFile(file);
			expect(fileEntries).toHaveLength(3);
			const raw = fileEntries.map((e) => JSON.stringify(e)).join("\n");
			expect(raw).toContain("one");
			expect(raw).toContain("A1");
			expect(raw).not.toContain("two");
			expect(raw).not.toContain("three");

			// Model context matches the retained path
			const texts = contextTexts(session);
			expect(texts).toContain("one");
			expect(texts).not.toContain("two");

			// No backup file was written next to the session
			const files = readdirSync(dirname(file));
			expect(files.filter((f) => f.includes("bak") || f.includes("backup"))).toHaveLength(0);
		} finally {
			ctx.cleanup();
		}
	});

	it("forgetting all user turns empties the context and (hard) the file", async () => {
		const ctx = await createTestSession();
		try {
			const { session, sessionManager } = ctx;
			buildConversation(ctx);
			const file = sessionManager.getSessionFile()!;

			const result = await session.forgetMessages(3, { hard: true });

			expect(result.targetId).toBeNull();
			expect(sessionManager.getLeafId()).toBeNull();
			expect(session.agent.state.messages).toHaveLength(0);
			expect(loadEntriesFromFile(file)).toHaveLength(1); // header only
		} finally {
			ctx.cleanup();
		}
	});

	it("continues correctly after a soft forget", async () => {
		const ctx = await createTestSession();
		try {
			const { session, sessionManager } = ctx;
			buildConversation(ctx);

			await session.forgetMessages(2);

			// New messages append to the retained path
			const u4 = sessionManager.appendMessage(userMsg("four"));
			const entries = sessionManager.getEntries();
			const a1 = entries.find((e) => e.type === "message" && e.message.role === "assistant")!;
			expect(sessionManager.getEntry(u4)!.parentId).toBe(a1.id);
		} finally {
			ctx.cleanup();
		}
	});

	it("rejects counts beyond the number of user turns", async () => {
		const ctx = await createTestSession();
		try {
			const { session } = ctx;
			buildConversation(ctx);
			await expect(session.forgetMessages(4)).rejects.toThrow("cannot forget 4");
		} finally {
			ctx.cleanup();
		}
	});

	it("rejects invalid counts", async () => {
		const ctx = await createTestSession();
		try {
			const { session } = ctx;
			buildConversation(ctx);
			await expect(session.forgetMessages(0)).rejects.toThrow("positive integer");
			await expect(session.forgetMessages(1.5)).rejects.toThrow("positive integer");
		} finally {
			ctx.cleanup();
		}
	});
});
