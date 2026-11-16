// The state marks of sidebar rows, apart from the rows (which show project glyphs) so other plugins' web facets can
// show them through the sessions plugin's contract (`contract.web.tsx`) with nothing but React.
import type { ReactNode } from "react";

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

/**
 * A row's 16px icon (a project glyph, a folder, a lock, a branch), framed while `working`: a rounded frame just outside
 * the icon, clear of its corners, whose dash travels around it (a still dashed frame with reduced motion).
 */
export function IconMarker({ working, children }: { working: boolean; children: ReactNode }) {
	return (
		<span className={`nav-icon ${working ? "working" : ""}`}>
			{children}
			{working && (
				<svg className="working-frame" viewBox="0 0 22 22" role="img" aria-label="Working">
					<title>Working</title>
					<rect className="working-frame-track" {...FRAME} />
					<rect className="working-frame-dash" {...FRAME} />
				</svg>
			)}
		</span>
	);
}

/** The frame's outline: 22px around a 16px icon, its 1.5px stroke inside the box; one unit per percent of its length. */
const FRAME = { x: 0.75, y: 0.75, width: 20.5, height: 20.5, rx: 5.5, pathLength: 100 } as const;
