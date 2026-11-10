// A rollup's options sheet: how long the sidebar shows a session nothing else keeps in view, and the rollup's place.
import { CheckIcon, Sheet } from "@p2/app/v1/web";
import type { SidebarWindow } from "../contract.ts";
import { type Section, WINDOWS } from "./model.ts";

/** The options of rollup `section`: its window (not for a rollup shown only as a link) and moving it up or down. */
export function RollupSheet({
	section,
	onWindow,
	onMove,
	onClose,
}: {
	section: Section;
	onWindow: (window: SidebarWindow) => void;
	/** Moves the rollup up or down; absent: it cannot move that way. */
	onMove: { up?: () => void; down?: () => void };
	onClose: () => void;
}) {
	return (
		<Sheet title={section.name} onClose={onClose}>
			<div className="list">
				{section.layout !== "link" && (
					<>
						<h3 className="label">Show sessions active within</h3>
						{WINDOWS.map(({ window, label }) => (
							<button
								type="button"
								key={window}
								className="row-button"
								aria-pressed={section.window === window}
								onClick={() => onWindow(window)}
							>
								<span>{label}</span>
								{section.window === window && <CheckIcon />}
							</button>
						))}
						<p className="muted small">Pinned, open, working, unread and failed sessions always show.</p>
					</>
				)}
				{onMove.up && (
					<button type="button" className="row-button" onClick={onMove.up}>
						<span>Move up</span>
					</button>
				)}
				{onMove.down && (
					<button type="button" className="row-button" onClick={onMove.down}>
						<span>Move down</span>
					</button>
				)}
			</div>
		</Sheet>
	);
}
