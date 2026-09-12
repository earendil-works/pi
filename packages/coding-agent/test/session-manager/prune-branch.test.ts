import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

/** Build A -> B -> C -> D with a side branch C -> E -> F; leaf restored to D. */
function buildBranchedSession() {
	const session = SessionManager.inMemory();
	const a = session.appendMessage(userMsg("A"));
	const b = session.appendMessage(userMsg("B"));
	const c = session.appendMessage(userMsg("C"));
	const d = session.appendMessage(userMsg("D"));
	session.branch(c);
	const e = session.appendMessage(userMsg("E"));
	const f = session.appendMessage(assistantMsg("F"));
	session.branch(d);
	return { session, ids: { a, b, c, d, e, f } };
}

describe("SessionManager.pruneBranch", () => {
	it("removes a side subtree and keeps survivor ids and parent links", () => {
		const { session, ids } = buildBranchedSession();

		const result = session.pruneBranch(ids.e);

		expect(result.contextChanged).toBe(false);
		expect(result.removedEntryIds).toHaveLength(2);
		expect(new Set(result.removedEntryIds)).toEqual(new Set([ids.e, ids.f]));

		const entries = session.getEntries();
		expect(entries.map((e) => e.id).sort()).toEqual([ids.a, ids.b, ids.c, ids.d].sort());

		// Survivor parent links are intact.
		const byId = new Map(entries.map((e) => [e.id, e]));
		expect(byId.get(ids.b)!.parentId).toBe(ids.a);
		expect(byId.get(ids.c)!.parentId).toBe(ids.b);
		expect(byId.get(ids.d)!.parentId).toBe(ids.c);

		// The C -> E edge is gone from the tree.
		const tree = session.getTree();
		expect(tree).toHaveLength(1);
		const nodeC = tree[0].children[0].children[0];
		expect(nodeC.entry.id).toBe(ids.c);
		expect(nodeC.children.map((c) => c.entry.id)).toEqual([ids.d]);

		// Leaf stays on D.
		expect(session.getLeafId()).toBe(ids.d);
	});

	it("keeps buildSessionContext() unchanged for the active leaf", () => {
		const { session, ids } = buildBranchedSession();
		const before = session.buildSessionContext();

		session.pruneBranch(ids.e);

		const after = session.buildSessionContext();
		expect(after).toEqual(before);
		expect(session.countSubtree(ids.e)).toBe(0);
	});

	it("removes a deep branch and counts the whole subtree", () => {
		const session = SessionManager.inMemory();
		const root = session.appendMessage(userMsg("root"));
		const leaf = session.appendMessage(userMsg("leaf"));
		session.branch(root);
		const e1 = session.appendMessage(userMsg("e1"));
		const e2 = session.appendMessage(userMsg("e2"));
		const e3 = session.appendMessage(assistantMsg("e3"));
		session.branch(leaf);

		expect(session.countSubtree(e1)).toBe(3);
		expect(session.countSubtree(root)).toBe(5);

		const result = session.pruneBranch(e1);
		expect(new Set(result.removedEntryIds)).toEqual(new Set([e1, e2, e3]));
		expect(
			session
				.getEntries()
				.map((e) => e.id)
				.sort(),
		).toEqual([root, leaf].sort());
		expect(session.getLeafId()).toBe(leaf);
	});

	it("returns 0 from countSubtree for an unknown id", () => {
		const { session } = buildBranchedSession();
		expect(session.countSubtree("does-not-exist")).toBe(0);
	});

	it("throws for the leaf and for ancestors of the leaf", () => {
		const { session, ids } = buildBranchedSession();

		expect(() => session.pruneBranch(ids.d)).toThrow("Cannot delete the branch you are currently on");
		expect(() => session.pruneBranch(ids.c)).toThrow("Cannot delete the branch you are currently on");
		expect(() => session.pruneBranch(ids.a)).toThrow("Cannot delete the branch you are currently on");
		// Failed prunes leave the session untouched.
		expect(session.getEntries()).toHaveLength(6);
		expect(session.getLeafId()).toBe(ids.d);
	});

	it("throws for an unknown id", () => {
		const { session } = buildBranchedSession();
		expect(() => session.pruneBranch("nope")).toThrow("Entry nope not found");
	});

	it("drops label entries inside the removed set (set-then-clear across branches)", () => {
		const session = SessionManager.inMemory();
		const a = session.appendMessage(userMsg("A"));
		const b = session.appendMessage(userMsg("B"));
		const c = session.appendMessage(userMsg("C"));
		// Set a bookmark on C from the main branch.
		const setLabel = session.appendLabelChange(c, "bar");
		// Clear the same bookmark from a side branch.
		session.branch(b);
		const e = session.appendMessage(userMsg("E"));
		session.appendLabelChange(c, undefined);
		session.branch(setLabel);

		const result = session.pruneBranch(e);
		expect(result.removedEntryIds).toContain(e);

		// The clear is gone with the deleted branch, so the live bookmark survives.
		expect(session.getLabel(c)).toBe("bar");
		expect(session.getEntries().map((e) => e.id)).toContain(a);
		expect(session.getEntries().map((e) => e.id)).toContain(setLabel);
	});

	it("re-parents surviving children past a dropped label (orphan regression)", () => {
		const session = SessionManager.inMemory();
		const r = session.appendMessage(userMsg("R"));
		const a = session.appendMessage(userMsg("A"));
		// Side branch carrying the label target.
		session.branch(r);
		const x = session.appendMessage(userMsg("X"));
		// Continue the active branch from a label on X.
		session.branch(a);
		const label = session.appendLabelChange(x, "mark");
		const b = session.appendMessage(userMsg("B"));
		const branchBefore = session.getBranch().map((e) => e.id);
		const contextBefore = session.buildSessionContext();
		expect(branchBefore).toEqual([r, a, label, b]);

		const result = session.pruneBranch(x);
		expect(result.contextChanged).toBe(false);
		expect(result.removedEntryIds).toContain(x);
		expect(result.removedEntryIds).toContain(label);

		// B is re-parented to the label's nearest surviving ancestor (A).
		expect(session.getEntry(b)!.parentId).toBe(a);
		expect(session.getBranch().map((e) => e.id)).toEqual([r, a, b]);
		expect(session.buildSessionContext()).toEqual(contextBefore);
	});

	it("re-parents past chained labels (single-hop re-parent would dangle)", () => {
		const session = SessionManager.inMemory();
		const r = session.appendMessage(userMsg("R"));
		const a = session.appendMessage(userMsg("A"));
		session.branch(r);
		const x = session.appendMessage(userMsg("X"));
		session.branch(a);
		// Two labels back-to-back on the deleted target.
		const l1 = session.appendLabelChange(x, "one");
		const l2 = session.appendLabelChange(x, "two");
		const b = session.appendMessage(userMsg("B"));
		expect(session.getBranch().map((e) => e.id)).toEqual([r, a, l1, l2, b]);

		session.pruneBranch(x);

		expect(session.getEntry(l1)).toBeUndefined();
		expect(session.getEntry(l2)).toBeUndefined();
		expect(session.getEntry(b)!.parentId).toBe(a);
		expect(session.getBranch().map((e) => e.id)).toEqual([r, a, b]);
	});

	it("keeps an active-path label that is the leaf when its target is pruned", () => {
		const session = SessionManager.inMemory();
		const r = session.appendMessage(userMsg("R"));
		const a = session.appendMessage(userMsg("A"));
		session.branch(r);
		const x = session.appendMessage(userMsg("X"));
		session.branch(a);
		// The label advances the leaf, so it IS the leaf here.
		const label = session.appendLabelChange(x, "mark");
		expect(session.getLeafId()).toBe(label);
		const contextBefore = session.buildSessionContext();

		const result = session.pruneBranch(x);

		// The label survives as a structural node; the leaf still resolves.
		expect(result.removedEntryIds).not.toContain(label);
		expect(session.getLeafId()).toBe(label);
		expect(session.getLeafEntry()).toBeDefined();
		expect(session.getBranch().map((e) => e.id)).toEqual([r, a, label]);
		expect(session.buildSessionContext()).toEqual(contextBefore);
	});

	it("re-points a surviving on-path compaction past a dropped label", () => {
		const session = SessionManager.inMemory();
		const r = session.appendMessage(userMsg("R"));
		const a = session.appendMessage(userMsg("A"));
		session.branch(r);
		const x = session.appendMessage(userMsg("X"));
		session.branch(a);
		const label = session.appendLabelChange(x, "mark");
		const b = session.appendMessage(userMsg("B"));
		const compaction = session.appendCompaction("summary", label, 1000);
		const tail = session.appendMessage(userMsg("tail"));

		const result = session.pruneBranch(x);

		expect(result.contextChanged).toBe(true);
		const kept = session.getEntry(compaction);
		expect(kept?.type).toBe("compaction");
		if (kept?.type === "compaction") {
			expect(kept.firstKeptEntryId).toBe(b);
		}
		// Active branch and context remain valid.
		expect(session.getBranch().map((e) => e.id)).toEqual([r, a, b, compaction, tail]);
		expect(session.buildSessionContext().messages.length).toBeGreaterThan(0);
	});

	it("rewrites the file for persisted sessions; reopening yields survivors", () => {
		const tempDir = join(tmpdir(), `session-prune-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const session = SessionManager.create(tempDir, tempDir);
			session.appendMessage(userMsg("A"));
			session.appendMessage(assistantMsg("B"));
			const c = session.appendMessage(userMsg("C"));
			const d = session.appendMessage(assistantMsg("D"));
			session.branch(c);
			const e = session.appendMessage(userMsg("E"));
			session.appendMessage(assistantMsg("F"));
			session.branch(d);

			const file = session.getSessionFile()!;
			expect(existsSync(file)).toBe(true);

			session.pruneBranch(e);

			const reopened = SessionManager.open(file, tempDir);
			expect(
				reopened
					.getEntries()
					.map((en) => en.id)
					.sort(),
			).toEqual(
				session
					.getEntries()
					.map((en) => en.id)
					.sort(),
			);
			expect(reopened.getEntry(e)).toBeUndefined();
			expect(reopened.getLeafId()).toBe(d);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not create the file early for persisted sessions with no assistant", () => {
		const tempDir = join(tmpdir(), `session-prune-deferred-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		try {
			const session = SessionManager.create(tempDir, tempDir);
			const a = session.appendMessage(userMsg("A"));
			const b = session.appendMessage(userMsg("B"));
			session.branch(b);
			const e = session.appendMessage(userMsg("side"));
			session.branch(b);

			session.pruneBranch(e);

			const file = session.getSessionFile()!;
			expect(existsSync(file)).toBe(false);
			expect(
				session
					.getEntries()
					.map((en) => en.id)
					.sort(),
			).toEqual([a, b].sort());
			expect(session.getEntry(e)).toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("createBranchedSession still works after a prune (in-memory)", () => {
		const { session, ids } = buildBranchedSession();
		session.pruneBranch(ids.e);

		session.createBranchedSession(ids.d);
		expect(session.getEntries().map((e) => e.id)).toEqual([ids.a, ids.b, ids.c, ids.d]);
	});
});
