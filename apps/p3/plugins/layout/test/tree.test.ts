// The pane layout's tree (`tree.ts`) as plain functions: opening beside an anchor (a new right split when no other
// group exists), moving within and between groups, splitting at each edge (merging into a split of the same
// direction), closing with the neighbour activated and empty groups collapsed, resizing clamped to the smallest share,
// keeping only known panes, and reading a tree from untrusted JSON.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	closePane,
	groupOf,
	groupsOf,
	keepPanes,
	MIN_SHARE,
	movePane,
	openPane,
	type PaneNode,
	panesOf,
	paneTree,
	parsePaneTree,
	resizeSplit,
	splitPane,
} from "../tree.ts";

/** A row of two groups: `g1` with the transcript, `g2` with notes and canvas (canvas active). */
const TWO: PaneNode = {
	kind: "split",
	direction: "row",
	children: [
		{ kind: "group", id: "g1", tabs: ["transcript"], active: "transcript" },
		{ kind: "group", id: "g2", tabs: ["notes", "canvas"], active: "canvas" },
	],
	sizes: [0.5, 0.5],
};

describe("opening", () => {
	it("splits a new group off to the right of the anchor's when there is no other group", () => {
		const tree = openPane(paneTree(["transcript"]), "notes", "transcript");
		assert.deepEqual(tree, {
			kind: "split",
			direction: "row",
			children: [
				{ kind: "group", id: "g1", tabs: ["transcript"], active: "transcript" },
				{ kind: "group", id: "g2", tabs: ["notes"], active: "notes" },
			],
			sizes: [0.5, 0.5],
		});
	});

	it("adds to the group beside the anchor, active; an open pane is only activated", () => {
		const tree = openPane(TWO, "files", "transcript");
		assert.deepEqual(groupOf(tree, "files"), {
			kind: "group",
			id: "g2",
			tabs: ["notes", "canvas", "files"],
			active: "files",
		});
		assert.equal(groupOf(openPane(TWO, "notes", "transcript"), "notes")?.active, "notes");
		assert.deepEqual(panesOf(openPane(TWO, "notes", "transcript")), panesOf(TWO));
	});
});

describe("moving", () => {
	it("reorders within a group, counting the index in the tabs before the move", () => {
		const tree = movePane(TWO, "canvas", "g2", 0);
		assert.deepEqual(groupOf(tree, "canvas")?.tabs, ["canvas", "notes"]);
		assert.deepEqual(groupOf(movePane(tree, "canvas", "g2", 2), "canvas")?.tabs, ["notes", "canvas"]);
	});

	it("moves into another group at the index, active there; a group left empty collapses", () => {
		const tree = movePane(TWO, "notes", "g1", 1);
		assert.deepEqual(groupOf(tree, "notes"), {
			kind: "group",
			id: "g1",
			tabs: ["transcript", "notes"],
			active: "notes",
		});
		assert.equal(groupOf(tree, "canvas")?.active, "canvas");
		const collapsed = movePane(tree, "canvas", "g1", 0);
		assert.deepEqual(collapsed, {
			kind: "group",
			id: "g1",
			tabs: ["canvas", "transcript", "notes"],
			active: "canvas",
		});
	});
});

describe("splitting", () => {
	it("splits a group at each edge: left and right in a row, top and bottom in a column", () => {
		for (const [edge, direction, first] of [
			["left", "row", "notes"],
			["right", "row", "canvas"],
			["top", "column", "notes"],
			["bottom", "column", "canvas"],
		] as const) {
			const tree = splitPane(paneTree(["canvas", "notes"]), "notes", "g1", edge);
			assert.equal(tree.kind, "split");
			if (tree.kind !== "split") continue;
			assert.equal(tree.direction, direction, edge);
			assert.deepEqual(panesOf(tree)[0], first, edge);
			assert.deepEqual(tree.sizes, [0.5, 0.5]);
		}
	});

	it("merges a split of the row's direction into the row, the split group's share halved", () => {
		const tree = splitPane(TWO, "notes", "g2", "right");
		assert.equal(tree.kind, "split");
		if (tree.kind !== "split") return;
		assert.deepEqual(
			groupsOf(tree).map((group) => group.tabs),
			[["transcript"], ["canvas"], ["notes"]],
		);
		assert.deepEqual(tree.sizes, [0.5, 0.25, 0.25]);
	});

	it("leaves the tree when the pane is its group's only tab, split onto itself", () => {
		assert.equal(splitPane(TWO, "transcript", "g1", "right"), TWO);
	});

	it("collapses the pane's old group when it leaves it empty", () => {
		const tree = splitPane(TWO, "transcript", "g2", "bottom");
		assert.deepEqual(tree, {
			kind: "split",
			direction: "column",
			children: [
				{ kind: "group", id: "g2", tabs: ["notes", "canvas"], active: "canvas" },
				{ kind: "group", id: "g3", tabs: ["transcript"], active: "transcript" },
			],
			sizes: [0.5, 0.5],
		});
	});
});

