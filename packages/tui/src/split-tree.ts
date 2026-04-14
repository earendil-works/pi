/**
 * Split tree — pure data structure for TUI multiplexer pane layout.
 *
 * A binary tree where leaves are panes and internal nodes are horizontal/vertical
 * splits with a ratio controlling how space is divided between children.
 *
 * All functions are pure: they return new trees, never mutate input.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SplitDirection = "horizontal" | "vertical";

export type SplitNode =
	| { type: "leaf"; paneId: string }
	| { type: "split"; direction: SplitDirection; ratio: number; a: SplitNode; b: SplitNode };

/** Axis-aligned rectangle in terminal columns/rows. */
export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A single pane's computed position inside the layout. */
export interface PaneLayout {
	paneId: string;
	rect: Rect;
}

/**
 * A divider line between two panes.
 *
 * The `direction` field indicates the **split type** that produced this divider,
 * NOT the visual direction of the drawn line:
 * - `"horizontal"` split → produces a **vertical** divider line (`│`)
 * - `"vertical"` split → produces a **horizontal** divider line (`─`)
 */
export interface Divider {
	direction: SplitDirection;
	x: number;
	y: number;
	length: number;
}

/** Output of computeLayout — every pane rect + every divider. */
export interface LayoutResult {
	panes: PaneLayout[];
	dividers: Divider[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_PANE_COLS = 10;
const MIN_PANE_ROWS = 3;

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Create a new leaf node. */
export function newLeaf(paneId: string): SplitNode {
	return { type: "leaf", paneId };
}

// ---------------------------------------------------------------------------
// Layout computation
// ---------------------------------------------------------------------------

/**
 * Recursively compute pane rectangles and dividers for the entire tree.
 *
 * - Leaf nodes produce a single PaneLayout filling the entire bounds.
 * - Horizontal splits divide width: child A gets the left portion, child B the right,
 *   with a 1-column divider between them.
 * - Vertical splits divide height: child A gets the top portion, child B the bottom,
 *   with a 1-row divider between them.
 * - Neither child may shrink below 10 cols x 3 rows.
 */
export function computeLayout(root: SplitNode, bounds: Rect): LayoutResult {
	const panes: PaneLayout[] = [];
	const dividers: Divider[] = [];
	computeLayoutRec(root, bounds, panes, dividers);
	return { panes, dividers };
}

function computeLayoutRec(node: SplitNode, bounds: Rect, panes: PaneLayout[], dividers: Divider[]): void {
	if (node.type === "leaf") {
		panes.push({ paneId: node.paneId, rect: { ...bounds } });
		return;
	}

	if (node.direction === "horizontal") {
		// Horizontal split: divide width. 1 column for the divider.
		const available = bounds.width - 1; // 1 col for divider
		if (available < MIN_PANE_COLS * 2) {
			// Not enough room to split — treat as single pane showing child A
			computeLayoutRec(node.a, bounds, panes, dividers);
			return;
		}

		let aWidth = Math.round(available * node.ratio);
		let bWidth = available - aWidth;

		// Clamp minimums
		if (aWidth < MIN_PANE_COLS) {
			aWidth = MIN_PANE_COLS;
			bWidth = available - aWidth;
		}
		if (bWidth < MIN_PANE_COLS) {
			bWidth = MIN_PANE_COLS;
			aWidth = available - bWidth;
		}

		const divX = bounds.x + aWidth;

		computeLayoutRec(node.a, { x: bounds.x, y: bounds.y, width: aWidth, height: bounds.height }, panes, dividers);

		dividers.push({
			direction: "horizontal",
			x: divX,
			y: bounds.y,
			length: bounds.height,
		});

		computeLayoutRec(node.b, { x: divX + 1, y: bounds.y, width: bWidth, height: bounds.height }, panes, dividers);
	} else {
		// Vertical split: divide height. 1 row for the divider.
		const available = bounds.height - 1; // 1 row for divider
		if (available < MIN_PANE_ROWS * 2) {
			computeLayoutRec(node.a, bounds, panes, dividers);
			return;
		}

		let aHeight = Math.round(available * node.ratio);
		let bHeight = available - aHeight;

		if (aHeight < MIN_PANE_ROWS) {
			aHeight = MIN_PANE_ROWS;
			bHeight = available - aHeight;
		}
		if (bHeight < MIN_PANE_ROWS) {
			bHeight = MIN_PANE_ROWS;
			aHeight = available - bHeight;
		}

		const divY = bounds.y + aHeight;

		computeLayoutRec(node.a, { x: bounds.x, y: bounds.y, width: bounds.width, height: aHeight }, panes, dividers);

		dividers.push({
			direction: "vertical",
			x: bounds.x,
			y: divY,
			length: bounds.width,
		});

		computeLayoutRec(node.b, { x: bounds.x, y: divY + 1, width: bounds.width, height: bHeight }, panes, dividers);
	}
}

// ---------------------------------------------------------------------------
// Tree manipulation
// ---------------------------------------------------------------------------

/**
 * Split the leaf identified by `paneId` into two panes.
 *
 * The original pane becomes child A (left/top) and a new leaf with `newPaneId`
 * becomes child B (right/bottom). Returns a new tree — the original is not mutated.
 *
 * @param ratio - Space fraction allocated to child A. Default 0.5.
 */
export function splitPane(
	root: SplitNode,
	paneId: string,
	direction: SplitDirection,
	newPaneId: string,
	ratio = 0.5,
): SplitNode {
	return mapLeaf(root, paneId, (leaf) => ({
		type: "split",
		direction,
		ratio,
		a: leaf,
		b: newLeaf(newPaneId),
	}));
}

/**
 * Remove a leaf from the tree, promoting its sibling to take the parent split's place.
 *
 * Returns `null` if the removed pane was the root (tree is now empty).
 */
export function removePane(root: SplitNode, paneId: string): SplitNode | null {
	if (root.type === "leaf") {
		return root.paneId === paneId ? null : root;
	}

	// Check if the target is an immediate child of this split
	if (root.a.type === "leaf" && root.a.paneId === paneId) {
		return root.b;
	}
	if (root.b.type === "leaf" && root.b.paneId === paneId) {
		return root.a;
	}

	// Recurse into children
	const newA = removePane(root.a, paneId);
	if (newA !== root.a) {
		// Found in A subtree
		if (newA === null) return root.b;
		return { ...root, a: newA };
	}

	const newB = removePane(root.b, paneId);
	if (newB !== root.b) {
		// Found in B subtree
		if (newB === null) return root.a;
		return { ...root, b: newB };
	}

	// paneId not found — return tree unchanged
	return root;
}

/**
 * Depth-first list of all pane IDs in the tree.
 */
export function allPanes(root: SplitNode): string[] {
	if (root.type === "leaf") return [root.paneId];
	return [...allPanes(root.a), ...allPanes(root.b)];
}

/**
 * Count the number of leaf panes in the tree.
 */
export function paneCount(root: SplitNode): number {
	if (root.type === "leaf") return 1;
	return paneCount(root.a) + paneCount(root.b);
}

/**
 * Set the split ratio of the parent split containing `paneId`.
 *
 * The ratio is clamped to [0.1, 0.9]. Returns the tree unchanged if
 * `paneId` is not found or is the root leaf (no parent split).
 */
export function setRatio(root: SplitNode, paneId: string, ratio: number): SplitNode {
	const clamped = Math.max(0.1, Math.min(0.9, ratio));
	return setRatioRec(root, paneId, clamped);
}

function setRatioRec(node: SplitNode, paneId: string, ratio: number): SplitNode {
	if (node.type === "leaf") return node;

	// Check if either immediate child is the target leaf
	const aIsTarget = (node.a.type === "leaf" && node.a.paneId === paneId) || containsPane(node.a, paneId);
	const bIsTarget = (node.b.type === "leaf" && node.b.paneId === paneId) || containsPane(node.b, paneId);

	if (aIsTarget || bIsTarget) {
		// If the target is a direct child, update this split's ratio
		if (
			(node.a.type === "leaf" && node.a.paneId === paneId) ||
			(node.b.type === "leaf" && node.b.paneId === paneId)
		) {
			return { ...node, ratio };
		}
		// Otherwise recurse into the subtree that contains it
		if (aIsTarget) {
			return { ...node, a: setRatioRec(node.a, paneId, ratio) };
		}
		return { ...node, b: setRatioRec(node.b, paneId, ratio) };
	}

	return node;
}

/**
 * Find the nearest pane in the given direction from `paneId`.
 *
 * Uses the computed layout to determine spatial adjacency. Returns `null`
 * if there is no pane in that direction.
 */
export function adjacentPane(
	root: SplitNode,
	paneId: string,
	direction: "up" | "down" | "left" | "right",
): string | null {
	// We need a layout to determine spatial adjacency. Use a generous default
	// bounds — the actual terminal size doesn't matter for adjacency, only
	// relative positioning does.
	const layout = computeLayout(root, { x: 0, y: 0, width: 200, height: 60 });

	const sourcePane = layout.panes.find((p) => p.paneId === paneId);
	if (!sourcePane) return null;

	const src = sourcePane.rect;
	// Center of source pane
	const srcCenterX = src.x + src.width / 2;
	const srcCenterY = src.y + src.height / 2;

	let bestId: string | null = null;
	let bestDist = Infinity;

	for (const candidate of layout.panes) {
		if (candidate.paneId === paneId) continue;

		const cr = candidate.rect;
		const candCenterX = cr.x + cr.width / 2;
		const candCenterY = cr.y + cr.height / 2;

		let valid = false;
		switch (direction) {
			case "left":
				// Candidate must be to the left and overlap vertically
				valid = cr.x + cr.width <= src.x && overlapsVertically(src, cr);
				break;
			case "right":
				valid = cr.x >= src.x + src.width && overlapsVertically(src, cr);
				break;
			case "up":
				valid = cr.y + cr.height <= src.y && overlapsHorizontally(src, cr);
				break;
			case "down":
				valid = cr.y >= src.y + src.height && overlapsHorizontally(src, cr);
				break;
		}

		if (!valid) continue;

		const dx = candCenterX - srcCenterX;
		const dy = candCenterY - srcCenterY;
		const dist = dx * dx + dy * dy;
		if (dist < bestDist) {
			bestDist = dist;
			bestId = candidate.paneId;
		}
	}

	return bestId;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if two rects overlap on the vertical axis. */
function overlapsVertically(a: Rect, b: Rect): boolean {
	return a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Check if two rects overlap on the horizontal axis. */
function overlapsHorizontally(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width;
}

/** Check whether a subtree contains a pane with the given ID. */
function containsPane(node: SplitNode, paneId: string): boolean {
	if (node.type === "leaf") return node.paneId === paneId;
	return containsPane(node.a, paneId) || containsPane(node.b, paneId);
}

/**
 * Immutable map over the tree: find the leaf with `paneId` and replace it
 * with the result of `fn`. Returns the original tree structure unchanged
 * if `paneId` is not found.
 */
function mapLeaf(node: SplitNode, paneId: string, fn: (leaf: SplitNode & { type: "leaf" }) => SplitNode): SplitNode {
	if (node.type === "leaf") {
		return node.paneId === paneId ? fn(node) : node;
	}
	const newA = mapLeaf(node.a, paneId, fn);
	const newB = mapLeaf(node.b, paneId, fn);
	if (newA === node.a && newB === node.b) return node;
	return { ...node, a: newA, b: newB };
}
