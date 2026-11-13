/** Something with a layout box, such as a transcript block. */
export type Box = { getBoundingClientRect(): { top: number; bottom: number } };

/**
 * The first `count` blocks not entirely above `top`, with their tops: the scroll anchor that keeps a reader's place
 * while content above changes. Several candidates, because the top block can disappear (a tool result merging into its
 * call's card once an older page arrives). Blocks are stacked top to bottom, so a binary search finds the first one in
 * about log2(n) layout reads instead of one per block: reading every block's rectangle in a long session cost hundreds
 * of milliseconds, on every resize.
 */
export function firstVisibleBlocks<T extends Box>(
	blocks: readonly T[],
	top: number,
	count = 4,
): { element: T; top: number }[] {
	let low = 0;
	let high = blocks.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if ((blocks[middle]?.getBoundingClientRect().bottom ?? top) <= top) low = middle + 1;
		else high = middle;
	}
	return blocks.slice(low, low + count).map((element) => ({ element, top: element.getBoundingClientRect().top }));
}
