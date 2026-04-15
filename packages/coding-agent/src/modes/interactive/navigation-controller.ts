import type { Component, Container, TUI } from "@mariozechner/pi-tui";
import type {
	AnchorRegistration,
	AnchorResolver,
	NavigationAlign,
	NavigationResult,
	NavigationTarget,
	ViewportSnapshot,
	ViewportState,
} from "../../core/extensions/types.js";
import type { SessionContext, SessionEntry } from "../../core/session-manager.js";

type ComponentRange = { start: Component; end: Component };

export class NavigationController {
	private customAnchors = new Map<string, AnchorRegistration["resolve"]>();
	private runtimeAnchors = new Map<string, AnchorRegistration["resolve"]>();
	private pendingEntryRanges: ComponentRange[] = [];
	private streamingEntryRange: ComponentRange | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly headerContainer: Container,
		private readonly chatContainer: Container,
	) {}

	registerAnchor(anchor: AnchorRegistration): () => void {
		this.customAnchors.set(anchor.id, anchor.resolve);
		return () => {
			const current = this.customAnchors.get(anchor.id);
			if (current === anchor.resolve) {
				this.customAnchors.delete(anchor.id);
			}
		};
	}

	clearRuntimeAnchors(): void {
		this.runtimeAnchors.clear();
		this.pendingEntryRanges = [];
		this.streamingEntryRange = undefined;
	}

	addRenderedRange(range: ComponentRange, entryId?: string): void {
		if (entryId) {
			this.setEntryRange(entryId, range);
			return;
		}
		this.pendingEntryRanges.push(range);
	}

	setEntryRange(entryId: string, range: ComponentRange): void {
		const anchorId = this.getEntryAnchorId(entryId);
		this.runtimeAnchors.set(anchorId, () => ({ kind: "range", start: range.start, end: range.end }));
	}

	beginStreamingRange(component: Component): void {
		this.streamingEntryRange = { start: component, end: component };
	}

	extendStreamingRange(component: Component): void {
		if (this.streamingEntryRange) {
			this.streamingEntryRange.end = component;
		}
	}

	completeStreamingRange(): void {
		if (this.streamingEntryRange) {
			this.pendingEntryRanges.push(this.streamingEntryRange);
			this.streamingEntryRange = undefined;
		}
	}

	bindPendingEntryRanges(sessionContext: SessionContext): void {
		if (this.pendingEntryRanges.length === 0) {
			return;
		}

		const unmappedEntries = sessionContext.entries.filter(
			(entry) => this.canBindPendingEntryRange(entry) && !this.runtimeAnchors.has(this.getEntryAnchorId(entry.id)),
		);
		if (unmappedEntries.length === 0) {
			this.pendingEntryRanges = [];
			return;
		}

		const assignableCount = Math.min(unmappedEntries.length, this.pendingEntryRanges.length);
		const entrySlice = unmappedEntries.slice(-assignableCount);
		const rangeSlice = this.pendingEntryRanges.slice(-assignableCount);

		for (const [index, entry] of entrySlice.entries()) {
			this.setEntryRange(entry.id, rangeSlice[index]);
		}

		this.pendingEntryRanges.splice(this.pendingEntryRanges.length - assignableCount, assignableCount);
	}

	navigateTo(target: NavigationTarget, options?: { align?: NavigationAlign }): NavigationResult {
		const align = options?.align ?? "start";
		const resolved = this.resolveTarget(target);
		if (!resolved) {
			return { success: false, error: this.getMissingTargetError(target) };
		}

		const row = this.resolveTargetRow(resolved, align);
		if (row === undefined) {
			return { success: false, error: this.getMissingTargetError(target) };
		}

		const state = this.tui.getViewportState();
		const maxTop = Math.max(0, state.totalRows - state.height);
		const requestedTop =
			align === "end"
				? row - state.height + 1
				: align === "center"
					? row - Math.floor(state.height / 2)
					: align === "nearest"
						? row < state.topRow
							? row
							: row >= state.topRow + state.height
								? row - state.height + 1
								: state.topRow
						: row;
		const clampedTop = Math.max(0, Math.min(requestedTop, maxTop));

		this.tui.scrollToRow(row, { align });
		return {
			success: true,
			targetRow: row,
			clamped: requestedTop !== clampedTop,
		};
	}

	scrollToEntry(entryId: string, options?: { align?: "start" | "end" }): NavigationResult {
		return this.navigateTo({ kind: "entry", id: entryId }, options);
	}

	scrollToBottom(): void {
		this.tui.followBottom();
	}

	getViewportState(): ViewportState {
		return this.tui.getViewportState();
	}

	captureViewport(): ViewportSnapshot {
		return this.tui.captureViewport();
	}

	restoreViewport(snapshot: ViewportSnapshot): void {
		this.tui.restoreViewport(snapshot);
	}

	private resolveTarget(target: NavigationTarget): AnchorResolver | undefined {
		if (target.kind === "row") {
			return { kind: "row", row: target.row };
		}

		const anchorId = target.kind === "entry" ? this.getEntryAnchorId(target.id) : target.id;
		const resolver = this.runtimeAnchors.get(anchorId) ?? this.customAnchors.get(anchorId);
		return resolver?.();
	}

	private resolveTargetRow(target: AnchorResolver, align: NavigationAlign): number | undefined {
		if (target.kind === "row") {
			return target.row;
		}
		if (target.kind === "component") {
			return this.getComponentRow(target.component, align);
		}

		if (align === "end") {
			return this.getComponentRow(target.end, "end");
		}
		if (align === "center") {
			const start = this.getComponentRow(target.start, "start");
			const end = this.getComponentRow(target.end, "end");
			if (start === undefined || end === undefined) {
				return undefined;
			}
			return Math.floor((start + end) / 2);
		}
		if (align === "nearest") {
			const start = this.getComponentRow(target.start, "start");
			const end = this.getComponentRow(target.end, "end");
			if (start === undefined || end === undefined) {
				return undefined;
			}
			const viewport = this.tui.getViewportState();
			if (end < viewport.topRow) {
				return start;
			}
			if (start >= viewport.topRow + viewport.height) {
				return end;
			}
			return start;
		}
		return this.getComponentRow(target.start, "start");
	}

	private getComponentRow(component: Component, align: "start" | "end"): number | undefined {
		const width = this.tui.terminal.columns;
		let row = this.headerContainer.render(width).length;
		for (const child of this.chatContainer.children) {
			const childHeight = child.render(width).length;
			if (child === component) {
				return align === "end" ? row + Math.max(0, childHeight - 1) : row;
			}
			row += childHeight;
		}
		return undefined;
	}

	private getMissingTargetError(target: NavigationTarget): string {
		if (target.kind === "entry") {
			return `Entry '${target.id}' is not currently rendered`;
		}
		if (target.kind === "anchor") {
			return `Anchor '${target.id}' is not currently available`;
		}
		return `Row '${target.row}' is not currently available`;
	}

	private getEntryAnchorId(entryId: string): string {
		return `entry:${entryId}`;
	}

	private canBindPendingEntryRange(entry: SessionEntry): boolean {
		if (entry.type === "custom_message" || entry.type === "branch_summary" || entry.type === "compaction") {
			return true;
		}
		return entry.type === "message" && entry.message.role !== "toolResult";
	}
}
