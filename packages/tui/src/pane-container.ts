/**
 * Pane container — composites multiple components into a split-tree layout.
 *
 * Holds a split-tree root supplier and a map of pane ID → Component. On render,
 * computes the layout, renders each component into its allocated rect,
 * and draws dividers between them.
 *
 * Divider.direction naming: "horizontal" means "produced by a horizontal split"
 * which renders as a vertical line (│). "vertical" means "produced by a vertical
 * split" which renders as a horizontal line (─). This matches the split-tree
 * convention, not the visual direction of the drawn character.
 */

import type { Rect, SplitNode } from "./split-tree.js";
import { computeLayout } from "./split-tree.js";
import type { Component } from "./tui.js";
import { sliceByColumn, visibleWidth } from "./utils.js";

// ---------------------------------------------------------------------------
// BoundsAwareComponent
// ---------------------------------------------------------------------------

/**
 * Optional interface for components that can render to bounded regions.
 * PaneContainer calls renderBounded if available, otherwise falls back
 * to render(width) and truncates to height.
 */
export interface BoundsAwareComponent extends Component {
	renderBounded(width: number, height: number): string[];
}

function isBoundsAware(c: Component): c is BoundsAwareComponent {
	return "renderBounded" in c && typeof (c as any).renderBounded === "function";
}

/** Optional cleanup interface for disposable pane components. */
interface Disposable {
	dispose(): void;
}

function isDisposable(c: Component): c is Component & Disposable {
	return "dispose" in c && typeof (c as any).dispose === "function";
}

// ---------------------------------------------------------------------------
// PaneContainer
// ---------------------------------------------------------------------------

export class PaneContainer implements BoundsAwareComponent {
	private rootSupplier: () => SplitNode;
	private panes: Map<string, Component> = new Map();
	private activePaneId: string;

	constructor(rootPaneId: string, rootComponent: Component) {
		const initialRoot: SplitNode = { type: "leaf", paneId: rootPaneId };
		this.rootSupplier = () => initialRoot;
		this.panes.set(rootPaneId, rootComponent);
		this.activePaneId = rootPaneId;
	}

	// --- Split tree access ---

	/**
	 * Set a supplier function that returns the current split tree root.
	 * This avoids caching a copy — the PaneContainer always reads fresh state.
	 */
	setRootSupplier(supplier: () => SplitNode): void {
		this.rootSupplier = supplier;
	}

	/**
	 * Set the root directly (convenience for simple cases).
	 */
	setRoot(root: SplitNode): void {
		this.rootSupplier = () => root;
	}

	getActivePaneId(): string {
		return this.activePaneId;
	}

	setActivePaneId(id: string): void {
		this.activePaneId = id;
	}

	// --- Pane management ---

	setPane(paneId: string, component: Component): void {
		this.panes.set(paneId, component);
	}

	getPane(paneId: string): Component | undefined {
		return this.panes.get(paneId);
	}

	/**
	 * Remove a pane. Calls dispose() on the component if available
	 * (e.g., PtyPane cleanup of shell processes).
	 */
	removePane(paneId: string): void {
		const component = this.panes.get(paneId);
		if (component && isDisposable(component)) {
			component.dispose();
		}
		this.panes.delete(paneId);
	}

	// --- Rendering ---

	/**
	 * Render using the full available terminal height minus the rows consumed
	 * by sibling components (tab bar, etc.). Reads process.stdout.rows for
	 * the current terminal dimensions so the layout recomputes on resize.
	 */
	render(width: number): string[] {
		// Use terminal height minus a small margin for siblings (tab bar)
		const termHeight = process.stdout.rows || 24;
		// Subtract rows for the tab bar (rendered as a sibling before us)
		const height = Math.max(4, termHeight - this.siblingRows);
		return this.renderBounded(width, height);
	}

	/** Number of rows consumed by sibling components outside PaneContainer. */
	siblingRows = 0;

