// When a Durable commit should reach a sync remote soon, for Chord's `FlushScheduler` (`@earendil-works/chord/sync`).

import type { CommitPublication } from "./types.ts";

/** Whether a commit should reach the remote soon: what the user typed, a finished answer, a settled submission. */
export function isUrgentCommit(publication: CommitPublication): boolean {
	return publication.changes.some(
		(change) =>
			(change.type === "entry" && (change.value.kind === "pi.user" || change.value.kind === "pi.assistant")) ||
			(change.type === "submission" && (change.value.status === "done" || change.value.status === "unanswered")),
	);
}
