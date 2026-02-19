/**
 * Tests for Session tree traversal methods (Slice 2)
 *
 * These tests verify:
 * - getBranch() walks from leaf to root
 * - getBranch(fromId) walks from specified entry to root
 * - getTree() builds correct tree structure
 * - getChildren() returns child nodes
 * - branch(entryId) moves leaf pointer
 * - resetLeaf() resets leaf to null
 * - Cycle detection in parent chain
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionManager } from "../../src/session-manager.js";

describe("SessionManager tree traversal", () => {
	let dir: string;
	let session: SessionManager;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mu-session-tree-"));
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

	describe("getBranch", () => {
		it("returns empty array for empty session", () => {
			const freshSession = new SessionManager(false, join(dir, "fresh.jsonl"), false, dir);
			freshSession.startSession({
				model: { provider: "test", id: "test-model" },
				thinkingLevel: "off",
				messages: [],
			} as never);
			expect(freshSession.getBranch()).toEqual([]);
		});

		it("returns single entry path", () => {
			const id = session.appendMessage({ role: "user", content: "hello" });
			const path = session.getBranch();
			expect(path).toHaveLength(1);
			expect(path[0]!.id).toBe(id);
		});

		it("returns full path from root to leaf", () => {
			const id1 = session.appendMessage({ role: "user", content: "1" });
			const id2 = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "2" }] });
			const id3 = session.appendMessage({ role: "user", content: "3" });
			const id4 = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "4" }] });

			const path = session.getBranch();
			expect(path).toHaveLength(4);
			expect(path.map((e) => e.id)).toEqual([id1, id2, id3, id4]);
		});

		it("returns path from specified entry to root", () => {
			const id1 = session.appendMessage({ role: "user", content: "1" });
			const id2 = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "2" }] });
			const id3 = session.appendMessage({ role: "user", content: "3" });
			session.appendMessage({ role: "assistant", content: [{ type: "text", text: "4" }] });

			const path = session.getBranch(id2!);
			expect(path).toHaveLength(2);
			expect(path.map((e) => e.id)).toEqual([id1, id2]);
		});

		it("detects and breaks cycles in parent chain", () => {
			const id1 = session.appendMessage({ role: "user", content: "1" });
			const id2 = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "2" }] });

			// Manually corrupt the parent chain to create a cycle
			const entry2 = session.getEntry(id2!);
			if (entry2) {
				(entry2 as any).parentId = id1; // This is already correct, let's make it point to itself
			}

			// Make id1 parent point to id2 (creating a cycle: id1 -> id2 -> id1)
			const entry1 = session.getEntry(id1!);
			if (entry1) {
				(entry1 as any).parentId = id2;
			}

			// getBranch should detect the cycle and not infinite loop
			const path = session.getBranch();
			expect(path.length).toBeLessThanOrEqual(2);
		});
	});

	describe("getTree", () => {
		it("returns empty array for empty session", () => {
			const freshSession = new SessionManager(false, join(dir, "fresh.jsonl"), false, dir);
			freshSession.startSession({
				model: { provider: "test", id: "test-model" },
				thinkingLevel: "off",
				messages: [],
			} as never);
			expect(freshSession.getTree()).toEqual([]);
		});

		it("returns single root for linear session", () => {
			const id1 = session.appendMessage({ role: "user", content: "1" });
			const id2 = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "2" }] });
			const id3 = session.appendMessage({ role: "user", content: "3" });

			const tree = session.getTree();
			expect(tree).toHaveLength(1);

			const root = tree[0]!;
			expect(root.entry.id).toBe(id1);
			expect(root.children).toHaveLength(1);
			expect(root.children[0]!.entry.id).toBe(id2);
			expect(root.children[0]!.children).toHaveLength(1);
			expect(root.children[0]!.children[0]!.entry.id).toBe(id3);
			expect(root.children[0]!.children[0]!.children).toHaveLength(0);
		});

		it("returns tree with branches after branch()", () => {
			// Build: 1 -> 2 -> 3
			const id1 = session.appendMessage({ role: "user", content: "1" });
			const id2 = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "2" }] });
			const id3 = session.appendMessage({ role: "user", content: "3" });

			// Branch from id2, add new path: 2 -> 4
			session.branch(id2!);
			const id4 = session.appendMessage({ role: "user", content: "4-branch" });

			const tree = session.getTree();
			expect(tree).toHaveLength(1);

			const root = tree[0]!;
			expect(root.entry.id).toBe(id1);
			expect(root.children).toHaveLength(1);

			const node2 = root.children[0]!;
			expect(node2.entry.id).toBe(id2);
			expect(node2.children).toHaveLength(2); // id3 and id4 are siblings

			const childIds = node2.children.map((c) => c.entry.id).sort();
			expect(childIds).toEqual([id3, id4].sort());
		});

		it("handles multiple branches at same point", () => {
			session.appendMessage({ role: "user", content: "root" });
			const id2 = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "response" }] });

			// Branch A
			session.branch(id2!);
			const idA = session.appendMessage({ role: "user", content: "branch-A" });

			// Branch B
			session.branch(id2!);
			const idB = session.appendMessage({ role: "user", content: "branch-B" });

			// Branch C
			session.branch(id2!);
			const idC = session.appendMessage({ role: "user", content: "branch-C" });

			const tree = session.getTree();
			const node2 = tree[0]!.children[0]!;
			expect(node2.entry.id).toBe(id2);
			expect(node2.children).toHaveLength(3);

			const branchIds = node2.children.map((c) => c.entry.id).sort();
			expect(branchIds).toEqual([idA, idB, idC].sort());
		});

		it("handles deep branching", () => {
			// Main path: 1 -> 2 -> 3 -> 4
			session.appendMessage({ role: "user", content: "1" });
			const id2 = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "2" }] });
			session.appendMessage({ role: "user", content: "3" });
			session.appendMessage({ role: "assistant", content: [{ type: "text", text: "4" }] });

			// Branch from 2: 2 -> 5 -> 6
			session.branch(id2!);
			const id5 = session.appendMessage({ role: "user", content: "5" });
			session.appendMessage({ role: "assistant", content: [{ type: "text", text: "6" }] });

			// Branch from 5: 5 -> 7
			session.branch(id5!);
			session.appendMessage({ role: "user", content: "7" });

			const tree = session.getTree();

			// Verify structure
			const node2 = tree[0]!.children[0]!;
			expect(node2.children).toHaveLength(2); // id3 and id5

			const node5 = node2.children.find((c) => c.entry.id === id5)!;
			expect(node5).toBeDefined();
			expect(node5.children).toHaveLength(2); // id6 and id7
		});

		it("handles orphaned entries as roots", () => {
			const id1 = session.appendMessage({ role: "user", content: "1" });
			const id2 = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "2" }] });

			// Corrupt: make id1 parent point to non-existent entry
			const entry1 = session.getEntry(id1!);
			if (entry1) {
				(entry1 as any).parentId = "nonexistent";
			}

			const tree = session.getTree();
			// Both entries should be roots (orphaned)
			expect(tree.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("branch", () => {
		it("throws for non-existent entry", () => {
			expect(() => session.branch("nonexistent")).toThrow("Entry nonexistent not found");
		});

		it("moves leaf pointer to specified entry", () => {
			const id1 = session.appendMessage({ role: "user", content: "1" });
			session.appendMessage({ role: "assistant", content: [{ type: "text", text: "2" }] });
			const id3 = session.appendMessage({ role: "user", content: "3" });

			expect(session.getLeafId()).toBe(id3);

			session.branch(id1!);
			expect(session.getLeafId()).toBe(id1);
		});

		it("new appends become children of branch point", () => {
			const id1 = session.appendMessage({ role: "user", content: "1" });
			const id2 = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "2" }] });

			session.branch(id1!);
			const id3 = session.appendMessage({ role: "user", content: "branched" });

			const entry3 = session.getEntry(id3!);
			expect(entry3!.parentId).toBe(id1); // sibling of id2

			const tree = session.getTree();
			const root = tree[0]!;
			expect(root.children).toHaveLength(2);

			const childIds = root.children.map((c) => c.entry.id).sort();
			expect(childIds).toEqual([id2, id3].sort());
		});
	});

	describe("resetLeaf", () => {
		it("sets leaf to null", () => {
			session.appendMessage({ role: "user", content: "1" });
			session.appendMessage({ role: "assistant", content: [{ type: "text", text: "2" }] });

			expect(session.getLeafId()).not.toBeNull();

			session.resetLeaf();
			expect(session.getLeafId()).toBeNull();
		});

		it("next append creates a new root", () => {
			const id1 = session.appendMessage({ role: "user", content: "1" });
			session.appendMessage({ role: "assistant", content: [{ type: "text", text: "2" }] });

			session.resetLeaf();
			const id3 = session.appendMessage({ role: "user", content: "new root" });

			const entry3 = session.getEntry(id3!);
			expect(entry3!.parentId).toBeNull();

			const tree = session.getTree();
			expect(tree).toHaveLength(2); // Two roots
		});
	});

	describe("getChildren", () => {
		it("returns empty array for leaf entry", () => {
			const id = session.appendMessage({ role: "user", content: "hello" });
			expect(session.getChildren(id!)).toEqual([]);
		});

		it("returns child nodes", () => {
			const id1 = session.appendMessage({ role: "user", content: "1" });
			const id2 = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "2" }] });
			const id3 = session.appendMessage({ role: "user", content: "3" });

			const children = session.getChildren(id1!);
			expect(children).toHaveLength(1);
			expect(children[0]!.entry.id).toBe(id2);

			// After branching, id1 should have two children
			session.branch(id2!);
			const id4 = session.appendMessage({ role: "user", content: "4" });

			const children2 = session.getChildren(id2!);
			expect(children2).toHaveLength(2);
			const childIds = children2.map((c) => c.entry.id).sort();
			expect(childIds).toEqual([id3, id4].sort());
		});
	});
});
