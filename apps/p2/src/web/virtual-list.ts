/**
 * The size model of a virtual list: where each row starts, from the rows' measured heights and an estimate for rows
 * never shown. Only the rows near the viewport are in the DOM; the rest are two spacers whose heights come from here.
 * Modeled on TanStack Virtual's measurement cache, reduced to one vertical lane of keyed rows.
 *
 * Measured heights are kept by row key in a map the caller owns, so a list rendered again (switching back to a
 * conversation) starts from the heights it had, and its spacers are exact instead of estimated.
 */
export class RowLayout {
	readonly #sizes: Map<string, number>;
	#keys: readonly string[] = [];
	#index = new Map<string, number>();
	#estimate: (index: number) => number = () => 0;
	/** `offsets[i]` is where row `i` starts; `offsets[count]` is the total height. Rebuilt lazily after a change. */
	#offsets = new Float64Array(1);
	#dirty = false;

	constructor(sizes: Map<string, number> = new Map()) {
		this.#sizes = sizes;
	}

	/** Replaces the rows; `estimate` gives the height of a row that has never been measured. */
	setRows(keys: readonly string[], estimate: (index: number) => number): void {
		this.#keys = keys;
		this.#estimate = estimate;
		this.#index = new Map(keys.map((key, index) => [key, index]));
		this.#dirty = true;
	}

	/** Estimates changed (the list's width did): offsets are computed again. */
	invalidate(): void {
		this.#dirty = true;
	}

	get count(): number {
		return this.#keys.length;
	}

	keyAt(index: number): string | undefined {
		return this.#keys[index];
	}

	indexOf(key: string): number | undefined {
		return this.#index.get(key);
	}

	/** Records a row's measured height; true when it changed. */
	measure(key: string, size: number): boolean {
		if (this.#sizes.get(key) === size) return false;
		this.#sizes.set(key, size);
		if (this.#index.has(key)) this.#dirty = true;
		return true;
	}

	/** Whether a row's height was measured (its offset below it is exact) rather than estimated. */
	measured(key: string): boolean {
		return this.#sizes.has(key);
	}

	sizeOf(index: number): number {
		const key = this.#keys[index];
		if (key === undefined) return 0;
		return this.#sizes.get(key) ?? this.#estimate(index);
	}

	/** Where row `index` starts; `count` gives the total height. */
	offsetOf(index: number): number {
		const offsets = this.#build();
		return offsets[Math.max(0, Math.min(index, this.#keys.length))] ?? 0;
	}

	get total(): number {
		return this.offsetOf(this.#keys.length);
	}

	/** The row at `offset`: the last one starting at or above it (0 above the list, the last row below it). */
	rowAt(offset: number): number {
		const offsets = this.#build();
		let low = 0;
		let high = this.#keys.length - 1;
		while (low < high) {
			const middle = (low + high + 1) >> 1;
			if ((offsets[middle] ?? 0) <= offset) low = middle;
			else high = middle - 1;
		}
		return Math.max(0, low);
	}

	/** The rows overlapping `[top, bottom)`, at least one while there are rows; undefined for an empty list. */
	range(top: number, bottom: number): { start: number; end: number } | undefined {
		const count = this.#keys.length;
		if (count === 0) return undefined;
		const start = this.rowAt(top);
		// A row starting exactly at `bottom` is outside.
		const end = this.rowAt(Math.max(top, bottom - 0.001));
		return { start, end: Math.max(start, end) };
	}

	#build(): Float64Array {
		if (!this.#dirty) return this.#offsets;
		const count = this.#keys.length;
		const offsets = this.#offsets.length === count + 1 ? this.#offsets : new Float64Array(count + 1);
		let offset = 0;
		for (let index = 0; index < count; index++) {
			offsets[index] = offset;
			offset += this.sizeOf(index);
		}
		offsets[count] = offset;
		this.#offsets = offsets;
		this.#dirty = false;
		return offsets;
	}
}

/** Measured row heights of recently shown lists, by list (a conversation), the most recently used last. */
const kept = new Map<string, Map<string, number>>();
const KEPT_LISTS = 8;

/** Starts list `key` from heights measured before (kept on the device); heights it measured since stay. */
export function seedSizes(key: string, sizes: Iterable<readonly [string, number]>): void {
	const kept = keptSizes(key);
	for (const [row, size] of sizes) if (!kept.has(row)) kept.set(row, size);
}

/** The measured heights of list `key`, kept across its renders (a few lists at a time). */
export function keptSizes(key: string): Map<string, number> {
	const sizes = kept.get(key) ?? new Map<string, number>();
	kept.delete(key);
	kept.set(key, sizes);
	for (const old of kept.keys()) {
		if (kept.size <= KEPT_LISTS) break;
		kept.delete(old);
	}
	return sizes;
}
