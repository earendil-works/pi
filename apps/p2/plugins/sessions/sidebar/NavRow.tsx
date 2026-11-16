// One row of the sidebar and its list pages: the shape every row has. Apart from the rows of sessions (Row.tsx), so
// other plugins' web facets can show a row of their own through the sessions plugin's contract (`contract.web.tsx`).
import { type CommandTargetRow, inPage, NavDisclosureIcon, SideNavigation } from "@p2/app/v1/web";
import type { ReactNode } from "react";

/**
 * One row: a marker (a session's working mark, a group's icon; its column is kept when empty, so labels line up; absent:
 * no column, as a rollup's), the label (on one line, cut with "…" at its end), then details and controls at the
 * trailing end. The label is a link to `href`, an action without one, or with `expanded`, the control that shows or
 * hides what is below the row (its chevron right after the label). The whole row is one control: its hover and selected
 * background spans it, and the label's hit area covers it (the controls stay above it). `after`: a control right after
 * the label (a rollup's or a session's chevron, `Toggle`). `target`: the command menu's target while the row is hovered
 * or has focus (`useCommandTargetRow`), or that also opens the menu on itself (`useCommandMenuRow`).
 */
export function NavRow({
	selected = false,
	className = "",
	linkClassName = "",
	marker,
	href,
	title,
	expanded,
	controlsId,
	onActivate,
	label,
	after,
	details,
	controls,
	target,
	guides,
}: {
	selected?: boolean;
	className?: string;
	linkClassName?: string;
	/** The marker column (absent: the row has none): a mark or an icon, or `null` for its empty space. */
	marker?: ReactNode;
	/** The address the label links to; absent: the label is an action (restore, switch a branch, show or hide). */
	href?: string;
	title?: string;
	/** Whether what the row shows or hides is shown; absent: the row does not show or hide anything. */
	expanded?: boolean;
	/** The element the row shows or hides. */
	controlsId?: string;
	onActivate: () => void;
	label: ReactNode;
	after?: ReactNode;
	/** Information after the label (state, time last), not interactive. */
	details?: ReactNode;
	/** Buttons at the trailing end. */
	controls?: ReactNode;
	target?: CommandTargetRow;
	/** A tree row's connector guides (`TreeGuides`), drawn on the row outside its layout. */
	guides?: ReactNode;
}) {
	const link = `nav-link ${linkClassName} ${selected ? "active" : ""}`;
	return (
		<div className={`nav-row ${selected ? "selected" : ""} ${className}`} {...target}>
			{guides}
			{marker !== undefined && <span className="nav-marker">{marker}</span>}
			{href === undefined ? (
				<button
					type="button"
					className={link}
					title={title}
					aria-expanded={expanded}
					aria-controls={controlsId}
					onClick={onActivate}
				>
					<span className="nav-label">{label}</span>
					{expanded !== undefined && <NavDisclosureIcon className="nav-chevron" size={16} aria-hidden="true" />}
				</button>
			) : (
				<SideNavigation.Link
					className={link}
					href={href}
					title={title}
					active={selected}
					onClick={inPage(onActivate)}
				>
					<span className="nav-label">{label}</span>
				</SideNavigation.Link>
			)}
			{after}
			<span className="nav-fill" />
			{details && <span className="nav-details">{details}</span>}
			{controls}
		</div>
	);
}
