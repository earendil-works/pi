import type { Component } from "./tui.ts";

export const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

/** @internal Capability for exact, bounded rendering of application-owned scroll content. */
export const WINDOWED_SCROLL_CONTENT = Symbol.for("@earendil-works/pi-tui/windowed-scroll-content");

export interface WindowedScrollContentRequest {
	width: number;
	scrollTop: number;
	viewportHeight: number;
	followingEnd: boolean;
}

export interface WindowedScrollWindow {
	/** Absolute document row represented by lines[0]. May precede the requested row for an intersecting image/block. */
	startRow: number;
	lines: readonly string[];
}

export interface PreparedWindowedScrollContent {
	contentHeight: number;
	/** Monotonic semantic/render revision used to reuse explicit search results. */
	revision?: number;
	/** Corrected absolute scroll row that preserves a semantic anchor after reflow. */
	anchorScrollTop?: number;
	renderWindow(startRow: number, rowCount: number): WindowedScrollWindow;
	lineAt(row: number): string | undefined;
}

export interface WindowedScrollContent extends Component {
	[WINDOWED_SCROLL_CONTENT](request: WindowedScrollContentRequest): PreparedWindowedScrollContent;
}

export function getWindowedScrollContent(component: Component): WindowedScrollContent | undefined {
	const candidate = component as Partial<WindowedScrollContent>;
	return typeof candidate[WINDOWED_SCROLL_CONTENT] === "function" ? (candidate as WindowedScrollContent) : undefined;
}

export interface LayoutViewport {
	width: number;
	height: number;
}

export interface StackLayoutEntry {
	component: Component;
	basis?: number | "auto";
	grow?: number;
	shrink?: number;
	minSize?: number;
	maxSize?: number;
	visible?: (viewport: LayoutViewport) => boolean;
}

export interface StackLayoutNode {
	type: "vstack" | "hstack";
	entries: readonly StackLayoutEntry[];
	gap: number;
	align: "stretch" | "start" | "center" | "end";
}

export interface ScrollLayoutState {
	readonly scrollTop: number;
	readonly isFollowingEnd: boolean;
	readonly primary: boolean;
	readonly overscroll: "chain" | "contain";
	readonly viewportHeight: number;
	getContentWidth(width: number): number;
	updateLayout(
		contentHeight: number,
		viewportHeight: number,
		requestRender: () => void,
		anchorScrollTop?: number,
	): void;
}

export interface ScrollLayoutNode {
	type: "scroll";
	component: Component;
	state: ScrollLayoutState;
}

export type LayoutNode = StackLayoutNode | ScrollLayoutNode;

export interface LayoutComponent extends Component {
	[LAYOUT_NODE](): LayoutNode;
}

export function getLayoutNode(component: Component): LayoutNode | undefined {
	const candidate = component as Partial<LayoutComponent>;
	return typeof candidate[LAYOUT_NODE] === "function" ? candidate[LAYOUT_NODE]() : undefined;
}
