import { LAYOUT_NODE, type ScrollLayoutNode } from "../layout-node.ts";
import { type Component, Container } from "../tui.ts";
import { LazyContainer } from "./lazy-container.ts";

export type ScrollViewScrollbar = "hidden" | "auto" | "always";

export interface ScrollViewOptions {
	axis?: "vertical";
	follow?: "none" | "end";
	primary?: boolean;
	overscroll?: "chain" | "contain";
	scrollbar?: ScrollViewScrollbar;
	scrollbarStyle?: (text: string) => string;
	scrollbarHideDelayMs?: number;
	/**
	 * Render the child lazily: only the content near the viewport is parsed and
	 * the rest is loaded in batches as the user scrolls. Requires the child to
	 * be a LazyContainer.
	 */
	lazy?: boolean;
}

export class ScrollView extends Container {
	private readonly child: Component;
	private readonly followEnd: boolean;
	readonly primary: boolean;
	readonly overscroll: "chain" | "contain";
	readonly scrollbarStyle: (text: string) => string;
	private currentScrollbar: ScrollViewScrollbar;
	private readonly scrollbarHideDelayMs: number;
	private currentScrollTop = 0;
	private contentHeight = 0;
	private currentViewportHeight = 0;
	private followingEnd: boolean;
	private requestRenderCallback: (() => void) | undefined;
	private transientScrollbarVisible = false;
	private scrollbarActive = false;
	private scrollbarHideTimer: NodeJS.Timeout | undefined;
	private lazyChild: LazyContainer | undefined;
	private pendingScrollAdjust = 0;

	constructor(component: Component, options: ScrollViewOptions = {}) {
		super();
		if (options.axis !== undefined && options.axis !== "vertical") {
			throw new Error(`Unsupported ScrollView axis: ${options.axis}`);
		}
		this.child = component;
		this.children.push(component);
		this.followEnd = (options.follow ?? "none") === "end";
		this.followingEnd = this.followEnd;
		this.primary = options.primary ?? false;
		this.overscroll = options.overscroll ?? "chain";
		this.currentScrollbar = options.scrollbar ?? "hidden";
		this.scrollbarStyle = options.scrollbarStyle ?? ((text) => `\x1b[100m${text}\x1b[49m`);
		this.scrollbarHideDelayMs = Math.max(0, Math.floor(options.scrollbarHideDelayMs ?? 1000));
		if (options.lazy) {
			if (!(component instanceof LazyContainer)) {
				throw new Error("ScrollView lazy mode requires a LazyContainer child");
			}
			this.lazyChild = component;
			component.setScrollAdjust((rows) => {
				this.pendingScrollAdjust += rows;
			});
			// Establish a viewport before the first layout so the child renders
			// lazily from the very first frame.
			this.syncLazyViewport();
		}
	}

	private syncLazyViewport(): void {
		if (!this.lazyChild) return;
		this.lazyChild.setRequestRender(this.requestRenderCallback ?? (() => {}));
		this.lazyChild.setFollowingEnd(this.followingEnd);
		this.lazyChild.setViewport(this.currentScrollTop, this.currentViewportHeight);
	}

	get scrollTop(): number {
		return this.currentScrollTop;
	}

	get isFollowingEnd(): boolean {
		return this.followingEnd;
	}

	get viewportHeight(): number {
		return this.currentViewportHeight;
	}

	get scrollbar(): ScrollViewScrollbar {
		return this.currentScrollbar;
	}

	get isScrollbarVisible(): boolean {
		if (this.scrollbar === "always") return this.currentViewportHeight > 0;
		return (
			this.scrollbar === "auto" && this.contentHeight > this.currentViewportHeight && this.transientScrollbarVisible
		);
	}

