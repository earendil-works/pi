// A rollup's options sheet: how long the sidebar shows a session nothing else keeps in view, and the rollup's place;
// for a rollup made from code, when it refreshes, when it was last checked, why its last run failed, and Refresh now.
import { CheckIcon, Sheet } from "@p2/app/v1/web";
import type { Refresh } from "../../rollups/contract.ts";
import type { SidebarWindow } from "../contract.ts";
import { type Section, WINDOWS } from "./model.ts";
import { ago } from "./Row.tsx";

/** A rollup made from code as its options show it, and refreshing it (absent while offline). */
export type CodeSource = {
	readonly refresh: Refresh;
	readonly checkedAt: number | null;
	readonly error: string | null;
	readonly refreshing: boolean;
	readonly onRefresh?: () => void;
};

/** The options of rollup `section`: its window (not for a rollup shown only as a link) and moving it up or down. */
export function RollupSheet({
	section,
	code,
	now,
	onWindow,
	onMove,
	onClose,
}: {
	section: Section;
	/** Present for a rollup made from code. */
	code?: CodeSource;
	now: number;
	onWindow: (window: SidebarWindow) => void;
	/** Moves the rollup up or down; absent: it cannot move that way. */
	onMove: { up?: () => void; down?: () => void };
	onClose: () => void;
}) {
	return (
		<Sheet title={section.name} onClose={onClose}>
			<div className="list">
				{code && <CodeOptions code={code} now={now} />}
				{section.layout !== "link" && section.window !== "none" && (
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

/** When a rollup made from code refreshes, its last check or failure, and Refresh now unless it refreshes itself. */
function CodeOptions({ code, now }: { code: CodeSource; now: number }) {
	const when =
		code.refresh.kind === "auto"
			? "Refreshes when its sessions change"
			: code.refresh.kind === "every"
				? `Refreshes every ${code.refresh.minutes} min when its sessions changed`
				: "Refreshes only by hand";
	const since = code.checkedAt === null ? undefined : ago(code.checkedAt, now);
	// `ago` says "now", "5m" or "3h" up to a week, then a date.
	const checked =
		since === undefined
			? "Not run yet"
			: since === "now"
				? "Checked just now"
				: /^\d/.test(since)
					? `Checked ${since} ago`
					: `Checked on ${since}`;
	return (
		<>
			<h3 className="label">Made from code</h3>
			<p className="muted small">
				{when}. {checked}.
			</p>
			{code.error && <p className="small rollup-error">{code.error}</p>}
			{code.refresh.kind !== "auto" && (
				<button
					type="button"
					className="row-button"
					disabled={!code.onRefresh || code.refreshing}
					onClick={code.onRefresh}
				>
					<span>{code.refreshing ? "Refreshing…" : "Refresh now"}</span>
				</button>
			)}
		</>
	);
}
