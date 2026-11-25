// The trace viewer's clocks: a page's spans come with the page's clock, which may be off by seconds against the
// server's; a trace's page spans are moved onto the server's clock by its own spans under them.

import type { StoredSpan } from "@todo/app/v1/server";

/**
 * `spans` with the page's moved onto the server's clock: a page's clock may be off by seconds, so its spans are moved
 * by the least amount that puts each server span under a page span inside it (`skewOf`); none without such a pair.
 */
export function clamped(spans: readonly StoredSpan[]): readonly StoredSpan[] {
	const skew = skewOf(spans);
	if (skew === 0) return spans;
	return spans.map((span) =>
		hostOf(span) === "browser" ? { ...span, startedMs: span.startedMs + skew, endedMs: span.endedMs + skew } : span,
	);
}

/**
 * The shift of the page's spans closest to none that puts every server child of a page span inside it: at least each
 * child's end past its parent's, at most each child's start past its parent's (centred when no shift fits both: a
 * child longer than its parent).
 */
function skewOf(spans: readonly StoredSpan[]): number {
	const byId = new Map(spans.map((span) => [span.id, span]));
	let least = Number.NEGATIVE_INFINITY;
	let most = Number.POSITIVE_INFINITY;
	for (const child of spans) {
		const parent = child.parentId === undefined ? undefined : byId.get(child.parentId);
		if (parent === undefined || hostOf(parent) !== "browser" || hostOf(child) === "browser") continue;
		least = Math.max(least, child.endedMs - parent.endedMs);
		most = Math.min(most, child.startedMs - parent.startedMs);
	}
	if (least === Number.NEGATIVE_INFINITY) return 0;
	if (least > most) return (least + most) / 2;
	return Math.min(Math.max(0, least), most);
}

/** The host that recorded `span`, as every span of Chord's names it (`chord.host`). */
export function hostOf(span: StoredSpan): string | undefined {
	const host = span.attributes["chord.host"];
	return typeof host === "string" ? host : undefined;
}
