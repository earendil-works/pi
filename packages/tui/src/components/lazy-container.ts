import { type Component, Container } from "../tui.ts";

export interface LazyContainerOptions {
	/**
	 * Number of children parsed per scroll-up load once the initial visible
	 * window is filled (default: 20).
	 */
	batchSize?: number;
	/**
	 * Extra rows parsed beyond the visible window so scrolling up a little does
	 * not immediately stall on the marker (default: 60).
	 */
	preloadRows?: number;
}

/**
 * Container that renders a bulk child (typically the transcript) lazily: only
 * the bulk's children near the visible viewport are parsed - from the end, i.e.
 * the most recent messages - as far as needed to cover the viewport plus a
 * preload margin. Everything older renders as a single "N earlier messages"
 * marker row; when the marker scrolls into view the next batch of older
 * children is parsed and the scroll position is adjusted so the viewport stays
 * put. Fixed children (header, resource list) always render.
 *
 * Used by ScrollViews in lazy mode. Without a viewport (e.g. a plain container
 * in main-screen rendering) the container parses everything, exactly like a
 * regular Container.
 */
export class LazyContainer extends Container {
	/** Always-rendered leading children (header, resource list). */
	private fixedChildren: Component[] = [];
	/** The child whose own children are virtualized (the transcript). */
	private bulkChild: Container | undefined;
	/** How many bulk children (from the end) are parsed. */
	private parsedFromEnd = 0;
	private readonly batchSize: number;
	private readonly preloadRows: number;
	private viewportTop = 0;
	private viewportHeight = 0;
	private hasViewport = false;
	private hasRendered = false;
	private bulkLastLength = 0;
	private pendingLoad = false;
	private requestRenderCallback: (() => void) | undefined;
	private scrollAdjustCallback: ((rows: number) => void) | undefined;
	private markerLabel?: (unparsedCount: number) => string;
	/** When false, parse every child (full-history mode). */
	private lazyEnabled = true;
	/** True while the owning ScrollView is pinned to the end of the content. */
	private followingEnd = false;
	/** Main-screen mode: read the visible window height from this provider. */
	private windowHeightProvider: (() => number) | undefined;

	constructor(options: LazyContainerOptions = {}) {
		super();
		this.batchSize = Math.max(1, Math.floor(options.batchSize ?? 20));
		this.preloadRows = Math.max(0, Math.floor(options.preloadRows ?? 60));
	}

	/** Add an always-rendered child (header, resource list). */
	addFixed(child: Component): void {
		this.fixedChildren.push(child);
		this.children.push(child);
	}

	/** Set the child whose own children are virtualized (the transcript). */
	setBulkChild(child: Container): void {
		this.bulkChild = child;
		this.bulkLastLength = child.children.length;
	}

	/** Viewport (in this container's rows) provided by the owning ScrollView. */
	setViewport(top: number, height: number): void {
		const nextTop = Math.max(0, Math.floor(top));
		const nextHeight = Math.max(0, Math.floor(height));
		if (this.hasViewport && this.viewportTop === nextTop && this.viewportHeight === nextHeight) {
			return;
		}
		this.hasViewport = true;
		this.viewportTop = nextTop;
		this.viewportHeight = nextHeight;
		this.requestRenderCallback?.();
	}

	/** Re-render hook provided by the owning ScrollView. */
	setRequestRender(callback: () => void): void {
		this.requestRenderCallback = callback;
	}

	/**
	 * Scroll adjustment hook provided by the owning ScrollView. Called with the
	 * number of rows inserted at the top after a lazy load, so the viewport can
	 * be kept steady instead of jumping.
	 */
	setScrollAdjust(callback: (rows: number) => void): void {
		this.scrollAdjustCallback = callback;
	}

	/** Label for the marker row; defaults to "N earlier messages". */
	setMarkerLabel(label: (unparsedCount: number) => string): void {
		this.markerLabel = label;
	}

	/**
	 * Enable or disable lazy parsing. When disabled the container parses every
	 * child, exactly like a regular Container (used for full-history mode).
	 */
	setEnabled(enabled: boolean): void {
		this.lazyEnabled = enabled;
		if (!enabled) this.parsedFromEnd = this.bulkChildren().length;
	}

	/**
	 * Whether the owning ScrollView is pinned to the end of the content. While
	 * following the end the marker is only above the viewport by the preload
	 * margin, so scroll-up loading must not trigger.
	 */
	setFollowingEnd(following: boolean): void {
		this.followingEnd = following;
	}

	/**
	 * Main-screen mode: render the visible window lazily using the terminal
	 * height reported by the provider, without scroll-up loading (the terminal
	 * owns scrolling there). Pass undefined to return to scroll mode (used by
	 * the owning ScrollView).
	 */
	setWindowHeightProvider(provider: (() => number) | undefined): void {
		if (this.windowHeightProvider === provider) return;
		this.windowHeightProvider = provider;
		this.requestRenderCallback?.();
	}

	override addChild(component: Component): void {
		super.addChild(component);
		this.fixedChildren.push(component);
	}

	override clear(): void {
		super.clear();
		this.fixedChildren = [];
		this.bulkChild = undefined;
		this.parsedFromEnd = 0;
		this.bulkLastLength = 0;
	}

	override invalidate(): void {
		super.invalidate();
		this.requestRenderCallback?.();
	}

