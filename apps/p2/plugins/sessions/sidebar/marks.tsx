// The state marks of sidebar rows, apart from the rows (which show project glyphs) so other plugins' web facets can
// show them through the sessions plugin's contract (`contract.web.tsx`) with nothing but React.
import type { SidebarRow } from "./model.ts";

/**
 * A run's mark where its row has no icon: a hollow ring while idle (decoration: the row says its state in words), a
 * spinner in the same box while it works (a still ¾ ring with reduced motion), so nothing moves as it starts or ends.
 */
export function RunMark({ state }: { state: "idle" | "working" }) {
	return state === "working" ? (
		<span className="run-mark" data-state="working" role="img" aria-label="Working" title="Working" />
	) : (
		<span className="run-mark" data-state="idle" aria-hidden="true" />
	);
}

/** A conversation running a turn where its row has no icon: the spinner. */
export function WorkingMark() {
	return <RunMark state="working" />;
}

/** An answer the owner has not read: a steady blue dot. */
export function UnreadMark() {
	return <span className="unread-dot" role="img" aria-label="New answer" title="New answer" />;
}

/** The Familiar's corner mark: working (the spinner), else an unread answer (the dot), else nothing. */
export function SessionDot({ worker }: { worker: SidebarRow["worker"] }) {
	if (worker.busy.length) return <WorkingMark />;
	if (worker.unread) return <UnreadMark />;
	return null;
}
