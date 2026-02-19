/**
 * Tests for Session entry ID infrastructure (Slice 1)
 *
 * These tests verify:
 * - Unique 8-char hex ID generation with collision detection
 * - Entry types have id and parentId fields
 * - appendMessage returns the generated ID
 * - parentId chain is correctly maintained
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionManager } from "../../src/session-manager.js";

describe("SessionManager entry IDs", () => {
	let dir: string;
	let sessionFile: string;
	let session: SessionManager;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mu-session-ids-"));
		sessionFile = join(dir, "session.jsonl");
		session = new SessionManager(false, sessionFile, false, dir);
		// Start the session to initialize it
		session.startSession({
			model: { provider: "test", id: "test-model" },
			thinkingLevel: "off",
			messages: [],
		} as never);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("generateId", () => {
		it("generates unique 8-character hex IDs", () => {
			const ids = new Set<string>();
			for (let i = 0; i < 100; i++) {
				const id = session.appendMessage({ role: "user", content: `msg${i}` });
				expect(id).toMatch(/^[0-9a-f]{8}$/);
				ids.add(id!);
			}
			expect(ids.size).toBe(100);
		});
	});

	describe("appendMessage", () => {
		it("returns the generated entry ID", () => {
			const id = session.appendMessage({ role: "user", content: "hello" });
			expect(id).toBeDefined();
			expect(typeof id).toBe("string");
			expect(id!.length).toBe(8);
		});

		it("sets parentId to null for first entry", () => {
			const id1 = session.appendMessage({ role: "user", content: "first" });
			const entry = session.getEntry(id1!);
			expect(entry).toBeDefined();
			expect(entry!.parentId).toBeNull();
		});

		it("sets parentId to previous entry ID for subsequent entries", () => {
			const id1 = session.appendMessage({ role: "user", content: "first" });
			const id2 = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "second" }] });
			const id3 = session.appendMessage({ role: "user", content: "third" });

			const entry2 = session.getEntry(id2!);
			expect(entry2!.parentId).toBe(id1);

			const entry3 = session.getEntry(id3!);
			expect(entry3!.parentId).toBe(id2);
		});
	});

	describe("getEntry", () => {
		it("returns undefined for non-existent ID", () => {
			expect(session.getEntry("notexist")).toBeUndefined();
		});

		it("returns entry by ID", () => {
			const id = session.appendMessage({ role: "user", content: "test" });
			const entry = session.getEntry(id!);
			expect(entry).toBeDefined();
			expect(entry!.type).toBe("message");
			expect(entry!.id).toBe(id);
		});
	});

	describe("getLeafId", () => {
		it("returns null for empty session (after startSession)", () => {
			// After startSession but before any messages, leafId should be null
			const freshSession = new SessionManager(false, join(dir, "fresh.jsonl"), false, dir);
			freshSession.startSession({
				model: { provider: "test", id: "test-model" },
				thinkingLevel: "off",
				messages: [],
			} as never);
			expect(freshSession.getLeafId()).toBeNull();
		});

		it("returns ID of most recently appended entry", () => {
			const id1 = session.appendMessage({ role: "user", content: "first" });
			expect(session.getLeafId()).toBe(id1);

			const id2 = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "second" }] });
			expect(session.getLeafId()).toBe(id2);
		});
	});

	describe("getLeafEntry", () => {
		it("returns undefined for empty session", () => {
			const freshSession = new SessionManager(false, join(dir, "fresh2.jsonl"), false, dir);
			freshSession.startSession({
				model: { provider: "test", id: "test-model" },
				thinkingLevel: "off",
				messages: [],
			} as never);
			expect(freshSession.getLeafEntry()).toBeUndefined();
		});

		it("returns the leaf entry", () => {
			session.appendMessage({ role: "user", content: "first" });
			const id2 = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "second" }] });

			const leaf = session.getLeafEntry();
			expect(leaf).toBeDefined();
			expect(leaf!.id).toBe(id2);
		});
	});
});
