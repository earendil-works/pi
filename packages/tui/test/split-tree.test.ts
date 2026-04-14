import assert from "node:assert";
import { describe, it } from "node:test";
import {
	adjacentPane,
	allPanes,
	computeLayout,
	newLeaf,
	paneCount,
	removePane,
	setRatio,
	splitPane,
	type SplitNode,
} from "../src/split-tree.js";

describe("split-tree", () => {
	describe("newLeaf", () => {
		it("creates a leaf node", () => {
			const leaf = newLeaf("p1");
			assert.deepStrictEqual(leaf, { type: "leaf", paneId: "p1" });
		});
	});

	describe("splitPane", () => {
		it("splits a single leaf horizontally", () => {
			const root = newLeaf("p1");
			const result = splitPane(root, "p1", "horizontal", "p2");
			assert.strictEqual(result.type, "split");
			if (result.type === "split") {
				assert.strictEqual(result.direction, "horizontal");
				assert.strictEqual(result.ratio, 0.5);
				assert.deepStrictEqual(result.a, { type: "leaf", paneId: "p1" });
				assert.deepStrictEqual(result.b, { type: "leaf", paneId: "p2" });
			}
		});

		it("splits a nested leaf", () => {
			const root = splitPane(newLeaf("p1"), "p1", "horizontal", "p2");
			const result = splitPane(root, "p2", "vertical", "p3");
			assert.strictEqual(paneCount(result), 3);
			assert.deepStrictEqual(allPanes(result).sort(), ["p1", "p2", "p3"]);
		});

		it("returns original tree if paneId not found", () => {
			const root = newLeaf("p1");
			const result = splitPane(root, "nonexistent", "horizontal", "p2");
			assert.strictEqual(result, root);
		});

		it("uses custom ratio", () => {
			const root = newLeaf("p1");
			const result = splitPane(root, "p1", "horizontal", "p2", 0.3);
			if (result.type === "split") {
				assert.strictEqual(result.ratio, 0.3);
			}
		});
	});

	describe("removePane", () => {
		it("returns null when removing the only pane", () => {
			const root = newLeaf("p1");
			assert.strictEqual(removePane(root, "p1"), null);
		});

		it("promotes sibling when removing from a split", () => {
			const root = splitPane(newLeaf("p1"), "p1", "horizontal", "p2");
			const result = removePane(root, "p1");
			assert.deepStrictEqual(result, { type: "leaf", paneId: "p2" });
		});

		it("promotes sibling (other side)", () => {
			const root = splitPane(newLeaf("p1"), "p1", "horizontal", "p2");
			const result = removePane(root, "p2");
			assert.deepStrictEqual(result, { type: "leaf", paneId: "p1" });
		});

		it("returns original tree if paneId not found", () => {
			const root = splitPane(newLeaf("p1"), "p1", "horizontal", "p2");
			const result = removePane(root, "nonexistent");
			assert.strictEqual(result, root);
		});

		it("handles deep removal in 3-pane layout", () => {
			let root: SplitNode = newLeaf("p1");
			root = splitPane(root, "p1", "horizontal", "p2");
			root = splitPane(root, "p2", "vertical", "p3");
			// Tree: split(h, p1, split(v, p2, p3))
			assert.strictEqual(paneCount(root), 3);

			const result = removePane(root, "p3");
			assert.ok(result);
			assert.strictEqual(paneCount(result!), 2);
			assert.deepStrictEqual(allPanes(result!).sort(), ["p1", "p2"]);
		});
	});

	describe("allPanes / paneCount", () => {
		it("single leaf", () => {
			const root = newLeaf("p1");
			assert.deepStrictEqual(allPanes(root), ["p1"]);
			assert.strictEqual(paneCount(root), 1);
		});

		it("complex tree", () => {
			let root: SplitNode = newLeaf("a");
			root = splitPane(root, "a", "horizontal", "b");
			root = splitPane(root, "b", "vertical", "c");
			root = splitPane(root, "a", "vertical", "d");
			assert.strictEqual(paneCount(root), 4);
			assert.deepStrictEqual(allPanes(root).sort(), ["a", "b", "c", "d"]);
		});
	});

	describe("computeLayout", () => {
		it("single pane fills bounds", () => {
			const root = newLeaf("p1");
			const layout = computeLayout(root, { x: 0, y: 0, width: 80, height: 24 });
			assert.strictEqual(layout.panes.length, 1);
			assert.deepStrictEqual(layout.panes[0].rect, { x: 0, y: 0, width: 80, height: 24 });
			assert.strictEqual(layout.dividers.length, 0);
		});

		it("horizontal split creates two side-by-side panes", () => {
			const root = splitPane(newLeaf("p1"), "p1", "horizontal", "p2");
			const layout = computeLayout(root, { x: 0, y: 0, width: 80, height: 24 });
			assert.strictEqual(layout.panes.length, 2);
			assert.strictEqual(layout.dividers.length, 1);

			const left = layout.panes.find((p) => p.paneId === "p1")!;
			const right = layout.panes.find((p) => p.paneId === "p2")!;
			assert.ok(left.rect.width > 0);
			assert.ok(right.rect.width > 0);
			assert.ok(left.rect.x < right.rect.x);
			// Both should have full height
			assert.strictEqual(left.rect.height, 24);
			assert.strictEqual(right.rect.height, 24);
		});

		it("vertical split creates two stacked panes", () => {
			const root = splitPane(newLeaf("p1"), "p1", "vertical", "p2");
			const layout = computeLayout(root, { x: 0, y: 0, width: 80, height: 24 });
			assert.strictEqual(layout.panes.length, 2);

			const top = layout.panes.find((p) => p.paneId === "p1")!;
			const bottom = layout.panes.find((p) => p.paneId === "p2")!;
			assert.ok(top.rect.y < bottom.rect.y);
			// Both should have full width
			assert.strictEqual(top.rect.width, 80);
			assert.strictEqual(bottom.rect.width, 80);
		});

		it("respects minimum pane dimensions", () => {
			// Try to split a very small area — should still produce valid rects
			const root = splitPane(newLeaf("p1"), "p1", "horizontal", "p2");
			const layout = computeLayout(root, { x: 0, y: 0, width: 20, height: 6 });
			for (const pane of layout.panes) {
				assert.ok(pane.rect.width > 0, `Pane ${pane.paneId} has zero width`);
				assert.ok(pane.rect.height > 0, `Pane ${pane.paneId} has zero height`);
			}
		});
	});

	describe("setRatio", () => {
		it("updates parent split ratio for direct child", () => {
			const root = splitPane(newLeaf("p1"), "p1", "horizontal", "p2");
			const result = setRatio(root, "p1", 0.3);
			assert.strictEqual(result.type, "split");
			if (result.type === "split") {
				assert.strictEqual(result.ratio, 0.3);
			}
		});

		it("updates innermost parent for nested pane", () => {
			// Tree: split(h, A, split(v, B, C))
			let root: SplitNode = newLeaf("a");
			root = splitPane(root, "a", "horizontal", "bc");
			root = splitPane(root, "bc", "vertical", "c");
			// bc got replaced by split(v, bc, c). So the tree is:
			// split(h, a, split(v, bc, c))

			const result = setRatio(root, "bc", 0.7);
			// The inner split (containing bc) should get ratio 0.7
			assert.strictEqual(result.type, "split");
			if (result.type === "split") {
				// Outer split ratio should be unchanged
				assert.strictEqual(result.ratio, 0.5);
				// Inner split should have the new ratio
				assert.strictEqual(result.b.type, "split");
				if (result.b.type === "split") {
					assert.strictEqual(result.b.ratio, 0.7);
				}
			}
		});

		it("clamps ratio to [0.1, 0.9]", () => {
			const root = splitPane(newLeaf("p1"), "p1", "horizontal", "p2");
			const tooLow = setRatio(root, "p1", 0.01);
			const tooHigh = setRatio(root, "p1", 0.99);
			if (tooLow.type === "split") assert.strictEqual(tooLow.ratio, 0.1);
			if (tooHigh.type === "split") assert.strictEqual(tooHigh.ratio, 0.9);
		});

		it("returns original tree if pane not found", () => {
			const root = splitPane(newLeaf("p1"), "p1", "horizontal", "p2");
			const result = setRatio(root, "nonexistent", 0.7);
			assert.strictEqual(result, root);
		});
	});

	describe("adjacentPane", () => {
		it("returns null for single pane", () => {
			const root = newLeaf("p1");
			assert.strictEqual(adjacentPane(root, "p1", "right"), null);
			assert.strictEqual(adjacentPane(root, "p1", "left"), null);
		});

		it("finds horizontal neighbor", () => {
			const root = splitPane(newLeaf("p1"), "p1", "horizontal", "p2");
			assert.strictEqual(adjacentPane(root, "p1", "right"), "p2");
			assert.strictEqual(adjacentPane(root, "p2", "left"), "p1");
		});

		it("finds vertical neighbor", () => {
			const root = splitPane(newLeaf("p1"), "p1", "vertical", "p2");
			assert.strictEqual(adjacentPane(root, "p1", "down"), "p2");
			assert.strictEqual(adjacentPane(root, "p2", "up"), "p1");
		});

		it("returns null when no neighbor in direction", () => {
			const root = splitPane(newLeaf("p1"), "p1", "horizontal", "p2");
			assert.strictEqual(adjacentPane(root, "p1", "left"), null);
			assert.strictEqual(adjacentPane(root, "p2", "right"), null);
			assert.strictEqual(adjacentPane(root, "p1", "up"), null);
		});
	});
});