describe("closing", () => {
	it("activates the tab after the closed one, else the one before", () => {
		const three = paneTree(["a", "b", "c"]);
		assert.equal(groupOf(closePane({ ...three, active: "b" }, "b"), "a")?.active, "c");
		assert.equal(groupOf(closePane({ ...three, active: "c" }, "c"), "a")?.active, "b");
	});

	it("collapses an empty group and the split it leaves with one child", () => {
		const tree = closePane(closePane(TWO, "notes"), "canvas");
		assert.deepEqual(tree, { kind: "group", id: "g1", tabs: ["transcript"], active: "transcript" });
	});

	it("keeps one empty group when the last pane closes", () => {
		assert.deepEqual(closePane(paneTree(["a"]), "a"), { kind: "group", id: "g1", tabs: [], active: null });
	});
});

describe("resizing", () => {
	it("moves the divider by the share, the two beside it changing", () => {
		const tree = resizeSplit(TWO, [], 0, 0.2);
		assert.equal(tree.kind === "split" ? tree.sizes.map((size) => size.toFixed(2)).join() : "", "0.70,0.30");
	});

	it("clamps each side to the smallest share", () => {
		for (const delta of [5, -5]) {
			const tree = resizeSplit(TWO, [], 0, delta);
			if (tree.kind !== "split") assert.fail("still a split");
			assert.ok(Math.min(...tree.sizes) >= MIN_SHARE - 1e-9);
			assert.ok(Math.abs(tree.sizes[0]! + tree.sizes[1]! - 1) < 1e-9);
		}
	});

	it("resizes a nested split by its path", () => {
		const nested = splitPane(TWO, "notes", "g2", "bottom");
		const tree = resizeSplit(nested, [1], 0, -0.1);
		const inner = tree.kind === "split" ? tree.children[1] : undefined;
		assert.equal(inner?.kind === "split" ? inner.sizes.map((size) => size.toFixed(2)).join() : "", "0.40,0.60");
	});
});

describe("keeping and reading", () => {
	it("keeps only the panes the app still has, tidied; null when none is left", () => {
		assert.deepEqual(
			keepPanes(TWO, (pane) => pane !== "notes" && pane !== "canvas"),
			{
				kind: "group",
				id: "g1",
				tabs: ["transcript"],
				active: "transcript",
			},
		);
		assert.equal(
			keepPanes(TWO, () => false),
			null,
		);
		assert.equal(groupOf(keepPanes(TWO, (pane) => pane !== "canvas")!, "notes")?.active, "notes");
	});

	it("reads a tree from JSON, refusing what is not one", () => {
		assert.deepEqual(parsePaneTree(JSON.parse(JSON.stringify(TWO))), TWO);
		assert.equal(parsePaneTree({ kind: "split", direction: "diagonal", children: [], sizes: [] }), undefined);
		assert.equal(parsePaneTree({ kind: "group", id: "g1", tabs: [1], active: null }), undefined);
		assert.equal(parsePaneTree({ ...TWO, sizes: [1] }), undefined);
		assert.equal(parsePaneTree("tree"), undefined);
		// A pane twice, or a group id twice: not a tree this module made.
		assert.equal(parsePaneTree({ ...TWO, children: [TWO.children[1], TWO.children[1]] }), undefined);
		// An active tab that is none of the tabs: the first is active.
		assert.equal(groupOf(parsePaneTree({ kind: "group", id: "g1", tabs: ["a"], active: "z" })!, "a")?.active, "a");
	});
});