	setScrollbar(scrollbar: ScrollViewScrollbar): void {
		if (scrollbar === this.currentScrollbar) return;
		this.currentScrollbar = scrollbar;
		if (scrollbar !== "auto") this.hideTransientScrollbar();
		else if (this.scrollbarActive) this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	getContentWidth(width: number): number {
		return this.scrollbar === "always" && width > 1 ? width - 1 : width;
	}

	private markScrollbarActivity(): void {
		if (this.scrollbar !== "auto" || this.contentHeight <= this.currentViewportHeight) return;
		this.transientScrollbarVisible = true;
		if (this.scrollbarHideTimer) {
			clearTimeout(this.scrollbarHideTimer);
			this.scrollbarHideTimer = undefined;
		}
		if (this.scrollbarActive) return;
		this.scrollbarHideTimer = setTimeout(() => {
			this.scrollbarHideTimer = undefined;
			this.transientScrollbarVisible = false;
			this.requestRenderCallback?.();
		}, this.scrollbarHideDelayMs);
		this.scrollbarHideTimer.unref();
	}

	private hideTransientScrollbar(): void {
		this.transientScrollbarVisible = false;
		if (!this.scrollbarHideTimer) return;
		clearTimeout(this.scrollbarHideTimer);
		this.scrollbarHideTimer = undefined;
	}

	setScrollbarActive(active: boolean): void {
		if (active === this.scrollbarActive) return;
		this.scrollbarActive = active;
		this.markScrollbarActivity();
	}

	scrollTo(scrollTop: number): void {
		const requested = Number.isFinite(scrollTop) ? Math.trunc(scrollTop) : this.currentScrollTop;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const next = Math.max(0, Math.min(maxScrollTop, requested));
		if (next === this.currentScrollTop) return;
		this.currentScrollTop = next;
		this.followingEnd = this.followEnd && next === maxScrollTop;
		this.syncLazyViewport();
		this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	scrollBy(lines: number): number {
		const requested = Number.isFinite(lines) ? Math.trunc(lines) : 0;
		if (requested === 0) return 0;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const start = this.followingEnd ? maxScrollTop : this.currentScrollTop;
		const next = Math.max(0, Math.min(maxScrollTop, start + requested));
		const moved = next - start;
		this.currentScrollTop = next;
		this.followingEnd = this.followEnd && next === maxScrollTop;
		if (moved !== 0) {
			this.syncLazyViewport();
			this.markScrollbarActivity();
			this.requestRenderCallback?.();
		}
		return requested - moved;
	}

	scrollToStart(): void {
		const changed =
			this.currentScrollTop !== 0 ||
			this.followingEnd !== (this.followEnd && this.contentHeight <= this.currentViewportHeight);
		this.currentScrollTop = 0;
		this.followingEnd = this.followEnd && this.contentHeight <= this.currentViewportHeight;
		if (changed) {
			this.syncLazyViewport();
			this.markScrollbarActivity();
			this.requestRenderCallback?.();
		}
	}

	scrollToEnd(): void {
		const next = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const changed = this.currentScrollTop !== next || this.followingEnd !== this.followEnd;
		this.currentScrollTop = next;
		this.followingEnd = this.followEnd;
		if (changed) {
			this.syncLazyViewport();
			this.markScrollbarActivity();
			this.requestRenderCallback?.();
		}
	}

	updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		this.contentHeight = Math.max(0, Math.floor(contentHeight));
		this.currentViewportHeight = Math.max(0, Math.floor(viewportHeight));
		this.requestRenderCallback = requestRender;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		if (this.followingEnd) {
			this.currentScrollTop = maxScrollTop;
			this.pendingScrollAdjust = 0;
		} else {
			this.currentScrollTop = Math.max(0, Math.min(this.currentScrollTop, maxScrollTop));
			// Lazy loads insert content above the viewport; shift the scroll
			// position by the inserted rows so the viewport stays put.
			if (this.pendingScrollAdjust !== 0) {
				this.currentScrollTop = Math.max(
					0,
					Math.min(this.currentScrollTop + this.pendingScrollAdjust, maxScrollTop),
				);
				this.pendingScrollAdjust = 0;
			}
		}
		if (this.followEnd && this.currentScrollTop === maxScrollTop) this.followingEnd = true;
		if (this.contentHeight <= this.currentViewportHeight) this.hideTransientScrollbar();
		this.syncLazyViewport();
	}

	override addChild(_component: Component): void {
		throw new Error("ScrollView has exactly one child");
	}

	override removeChild(_component: Component): void {
		throw new Error("ScrollView child cannot be removed");
	}

	override clear(): void {
		throw new Error("ScrollView child cannot be cleared");
	}

	override render(width: number): string[] {
		const contentWidth = this.getContentWidth(width);
		const lines = this.child.render(contentWidth);
		return contentWidth === width ? lines : lines.map((line) => `${line} `);
	}

	[LAYOUT_NODE](): ScrollLayoutNode {
		return { type: "scroll", component: this.child, state: this };
	}
}
