import { StorageRequestError } from "../errors.ts";
import type { Id, ScanOrder } from "../types.ts";

/** Where a built-in storage scan starts: its order and the last ID a previous page returned. */
export type ScanStart = {
	readonly order: ScanOrder;
	readonly after: number | undefined;
};

/**
 * Resolve a scan's order and position. A cursor continues in the order it was created with, whether the query repeats
 * that order or omits it; a different `order` throws. A cursor without an order, written before scans had one,
 * continues in the scan's default order.
 */
export function scanStart(
	requested: ScanOrder | undefined,
	cursor: Readonly<Record<string, unknown>> | undefined,
	fallback: ScanOrder,
): ScanStart {
	if (requested !== undefined && requested !== "ascending" && requested !== "descending") {
		throw new StorageRequestError(`Invalid scan order: ${String(requested)}`);
	}
	if (cursor === undefined) return { order: requested ?? fallback, after: undefined };
	const { after, order: stored } = cursor;
	if (typeof after !== "number" || !Number.isSafeInteger(after))
		throw new StorageRequestError("Invalid storage cursor");
	if (stored !== undefined && stored !== "ascending" && stored !== "descending") {
		throw new StorageRequestError("Invalid storage cursor");
	}
	const order = stored ?? fallback;
	if (requested !== undefined && requested !== order) {
		throw new StorageRequestError(`The cursor continues a ${order} scan; the query asks for ${requested}`);
	}
	return { order, after };
}

/** The continuation of a scan whose last returned item has `id`. */
export function nextCursor(id: Id<string>, order: ScanOrder): { readonly after: number; readonly order: ScanOrder } {
	return { after: id, order };
}