	renderBounded(width: number, height: number): string[] {
		const root = this.rootSupplier();
		const bounds: Rect = { x: 0, y: 0, width, height };
		const layout = computeLayout(root, bounds);

		// Initialize output grid with spaces
		const lines: string[] = Array.from({ length: height }, () => " ".repeat(width));

		// Render each pane into its rect
		for (const pl of layout.panes) {
			const component = this.panes.get(pl.paneId);
			if (!component) continue;

			let paneLines: string[];
			if (isBoundsAware(component)) {
				paneLines = component.renderBounded(pl.rect.width, pl.rect.height);
			} else {
				paneLines = component.render(pl.rect.width);
			}

			// Truncate/pad to pane height
			while (paneLines.length < pl.rect.height) paneLines.push("");
			if (paneLines.length > pl.rect.height) paneLines = paneLines.slice(0, pl.rect.height);

			// Splice each pane line into the output grid at the correct column offset
			for (let row = 0; row < pl.rect.height; row++) {
				const outputRow = pl.rect.y + row;
				if (outputRow >= height) break;

				const paneLine = paneLines[row] || "";
				lines[outputRow] = spliceLine(lines[outputRow]!, pl.rect.x, pl.rect.width, paneLine);
			}
		}

		// Draw dividers (highlighted when adjacent to active pane)
		const ACTIVE_COLOR = "\x1b[36m"; // cyan
		const DIM_COLOR = "\x1b[90m"; // gray
		const RESET = "\x1b[0m";

		// Find active pane rect for adjacency highlighting
		const activeRect = layout.panes.find((p) => p.paneId === this.activePaneId)?.rect;

		for (const div of layout.dividers) {
			// Check if this divider borders the active pane
			const isAdjacentToActive = activeRect && isDividerAdjacentToRect(div, activeRect);
			const color = isAdjacentToActive ? ACTIVE_COLOR : DIM_COLOR;

			if (div.direction === "horizontal") {
				// Vertical line (│) at column div.x — from a horizontal split
				const divChar = `${color}│${RESET}`;
				for (let row = 0; row < div.length; row++) {
					const outputRow = div.y + row;
					if (outputRow >= height) break;
					lines[outputRow] = spliceLine(lines[outputRow]!, div.x, 1, divChar);
				}
			} else {
				// Horizontal line (─) at row div.y — from a vertical split
				const divLine = `${color}${"─".repeat(div.length)}${RESET}`;
				if (div.y < height) {
					lines[div.y] = spliceLine(lines[div.y]!, div.x, div.length, divLine);
				}
			}
		}

		return lines;
	}

	invalidate(): void {
		for (const component of this.panes.values()) {
			component.invalidate();
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a divider is adjacent to a rectangle (touches its border).
 */
function isDividerAdjacentToRect(
	div: { direction: string; x: number; y: number; length: number },
	rect: Rect,
): boolean {
	if (div.direction === "horizontal") {
		// Vertical divider — check if it's at the left or right edge of the rect
		return (
			(div.x === rect.x - 1 || div.x === rect.x + rect.width) &&
			div.y < rect.y + rect.height &&
			div.y + div.length > rect.y
		);
	}
	// Horizontal divider — check if it's at the top or bottom edge
	return (
		(div.y === rect.y - 1 || div.y === rect.y + rect.height) &&
		div.x < rect.x + rect.width &&
		div.x + div.length > rect.x
	);
}

/**
 * Splice `insert` into `line` at column `col` for `width` columns.
 *
 * Uses sliceByColumn from utils for ANSI-aware column extraction so
 * that escape codes in the background line and the inserted content
 * don't corrupt each other.
 */
function spliceLine(line: string, col: number, width: number, insert: string): string {
	const before = col > 0 ? sliceByColumn(line, 0, col) : "";
	const after = sliceByColumn(line, col + width, Math.max(0, visibleWidth(line) - col - width));

	// Pad insert to exact width so pane boundaries stay aligned
	const vw = visibleWidth(insert);
	const padded = vw < width ? insert + " ".repeat(width - vw) : sliceByColumn(insert, 0, width);

	return before + padded + after;
}
