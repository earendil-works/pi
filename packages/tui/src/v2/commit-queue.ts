import { hardWrapStyledLine, styledLineToAnsi } from "./ansi.ts";
import type { LedgerCommit } from "./ledger.ts";

/**
 * Buffers ledger commits as ready-to-write serialized scrollback lines.
 *
 * Applies the one-time width safety / hard wrap and ANSI serialization for each committed line
 * exactly once (plan §3), preserving commit order. The Presenter drains this queue at band top so
 * each committed line is emitted a single time into terminal scrollback.
 */
export class LedgerCommitQueue {
	private readonly lines: string[] = [];

	/** Serialize and enqueue committed lines at the given render width, preserving order. */
	enqueue(commits: readonly LedgerCommit[], width: number): void {
		for (const commit of commits) {
			for (const line of commit.lines) {
				for (const visual of hardWrapStyledLine(line, width)) {
					this.lines.push(styledLineToAnsi(visual));
				}
			}
		}
	}

	get pending(): number {
		return this.lines.length;
	}

	/**
	 * Remove and return pending serialized lines in commit order. With a positive `limit`, drains at
	 * most that many lines so a single frame's commit write stays bounded (plan §2 frontier budget);
	 * remaining lines are left for the next frame. Without a limit, drains everything.
	 */
	flush(limit?: number): string[] {
		if (this.lines.length === 0) return [];
		const count = limit === undefined || limit <= 0 ? this.lines.length : Math.min(limit, this.lines.length);
		return this.lines.splice(0, count);
	}
}
