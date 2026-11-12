// The state marks of sidebar rows, apart from the rows (which show project glyphs) so other plugins' web facets can
// show them through the sessions plugin's contract (`contract.web.tsx`) with nothing but React.
import type { SidebarRow } from "./model.ts";

/** A conversation running a turn where its row has no icon: a small spinner (a still ¾ ring with reduced motion). */
export function WorkingMark() {
	return <span className="working-mark" role="img" aria-label="Working" title="Working" />;
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
