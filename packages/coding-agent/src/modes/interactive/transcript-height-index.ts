const MAX_TOTAL_HEIGHT = Number.MAX_SAFE_INTEGER;

function assertHeight(height: number): void {
	if (!Number.isFinite(height) || !Number.isInteger(height) || height < 0) {
		throw new RangeError(`Height must be a non-negative finite integer, received ${height}`);
	}
}

/** Exact transcript block heights with logarithmic prefix and row lookup. */
export class TranscriptHeightIndex {
	private heights: number[] = [];
	private tree: number[] = [0];
	private totalHeight = 0;

	constructor(heights: readonly number[] = []) {
		this.replace(heights);
	}

	get length(): number {
		return this.heights.length;
	}

	get total(): number {
		return this.totalHeight;
	}

	replace(heights: readonly number[]): void {
		const nextHeights: number[] = [];
		let nextTotal = 0;
		for (const height of heights) {
			assertHeight(height);
			if (height > MAX_TOTAL_HEIGHT - nextTotal) {
				throw new RangeError("Total height exceeds Number.MAX_SAFE_INTEGER");
			}
			nextHeights.push(height);
			nextTotal += height;
		}

		const nextTree = new Array<number>(nextHeights.length + 1).fill(0);
		for (let treeIndex = 1; treeIndex < nextTree.length; treeIndex++) {
			nextTree[treeIndex] += nextHeights[treeIndex - 1] ?? 0;
			const parent = treeIndex + (treeIndex & -treeIndex);
			if (parent < nextTree.length) {
				nextTree[parent] += nextTree[treeIndex] ?? 0;
			}
		}

		this.heights = nextHeights;
		this.tree = nextTree;
		this.totalHeight = nextTotal;
	}

	append(height: number): void {
		assertHeight(height);
		if (height > MAX_TOTAL_HEIGHT - this.totalHeight) {
			throw new RangeError("Total height exceeds Number.MAX_SAFE_INTEGER");
		}

		const treeIndex = this.heights.length + 1;
		const rangeStart = treeIndex - (treeIndex & -treeIndex);
		const nodeTotal = this.prefixSum(treeIndex - 1) - this.prefixSum(rangeStart) + height;
		this.heights.push(height);
		this.tree.push(nodeTotal);
		this.totalHeight += height;
	}

	/** Remove a suffix without rebuilding unaffected Fenwick nodes. */
	truncate(length: number): void {
		if (!Number.isInteger(length) || length < 0 || length > this.heights.length) {
			throw new RangeError(`Truncate length out of bounds: ${length}`);
		}
		while (this.heights.length > length) {
			this.totalHeight -= this.heights.pop() ?? 0;
			this.tree.pop();
		}
	}

	update(index: number, height: number): void {
		this.updateMany([{ index, height }]);
	}

	/** Apply point updates atomically after validating every index, height, and the final total. */
	updateMany(updates: readonly { index: number; height: number }[]): void {
		const seen = new Set<number>();
		const validated: Array<{ index: number; height: number; delta: number }> = [];
		let nextTotal = this.totalHeight;
		for (const update of updates) {
			if (!Number.isInteger(update.index) || update.index < 0 || update.index >= this.heights.length) {
				throw new RangeError(`Block index out of bounds: ${update.index}`);
			}
			if (seen.has(update.index)) throw new RangeError(`Duplicate block update: ${update.index}`);
			seen.add(update.index);
			assertHeight(update.height);
			const delta = update.height - (this.heights[update.index] ?? 0);
			nextTotal += delta;
			validated.push({ ...update, delta });
		}
		if (!Number.isSafeInteger(nextTotal) || nextTotal < 0 || nextTotal > MAX_TOTAL_HEIGHT) {
			throw new RangeError("Total height exceeds Number.MAX_SAFE_INTEGER");
		}

		for (const update of validated) {
			this.heights[update.index] = update.height;
			for (let treeIndex = update.index + 1; treeIndex < this.tree.length; treeIndex += treeIndex & -treeIndex) {
				this.tree[treeIndex] = (this.tree[treeIndex] ?? 0) + update.delta;
			}
		}
		this.totalHeight = nextTotal;
	}

	prefixSum(endExclusive: number): number {
		if (!Number.isInteger(endExclusive) || endExclusive < 0 || endExclusive > this.heights.length) {
			throw new RangeError(`Prefix end out of bounds: ${endExclusive}`);
		}

		let sum = 0;
		for (let treeIndex = endExclusive; treeIndex > 0; treeIndex -= treeIndex & -treeIndex) {
			sum += this.tree[treeIndex] ?? 0;
		}
		return sum;
	}

	/** Returns the block containing row, or length when row is at or beyond total. */
	blockAtRow(row: number): number {
		if (!Number.isSafeInteger(row) || row < 0) {
			throw new RangeError(`Row must be a non-negative safe integer, received ${row}`);
		}
		if (row >= this.totalHeight) {
			return this.heights.length;
		}

		let blockIndex = 0;
		let prefix = 0;
		let step = 1;
		while (step * 2 <= this.heights.length) {
			step *= 2;
		}
		while (step > 0) {
			const nextIndex = blockIndex + step;
			const nextPrefix = prefix + (this.tree[nextIndex] ?? 0);
			if (nextIndex <= this.heights.length && nextPrefix <= row) {
				blockIndex = nextIndex;
				prefix = nextPrefix;
			}
			step = Math.floor(step / 2);
		}
		return blockIndex;
	}
}
