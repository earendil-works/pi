// How stored ticks read at a kind's ticks version now (item 105): a grant's rows written at an older ticks version go
// through the kind's `migrateTicks`, the rows of one party, source and `gives` value together as one list (decision
// table 112), so a migration that merges or splits ticks sees them all. The index reads rows so (`reader.ts`), and the
// store writes them back so on their next write (`store.ts`).

import type { KindInfo } from "./kind.ts";

/**
 * `ticks`, written at ticks version `from` of `info`'s kind, as its ticks version now. Throws when they cannot be read:
 * a newer version (the plugin went back), or a migration that throws (plugin code: the caller refuses the rows, never
 * fails a read; open item 33). A kind with `ticksVersion` above 1 always has `migrateTicks` (`defineThing` refuses
 * one without it).
 */
export function ticksNow(info: KindInfo, ticks: readonly string[], from: number): readonly string[] {
	if (from === info.ticksVersion) return ticks;
	const at = `written at ${info.name}'s ticks version ${from}, the kind's is ${info.ticksVersion}`;
	if (from > info.ticksVersion) throw new Error(`${at}: newer (the plugin went back)`);
	return info.migrateTicks!(ticks, from);
}