	private bulkChildren(): readonly Component[] {
		return this.bulkChild?.children ?? [];
	}

	/** Whether lazy parsing is enabled (false in full-history mode). */
	isLazy(): boolean {
		return this.lazyEnabled;
	}

	/** Height (rows) of the parsed bulk children. */
	private parsedHeight(width: number): number {
		const children = this.bulkChildren();
		let height = 0;
		for (let i = children.length - this.parsedFromEnd; i < children.length; i++) {
			height += children[i]!.render(width).length;
		}
		return height;
	}

	/**
	 * Parse bulk children from the end until the parsed region is at least
	 * `target` rows tall. Returns the number of rows added, or 0 if nothing new
	 * was parsed.
	 */
	private fillToTarget(width: number, target: number): number {
		const children = this.bulkChildren();
		if (this.parsedFromEnd >= children.length) return 0;
		const before = this.parsedFromEnd;
		let height = this.parsedHeight(width);
		if (height >= target) return 0;
		let parsed = this.parsedFromEnd;
		while (height < target && parsed < children.length) {
			parsed += 1;
			height += children[children.length - parsed]!.render(width).length;
		}
		this.parsedFromEnd = parsed;
		return height - this.parsedHeightAt(before, width);
	}

	/**
	 * Parse bulk children from the end until the parsed region covers the
	 * viewport plus the preload margin (scroll mode).
	 */
	private fillVisibleWindow(width: number, _fixedHeight: number): number {
		const children = this.bulkChildren();
		if (!this.hasViewport || this.parsedFromEnd >= children.length) return 0;
		// The parsed region is the tail of the content. It must be at least a
		// viewport plus the preload margin tall so the bottom of the content
		// (where the viewport sits when following the end) is covered with some
		// scroll room. This is intentionally independent of scrollTop: with
		// following-end, scrollTop grows as content is parsed, and using it in
		// the target would make the window expand until everything is parsed.
		const target = this.viewportHeight + this.preloadRows;
		return this.fillToTarget(width, target);
	}

	private parsedHeightAt(count: number, width: number): number {
		const children = this.bulkChildren();
		let height = 0;
		for (let i = children.length - count; i < children.length; i++) {
			height += children[i]!.render(width).length;
		}
		return height;
	}

	override render(width: number): string[] {
		const children = this.bulkChildren();

		// Newly appended bulk children (streaming) parse immediately. A shrink
		// means the bulk was cleared or trimmed (session navigation): reset the
		// append baseline and clamp the parsed window.
		const bulkLength = children.length;
		if (bulkLength < this.bulkLastLength) {
			this.bulkLastLength = bulkLength;
			this.parsedFromEnd = Math.min(this.parsedFromEnd, bulkLength);
		}
		if (this.hasRendered && bulkLength > this.bulkLastLength) {
			this.parsedFromEnd += bulkLength - this.bulkLastLength;
		}
		this.bulkLastLength = bulkLength;

		const lines: string[] = [];
		for (const child of this.fixedChildren) {
			lines.push(...child.render(width));
		}
		const fixedHeight = lines.length;

		// Full-history mode: parse everything, exactly like a regular Container.
		if (!this.lazyEnabled) {
			this.parsedFromEnd = children.length;
		} else if (this.windowHeightProvider) {
			// Main-screen mode: the visible window is the bottom `height` rows of
			// the content, reported by the terminal; no scroll-up loading.
			const height = Math.max(0, Math.floor(this.windowHeightProvider()));
			this.fillToTarget(width, height + this.preloadRows);
		} else if (this.hasViewport) {
			this.fillVisibleWindow(width, fixedHeight);
		} else {
			// No viewport and no window provider: parse everything.
			this.parsedFromEnd = children.length;
		}

		const unparsed = children.length - this.parsedFromEnd;
		if (unparsed > 0) {
			const label = this.markerLabel ? this.markerLabel(unparsed) : `${unparsed} earlier messages`;
			lines.push(label || " ");
			lines.push(" ");
		}
		for (let i = children.length - this.parsedFromEnd; i < children.length; i++) {
			lines.push(...children[i]!.render(width));
		}

		// When the marker row is at or above the viewport top (the user scrolled
		// up to the oldest parsed content), parse the next batch of older
		// children after this render, adjusting the scroll position so the
		// viewport does not jump. Scroll mode only. The viewportHeight > 0 guard
		// keeps the startup frame (viewport height 0 before the first layout)
		// from loading an extra batch on top of the initial window.
		if (
			this.hasViewport &&
			this.viewportHeight > 0 &&
			!this.followingEnd &&
			unparsed > 0 &&
			!this.pendingLoad &&
			this.viewportTop <= fixedHeight + this.preloadRows
		) {
			this.pendingLoad = true;
			queueMicrotask(() => {
				this.pendingLoad = false;
				const current = this.bulkChildren();
				if (this.parsedFromEnd >= current.length) return;
				const before = this.parsedFromEnd;
				this.parsedFromEnd = Math.min(current.length, this.parsedFromEnd + this.batchSize);
				const added = this.parsedHeightAt(this.parsedFromEnd, width) - this.parsedHeightAt(before, width);
				if (added > 0) {
					this.scrollAdjustCallback?.(added);
				}
				this.requestRenderCallback?.();
			});
		}

		this.hasRendered = true;
		return lines;
	}
}
