/**
 * Tests for Session migration (Slice 1)
 *
 * These tests verify:
 * - v1 sessions (no id/parentId) are migrated to v2
 * - Migration preserves entry order
 * - Migration is idempotent
 * - Parent chain is correctly built during migration
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionManager } from "../../src/session-manager.js";

describe("SessionManager migration", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mu-session-migration-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("v1 to v2 migration", () => {
		it("migrates v1 session (no id/parentId) to v2", () => {
			const sessionFile = join(dir, "session.jsonl");

			// Write v1 session file (no id/parentId)
			const v1Content = [
				JSON.stringify({
					type: "session",
					id: "test-session-id",
					timestamp: new Date().toISOString(),
					cwd: dir,
					provider: "test",
					modelId: "test-model",
					thinkingLevel: "off",
				}),
				JSON.stringify({
					type: "message",
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "hello" },
				}),
				JSON.stringify({
					type: "message",
					timestamp: new Date().toISOString(),
					message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
				}),
				JSON.stringify({
					type: "message",
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "bye" },
				}),
			].join("\n");
			writeFileSync(sessionFile, v1Content + "\n");

			// Load session - should trigger migration
			const session = new SessionManager(false, sessionFile, false, dir);

			// Verify migration happened
			const leafId = session.getLeafId();
			expect(leafId).toBeDefined();
			expect(leafId).toMatch(/^[0-9a-f]{8}$/);

			// Verify parent chain
			const entries = session.getEntries();
			expect(entries.length).toBe(3);

			// First entry should have parentId null
			expect(entries[0]!.parentId).toBeNull();

			// Second entry should have parentId = first entry's id
			expect(entries[1]!.parentId).toBe(entries[0]!.id);

			// Third entry should have parentId = second entry's id
			expect(entries[2]!.parentId).toBe(entries[1]!.id);
		});

		it("migration is idempotent (v2 stays v2)", () => {
			const sessionFile = join(dir, "session.jsonl");

			// Create and populate a session
			const session1 = new SessionManager(false, sessionFile, false, dir);
			session1.startSession({
				model: { provider: "test", id: "test-model" },
				thinkingLevel: "off",
				messages: [],
			} as never);
			const id1 = session1.appendMessage({ role: "user", content: "hello" });
			const id2 = session1.appendMessage({ role: "assistant", content: [{ type: "text", text: "hi" }] });

			// Load session again - should not change anything
			const session2 = new SessionManager(false, sessionFile, false, dir);
			const entry1 = session2.getEntry(id1!);
			const entry2 = session2.getEntry(id2!);

			expect(entry1!.id).toBe(id1);
			expect(entry2!.id).toBe(id2);
			expect(entry2!.parentId).toBe(id1);
		});

		it("preserves entry order during migration", () => {
			const sessionFile = join(dir, "session.jsonl");

			// Write v1 session file with multiple entries
			const timestamps = [
				new Date("2024-01-01T10:00:00Z"),
				new Date("2024-01-01T10:01:00Z"),
				new Date("2024-01-01T10:02:00Z"),
			];

			const v1Content = [
				JSON.stringify({
					type: "session",
					id: "test-session",
					timestamp: timestamps[0]!.toISOString(),
					cwd: dir,
					provider: "test",
					modelId: "test",
					thinkingLevel: "off",
				}),
				JSON.stringify({
					type: "message",
					timestamp: timestamps[0]!.toISOString(),
					message: { role: "user", content: "first" },
				}),
				JSON.stringify({
					type: "message",
					timestamp: timestamps[1]!.toISOString(),
					message: { role: "assistant", content: [{ type: "text", text: "second" }] },
				}),
				JSON.stringify({
					type: "message",
					timestamp: timestamps[2]!.toISOString(),
					message: { role: "user", content: "third" },
				}),
			].join("\n");
			writeFileSync(sessionFile, v1Content + "\n");

			// Load and verify order
			const session = new SessionManager(false, sessionFile, false, dir);
			const entries = session.getEntries();

			expect(entries.length).toBe(3);

			// Extract text content from entry
			const getText = (e: (typeof entries)[0]): string => {
				if (e?.type !== "message") return "";
				const msg = e.message as { role: string; content: unknown };
				if (typeof msg.content === "string") return msg.content;
				if (Array.isArray(msg.content)) {
					const textBlock = msg.content.find((c: { type: string; text?: string }) => c.type === "text");
					return textBlock?.text || "";
				}
				return "";
			};

			expect(getText(entries[0])).toBe("first");
			expect(getText(entries[1])).toBe("second");
			expect(getText(entries[2])).toBe("third");
		});

		it("handles empty session file", () => {
			const sessionFile = join(dir, "session.jsonl");

			// Write just the header
			const v1Content = JSON.stringify({
				type: "session",
				id: "test-session",
				timestamp: new Date().toISOString(),
				cwd: dir,
				provider: "test",
				modelId: "test",
				thinkingLevel: "off",
			});
			writeFileSync(sessionFile, v1Content + "\n");

			// Load session
			const session = new SessionManager(false, sessionFile, false, dir);

			// Should have no entries
			expect(session.getEntries().length).toBe(0);
			expect(session.getLeafId()).toBeNull();
		});
	});

	describe("tree structure after append", () => {
		it("maintains parent chain across multiple appends", () => {
			const sessionFile = join(dir, "session.jsonl");
			const session = new SessionManager(false, sessionFile, false, dir);
			session.startSession({
				model: { provider: "test", id: "test-model" },
				thinkingLevel: "off",
				messages: [],
			} as never);

			const ids: (string | null)[] = [];
			for (let i = 0; i < 10; i++) {
				const id = session.appendMessage({ role: "user", content: `msg${i}` });
				ids.push(id);
			}

			// Verify chain
			for (let i = 0; i < ids.length; i++) {
				const entry = session.getEntry(ids[i]!);
				expect(entry).toBeDefined();
				expect(entry!.id).toBe(ids[i]);

				if (i === 0) {
					expect(entry!.parentId).toBeNull();
				} else {
					expect(entry!.parentId).toBe(ids[i - 1]);
				}
			}

			// Leaf should be the last entry
			expect(session.getLeafId()).toBe(ids[ids.length - 1]);
		});
	});
});
