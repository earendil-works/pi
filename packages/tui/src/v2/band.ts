import type { Signal } from "./signal.ts";
import type { StyledLine } from "./styles.ts";

export interface PaintRegion {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	putText(x: number, y: number, line: StyledLine): void;
}

export interface FrameContext {
	readonly now: number;
}

export interface BandHost {
	requestFrame(force?: boolean): void;
	scheduleAnimation(callback: () => void, intervalMs: number): () => void;
}

/** A retained full-width strip with immediate-mode painting. */
export interface Strip {
	measure(width: number): number;
	paint(region: PaintRegion, context: FrameContext): void;
	readonly onDirty: Signal<void>;
	readonly onLayoutDirty: Signal<void>;
	mount?(host: BandHost): void;
	unmount?(): void;
}

export interface StripPolicy {
	/** Lower values shrink before higher values. */
	priority: number;
	minHeight?: number;
	maxHeight?: number;
}

export interface StripSlot {
	readonly id: string;
	readonly strip: Strip;
	readonly policy: StripPolicy;
}

export interface StripGeometry {
	readonly slot: StripSlot;
	readonly y: number;
	readonly height: number;
}

export interface BandGeometry {
	readonly width: number;
	readonly height: number;
	readonly strips: readonly StripGeometry[];
}

function nonNegativeInteger(value: number): number {
	return Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
}

/** Owns the band's one-dimensional constraints, sizes, and offsets. */
export class BandLayout {
	layout(slots: readonly StripSlot[], width: number, viewportRows: number): BandGeometry {
		const resolvedWidth = Math.max(1, nonNegativeInteger(width));
		const availableRows = nonNegativeInteger(viewportRows);
		const heights = slots.map((slot) => {
			const measured = nonNegativeInteger(slot.strip.measure(resolvedWidth));
			const maximum = slot.policy.maxHeight === undefined ? measured : nonNegativeInteger(slot.policy.maxHeight);
			return Math.min(measured, maximum);
		});
		let excess = Math.max(0, heights.reduce((sum, height) => sum + height, 0) - availableRows);
		const shrinkOrder = slots
			.map((slot, index) => ({ slot, index }))
			.sort((left, right) => left.slot.policy.priority - right.slot.policy.priority || left.index - right.index);

		for (const { slot, index } of shrinkOrder) {
			if (excess === 0) break;
			const minimum = Math.min(heights[index] ?? 0, nonNegativeInteger(slot.policy.minHeight ?? 0));
			const shrink = Math.min(excess, (heights[index] ?? 0) - minimum);
			heights[index] = (heights[index] ?? 0) - shrink;
			excess -= shrink;
		}
		// If declared minima cannot fit, preserve the same priority order and clip rather than overflow.
		for (const { index } of shrinkOrder) {
			if (excess === 0) break;
			const shrink = Math.min(excess, heights[index] ?? 0);
			heights[index] = (heights[index] ?? 0) - shrink;
			excess -= shrink;
		}

		let y = 0;
		const strips = slots.map((slot, index): StripGeometry => {
			const height = heights[index] ?? 0;
			const geometry = { slot, y, height };
			y += height;
			return geometry;
		});
		return { width: resolvedWidth, height: y, strips };
	}
}
