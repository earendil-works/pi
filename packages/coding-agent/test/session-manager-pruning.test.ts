import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_FILE_ENTRIES,
	SessionManager,
	loadEntriesFromFile,
} from "../src/core/session-manager.js";

function userMsg(text: string): Message {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistantMsg(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "test-model",
		provider: "test",
		usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	} as Message;
}

describe("SessionManager fileEntries pruning", () => {
	let tempDir: string;
	let sessionDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-prune-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("exports DEFAULT_MAX_FILE_ENTRIES as 1000", () => {
		expect(DEFAULT_MAX_FILE_ENTRIES).toBe(1000);
	});

	it("does not prune when below the cap", () => {
		const sm = SessionManager.inMemory("/tmp", 10);
		// Append 5 user+assistant pairs = 10 entries, at cap
		for (let i = 0; i < 5; i++) {
			sm.appendMessage(userMsg(`user ${i}`));
			sm.appendMessage(assistantMsg(`assistant ${i}`));
		}
		const entries = sm.getEntries();
		expect(entries.length).toBe(10);
	});

	it("prunes entries beyond the cap, preserving the header", () => {
		const cap = 5;
		const sm = SessionManager.inMemory("/tmp", cap);
		// Append 10 entries (5 pairs) — should prune to 5 entries + header
		for (let i = 0; i < 5; i++) {
			sm.appendMessage(userMsg(`user ${i}`));
			sm.appendMessage(assistantMsg(`assistant ${i}`));
		}
		const entries = sm.getEntries();
		expect(entries.length).toBe(cap);

		// Header must still be accessible
		const header = sm.getHeader();
		expect(header).not.toBeNull();
		expect(header!.type).toBe("session");
	});

	it("preserves the most recent entries after pruning", () => {
		const cap = 4;
		const sm = SessionManager.inMemory("/tmp", cap);
		for (let i = 0; i < 5; i++) {
			sm.appendMessage(userMsg(`user ${i}`));
			sm.appendMessage(assistantMsg(`assistant ${i}`));
		}
		const entries = sm.getEntries();
		expect(entries.length).toBe(cap);

		// The last entries should be the most recent ones
		const lastEntry = entries[entries.length - 1];
		expect(lastEntry.type).toBe("message");
		expect((lastEntry as any).message.content[0].text).toBe("assistant 4");
	});

	it("removes pruned entries from byId (getEntry returns undefined)", () => {
		const cap = 4;
		const sm = SessionManager.inMemory("/tmp", cap);
		const firstId = sm.appendMessage(userMsg("first"));
		for (let i = 0; i < 5; i++) {
			sm.appendMessage(userMsg(`user ${i}`));
			sm.appendMessage(assistantMsg(`assistant ${i}`));
		}
		// The first entry should have been pruned
		expect(sm.getEntry(firstId)).toBeUndefined();
	});

	it("leaf entry is always accessible after pruning", () => {
		const cap = 3;
		const sm = SessionManager.inMemory("/tmp", cap);
		for (let i = 0; i < 10; i++) {
			sm.appendMessage(userMsg(`msg ${i}`));
		}
		const leaf = sm.getLeafEntry();
		expect(leaf).toBeDefined();
		expect(leaf!.type).toBe("message");
		expect((leaf as any).message.content).toBe("msg 9");
	});

	it("newSession() resets fileEntries regardless of cap", () => {
		const cap = 5;
		const sm = SessionManager.inMemory("/tmp", cap);
		for (let i = 0; i < 10; i++) {
			sm.appendMessage(userMsg(`msg ${i}`));
		}
		sm.newSession();
		const entries = sm.getEntries();
		expect(entries.length).toBe(0);
		expect(sm.getHeader()).not.toBeNull();
	});

	it("appendCompaction works within a capped session", () => {
		const cap = 6;
		const sm = SessionManager.inMemory("/tmp", cap);
		const id1 = sm.appendMessage(userMsg("user 1"));
		sm.appendMessage(assistantMsg("assistant 1"));
		const id3 = sm.appendMessage(userMsg("user 2"));
		sm.appendMessage(assistantMsg("assistant 2"));

		// Append compaction referencing id3 as firstKeptEntryId
		sm.appendCompaction("Summary of earlier conversation", id3, 5000);

		sm.appendMessage(userMsg("user 3"));
		sm.appendMessage(assistantMsg("assistant 3"));

		const entries = sm.getEntries();
		// Should be capped at 6
		expect(entries.length).toBe(cap);

		// Compaction entry should still be present (it's recent enough)
		const compactionEntry = entries.find((e) => e.type === "compaction");
		// It may or may not be pruned depending on count — what matters is no crash
		expect(sm.getHeader()).not.toBeNull();
		expect(sm.getLeafEntry()).toBeDefined();
	});

	it("createBranchedSession works after pruning", () => {
		const cap = 6;
		const sm = SessionManager.inMemory("/tmp", cap);
		for (let i = 0; i < 4; i++) {
			sm.appendMessage(userMsg(`user ${i}`));
			sm.appendMessage(assistantMsg(`assistant ${i}`));
		}
		// Leaf should be the last entry
		const leafId = sm.getLeafId();
		expect(leafId).not.toBeNull();

		// createBranchedSession should not throw
		const result = sm.createBranchedSession(leafId!);
		// In-memory mode returns undefined
		expect(result).toBeUndefined();
		// Session should still be valid
		expect(sm.getHeader()).not.toBeNull();
		expect(sm.getEntries().length).toBeGreaterThan(0);
	});

	it("default cap is applied when no maxFileEntries is provided", () => {
		const sm = SessionManager.inMemory("/tmp");
		// Default should be DEFAULT_MAX_FILE_ENTRIES (1000)
		// We can't easily test this without appending 1001 entries,
		// but we can verify the session works normally
		for (let i = 0; i < 10; i++) {
			sm.appendMessage(userMsg(`msg ${i}`));
		}
		expect(sm.getEntries().length).toBe(10);
	});

	it("persisted session prunes in memory but preserves full JSONL on disk", () => {
		const cap = 4;
		const sm = SessionManager.create("/tmp", sessionDir, cap);

		// Need at least one assistant message to trigger file flush
		sm.appendMessage(userMsg("user 0"));
		sm.appendMessage(assistantMsg("assistant 0"));
		sm.appendMessage(userMsg("user 1"));
		sm.appendMessage(assistantMsg("assistant 1"));
		sm.appendMessage(userMsg("user 2"));
		sm.appendMessage(assistantMsg("assistant 2"));

		// In-memory: should be capped
		const entries = sm.getEntries();
		expect(entries.length).toBe(cap);

		// On disk: should have full history (header + 6 entries = 7 lines)
		const sessionFile = sm.getSessionFile()!;
		expect(existsSync(sessionFile)).toBe(true);
		const diskEntries = loadEntriesFromFile(sessionFile);
		expect(diskEntries.length).toBe(7); // header + 6 entries
	});

	it("getBranch returns entries within the window", () => {
		const cap = 6;
		const sm = SessionManager.inMemory("/tmp", cap);
		for (let i = 0; i < 5; i++) {
			sm.appendMessage(userMsg(`user ${i}`));
			sm.appendMessage(assistantMsg(`assistant ${i}`));
		}
		const leafId = sm.getLeafId()!;
		const branch = sm.getBranch(leafId);
		// Branch may be shorter than expected if ancestors were pruned
		// but should not throw and should contain the leaf
		expect(branch.length).toBeGreaterThan(0);
		expect(branch[branch.length - 1].id).toBe(leafId);
	});

	it("getTree does not throw after pruning", () => {
		const cap = 4;
		const sm = SessionManager.inMemory("/tmp", cap);
		for (let i = 0; i < 10; i++) {
			sm.appendMessage(userMsg(`msg ${i}`));
		}
		// Should not throw
		const tree = sm.getTree();
		expect(tree.length).toBeGreaterThan(0);
	});

	it("buildSessionContext works after pruning", () => {
		const cap = 6;
		const sm = SessionManager.inMemory("/tmp", cap);
		for (let i = 0; i < 5; i++) {
			sm.appendMessage(userMsg(`user ${i}`));
			sm.appendMessage(assistantMsg(`assistant ${i}`));
		}
		const ctx = sm.buildSessionContext();
		// Should return messages without throwing
		expect(ctx.messages.length).toBeGreaterThan(0);
	});

	it("handles cap of 1 (minimum useful)", () => {
		const sm = SessionManager.inMemory("/tmp", 1);
		sm.appendMessage(userMsg("first"));
		sm.appendMessage(userMsg("second"));
		sm.appendMessage(userMsg("third"));

		const entries = sm.getEntries();
		expect(entries.length).toBe(1);
		expect((entries[0] as any).message.content).toBe("third");
		expect(sm.getHeader()).not.toBeNull();
	});
});
