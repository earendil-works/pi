// The status marks of sidebar items, apart from the rows so other plugins' web facets (the Familiar's row, the command
// menu's conversations) can show them through the sessions plugin's contract (`contract.web.tsx`) with nothing but
// React.
import { type ReactNode, useState } from "react";

/** The frames of pi's working indicator (the terminal UI's loader, `packages/tui`'s `Loader`). */
const PI_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** One cycle of the frames: style.css's `pi-dots` animation. */
const PI_CYCLE_MS = 1600;

/**
 * Working, as pi's terminal UI shows it: its braille dots, stepped by CSS through a strip of its frames (one frame
 * shows at a time; no timer per row). Slow and in the secondary colour, so a list of running agents stays calm; still
 * on its first frame with reduced motion. Each starts where the page's clock is in the cycle, so all of them step
 * together.
 */
export function PiDots() {
	const [phase] = useState(() => `${-(performance.now() % PI_CYCLE_MS)}ms`);
	return (
		<span className="pi-dots" role="img" aria-label="Working" title="Working">
			<span className="pi-dots-strip" style={{ animationDelay: phase }} aria-hidden="true">
				{PI_FRAMES.map((frame) => (
					<span key={frame}>{frame}</span>
				))}
			</span>
		</span>
	);
}

/** An answer the owner has not read: a steady blue dot. */
export function UnreadMark() {
	return <span className="unread-dot" role="img" aria-label="New answer" title="New answer" />;
}

/** A failure that wants the owner (a worker, an operation or a run that failed): a steady dot in the error colour. */
export function FailedDot({ title }: { title: string }) {
	return <span className="failed-dot" role="img" aria-label={title} title={title} />;
}

/**
 * A row's 16px icon (the Familiar's logo), framed while `working`: a rounded frame just outside the icon,
 * clear of its corners, whose dash travels around it (a still dashed frame with reduced motion).
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
