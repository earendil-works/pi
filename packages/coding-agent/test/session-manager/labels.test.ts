/**
 * Tests for Session label support (Slice 4)
 *
 * These tests verify:
 * - appendLabelChange creates label entry
 * - getLabel returns latest label
 * - getLabel with undefined clears label
 * - labels appear in getTree()
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionManager } from "../../src/session-manager.js";

describe("SessionManager labels", () => {
	let dir: string;
	let session: SessionManager;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mu-session-labels-"));
		const sessionFile = join(dir, "session.jsonl");
		session = new SessionManager(false, sessionFile, false, dir);
		session.startSession({
			model: { provider: "test", id: "test-model" },
			thinkingLevel: "off",
			messages: [],
		} as never);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("appendLabelChange", () => {
		it("creates label entry", () => {
			const msgId = session.appendMessage({ role: "user", content: "hello" });
			const labelId = session.appendLabelChange(msgId!, "checkpoint");

			expect(labelId).toBeDefined();
			expect(labelId).toMatch(/^[0-9a-f]{8}$/);

			const entry = session.getEntry(labelId!);
			expect(entry).toBeDefined();
			expect(entry!.type).toBe("label");
		});

		it("getLabel returns the label", () => {
			const msgId = session.appendMessage({ role: "user", content: "hello" });
			session.appendLabelChange(msgId!, "checkpoint");

			expect(session.getLabel(msgId!)).toBe("checkpoint");
		});

		it("multiple label changes keep latest", () => {
			const msgId = session.appendMessage({ role: "user", content: "hello" });
			session.appendLabelChange(msgId!, "first");
			session.appendLabelChange(msgId!, "second");
			session.appendLabelChange(msgId!, "third");

			expect(session.getLabel(msgId!)).toBe("third");
		});

		it("label with undefined clears the label", () => {
			const msgId = session.appendMessage({ role: "user", content: "hello" });
			session.appendLabelChange(msgId!, "checkpoint");
			expect(session.getLabel(msgId!)).toBe("checkpoint");

			session.appendLabelChange(msgId!, undefined);
			expect(session.getLabel(msgId!)).toBeUndefined();
		});
	});

	describe("getTree with labels", () => {
		it("includes labels in tree nodes", () => {
			const msgId = session.appendMessage({ role: "user", content: "hello" });
			session.appendLabelChange(msgId!, "important");

			const tree = session.getTree();
			expect(tree).toHaveLength(1);
			expect(tree[0]!.label).toBe("important");
		});

		it("labels do not appear as tree nodes", () => {
			const msgId = session.appendMessage({ role: "user", content: "hello" });
			session.appendLabelChange(msgId!, "checkpoint");

			const tree = session.getTree();
			// Only the message should be in the tree, not the label entry
			expect(tree).toHaveLength(1);
			expect(tree[0]!.entry.type).toBe("message");
		});
	});
});
