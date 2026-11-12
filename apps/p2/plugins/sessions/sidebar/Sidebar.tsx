// The sidebar's view, built from Elanor's sidebar and side navigation: one navigation group per rollup, in the layout
// of what it collected (its relevant sessions, groups with theirs, or only its name), and the guest's list of shared
// sessions. Every row has the same shape (Row.tsx's `NavRow`): a marker, a label, details and controls at the trailing
// end. The owner's first row opens the new-session screen. A rollup's name opens its list page, its chevron shows or
// hides its sessions; a group's row shows or hides its sessions; a session's row opens it (and shows its
// conversations), its chevron shows or hides them. It renders what model.ts computes and calls back for every action.
import { type Grant, grantMode } from "@p2/app/v1";
import {
	NavAddIcon,
	NavFolderIcon,
	NavLockIcon,
	NavMoreIcon,
	NEW_SESSION,
	PiLogo,
	Sidebar,
	SideNavigation,
	ThemeButton,
	useLinkHref,
} from "@p2/app/v1/web";
import { memo, type ReactNode, useEffect, useId, useState } from "react";
import { GlyphIcon } from "../../glyphs/GlyphIcon.tsx";
import { WorkingMark } from "./marks.tsx";
import type { Glyphs, GroupSection, NewTarget, Section, SidebarRow } from "./model.ts";
import {
	HiddenAttention,
	IconMarker,
	NavRow,
	pageRoute,
	type RowActions,
	SessionItem,
	Toggle,
	useOpenedFrom,
} from "./Row.tsx";
import "./style.css";

/** The current time, again every minute: a rollup's window passes while the sidebar is shown. */
export function useNow(): number {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 60_000);
		return () => clearInterval(timer);
	}, []);
	return now;
}

/** What a rollup's and a group's rows act with: the list shown in the main area, and the owner's actions. */
type HeadingActions = {
	/** The list shown in the main area, by its key. */
	page: string | undefined;
	connected: boolean;
	onPage: (key: string) => void;
	onCollapse?: (key: string, collapsed: boolean) => void;
	onOptions?: (key: string) => void;
	onNewIn?: (target: NewTarget) => void;
	/** The owner's project glyphs; absent: groups show a folder and sessions their working mark only. */
	glyphs?: Glyphs;
};

/**
 * A group inside a rollup: its row (its project glyph, else a folder; a lock for a sandbox; its name, "+"), which shows
 * or hides its relevant sessions below it, one step in. Its tooltip is its path (a project's: its places). Collapsed, it
 * says what its hidden sessions do: its icon framed while one works, how many failed or have a new answer.
 */
function GroupItem({ group, rows, actions }: { group: GroupSection; rows: RowActions; actions: HeadingActions }) {
	const { onCollapse, onNewIn, connected, glyphs } = actions;
	const { target } = group;
	const listId = useId();
	const glyph = target && glyphs?.target(target);
	const marker = (
		<IconMarker working={group.hidden.working > 0}>
			{group.sandboxed ? (
				<NavLockIcon size={16} aria-label="Sandbox" />
			) : glyph ? (
				<GlyphIcon seed={glyph.seed} />
			) : (
				<NavFolderIcon size={16} />
			)}
		</IconMarker>
	);
	const label = <span className="session-title">{group.name}</span>;
	return (
		<SideNavigation.Item className="sidebar-group" data-key={group.key}>
			<NavRow
				className="group-row"
				linkClassName="group-link"
				{...(onCollapse ? { expanded: !group.collapsed, controlsId: listId } : {})}
				title={group.title ?? glyph?.title}
				onActivate={() => onCollapse?.(group.key, !group.collapsed)}
				marker={marker}
				label={label}
				details={group.hidden.failed + group.hidden.unread > 0 && <HiddenAttention activity={group.hidden} />}
				controls={
					onNewIn &&
					target && (
						<button
							type="button"
							className="nav-control group-new"
							aria-label={`New session in ${group.name}`}
							title={`New session in ${group.name}`}
							disabled={!connected}
							onClick={() => onNewIn(target)}
						>
							<NavAddIcon size={16} />
						</button>
					)
				}
			/>
			<SideNavigation.List className="group-items" id={listId} hidden={group.collapsed}>
				{group.rows.map((session) => (
					<SessionItem key={session.id} session={session} scope={group.key} actions={rows} />
				))}
			</SideNavigation.List>
		</SideNavigation.Item>
	);
}

/**
 * A rollup's group of the navigation: its row (its name, a link to its list; the chevron right after it that shows or
 * hides its sessions; the Archive's count instead; its options), then its sessions or its groups by its layout, or
 * "No activity" when it has none to show. Collapsed, its row says what its hidden sessions do (it has no icon to frame:
 * a spinner while one works).
 */
function RollupGroup({ section, rows, actions }: { section: Section; rows: RowActions; actions: HeadingActions }) {
	const { page, onPage, onCollapse, onOptions, glyphs } = actions;
	const linkHref = useLinkHref();
	const listId = useId();
	const collapsed = section.layout === "link" ? undefined : section.collapsed;
	// A collapsed rollup lists nothing, whatever it has: "No activity" is for an open one with nothing to show.
	const empty =
		collapsed === false &&
		((section.layout === "sessions" && section.rows.length === 0) ||
			(section.layout === "groups" && section.groups.length === 0));
	return (
		<SideNavigation.Group className="sidebar-section" data-key={section.key}>
			<NavRow
				selected={page === section.key}
				className="rollup-row group-head"
				linkClassName="group-label"
				href={linkHref(pageRoute(section.key))}
				onActivate={() => onPage(section.key)}
				label={section.name}
				after={
					onCollapse &&
					collapsed !== undefined && (
						<Toggle
							className="section-toggle"
							open={!collapsed}
							label={`the sessions of ${section.name}`}
							controls={listId}
							onToggle={() => onCollapse(section.key, !collapsed)}
						/>
					)
				}
				details={
					section.layout === "link" ? (
						<span className="section-count">{section.total}</span>
					) : (
						section.hidden.working + section.hidden.failed + section.hidden.unread > 0 && (
							<>
								{section.hidden.working > 0 && <WorkingMark />}
								<HiddenAttention activity={section.hidden} />
							</>
						)
					)
				}
				controls={
					onOptions && (
						<button
							type="button"
							className="nav-control rollup-options"
							aria-label={`${section.name} options`}
							title="Options"
							onClick={() => onOptions(section.key)}
						>
							<NavMoreIcon size={16} />
						</button>
					)
				}
			/>
			{section.layout !== "link" && (
				<SideNavigation.List id={listId} hidden={section.collapsed}>
					{section.layout === "sessions" &&
						section.rows.map((session) => (
							<SessionItem
								key={session.id}
								session={session}
								scope={section.key}
								actions={rows}
								glyph={glyphs?.row(session)}
							/>
						))}
					{section.layout === "groups" &&
						section.groups.map((group) => (
							<GroupItem key={group.key} group={group} rows={rows} actions={actions} />
						))}
					{empty && <li className="empty-note sidebar-empty">No activity</li>}
				</SideNavigation.List>
			)}
		</SideNavigation.Group>
	);
}

/** The places of the sidebar whose rows show session `id` (rollups' and groups' keys), in the sidebar's order. */
function placesOf(sections: readonly Section[], id: string): string[] {
	return sections.flatMap((section) => {
		if (section.layout === "sessions") return section.rows.some((row) => row.id === id) ? [section.key] : [];
		if (section.layout === "groups")
			return section.groups.flatMap((group) => (group.rows.some((row) => row.id === id) ? [group.key] : []));
		return [];
	});
}

/** Memoized: the composer re-renders App on every keypress, and the session list need not follow. */
export const SidebarView = memo(function SidebarView({
	rows,
	sections,
	now,
	page,
	newSession,
	brand,
	guest,
	activeId,
	conversationId,
	connected,
	onOpen,
	onBranch,
	onRestore,
	onNew,
	onNewIn,
	glyphs,
	onOptions,
	onCollapse,
	onPage,
	onCollapseSidebar,
	footerActions,
}: {
	/** Every session the reader may see, archived ones included (the guest's list). */
	rows: readonly SidebarRow[];
	/** The sections, as `sectionsOf` computed them (the owner's). */
	sections: readonly Section[];
	/** The time the sections were computed at; rows say how long ago they were active from it. */
	now: number;
	/** The list shown in the main area, by its key. */
	page: string | undefined;
	/** Whether the new-session screen is shown. */
	newSession: boolean;
	/** The owner's header start: the Pi logo, or what a plugin puts there (the `drawer-brand` slot: the Familiar's). */
	brand: ReactNode;
	guest?: Grant;
	activeId?: string;
	conversationId: number;
	connected: boolean;
	onOpen: (id: string, conversationId?: number) => void;
	/** Switches a session to one of its `/tree` branches (the owner's). */
	onBranch?: (id: string, conversationId: number) => void;
	onRestore: (id: string, conversationId?: number) => void;
	onNew: () => void;
	/** Starts a new session in a group; absent: groups have no "+". */
	onNewIn?: (target: NewTarget) => void;
	/** The owner's project glyphs, for groups and the sessions of flat lists (Recents). */
	glyphs?: Glyphs;
	/** Opens a rollup's options (its window and place). */
	onOptions?: (key: string) => void;
	/** Shows or hides a rollup's or a group's sessions. */
	onCollapse?: (key: string, collapsed: boolean) => void;
	/** Opens a rollup's or a group's list in the main area. */
	onPage: (key: string) => void;
	onCollapseSidebar: () => void;
	/** Icon buttons at the footer's end, before the theme switch (the owner's), e.g. the Settings gear. */
	footerActions?: ReactNode;
}) {
	const linkHref = useLinkHref();
	// The open session is selected in one place only: where it was opened from, else the first place it shows.
	const openedFrom = useOpenedFrom();
	const places = activeId === undefined ? [] : placesOf(sections, activeId);
	const from = activeId === undefined ? undefined : openedFrom[activeId];
	const activeScope = from !== undefined && places.includes(from) ? from : (places[0] ?? "");
	const actions: RowActions = {
		activeId,
		activeScope,
		conversationId,
		now,
		onOpen,
		onBranch,
		onRestore,
	};
	const headings: HeadingActions = { page, connected, onPage, onCollapse, onOptions, onNewIn, glyphs };
	// p2's layout hides a collapsed sidebar, so the root is never shown collapsed: its trigger only asks for it.
	const frame = (label: string, header: ReactNode, content: ReactNode, foot: ReactNode) => (
		<Sidebar.Root
			className="drawer-content sidebar-root"
			render={<nav aria-label={label} />}
			collapsed={false}
			onCollapsedChange={(collapse) => collapse && onCollapseSidebar()}
		>
			<Sidebar.Header className="drawer-top">{header}</Sidebar.Header>
			<Sidebar.Content className="session-scroll">{content}</Sidebar.Content>
			<Sidebar.Footer className="drawer-foot">{foot}</Sidebar.Footer>
		</Sidebar.Root>
	);
	if (guest)
		return frame(
			"Shared session",
			<>
				<div className="brand">
					<PiLogo compact />
					<span>Shared session</span>
				</div>
				<p className="empty-note">
					Joined as <strong>{guest.name}</strong>
					<br />
					{/* The open session's access: sessions may be shared with a guest in different modes. */}
					{grantMode(guest, activeId) === "full" ? "Read/write" : "Read-only"}
				</p>
			</>,
			<SideNavigation.Root className="sidebar-nav" aria-label="Shared sessions">
				<SideNavigation.List>
					{rows.map((session) => (
						// A guest's list shows each session once.
						<SessionItem
							key={session.id}
							session={session}
							scope="shared"
							actions={{ ...actions, activeScope: undefined }}
						/>
					))}
				</SideNavigation.List>
			</SideNavigation.Root>,
			<>
				<span className="spacer" />
				<ThemeButton />
			</>,
		);
	return frame(
		"Sessions",
		<div className="drawer-header-row">
			<div className="brand">{brand}</div>
			<Sidebar.Trigger className="collapse-sidebar" aria-label="Collapse sidebar" />
		</div>,
		<SideNavigation.Root className="sidebar-nav" aria-label="Rollups">
			<SideNavigation.List className="sidebar-start">
				<SideNavigation.Item>
					<NavRow
						selected={newSession}
						className="group-row"
						linkClassName="new-session"
						href={linkHref(NEW_SESSION)}
						onActivate={onNew}
						marker={<NavAddIcon size={16} />}
						label="New session"
					/>
				</SideNavigation.Item>
			</SideNavigation.List>
			{sections.map((section) => (
				<RollupGroup key={section.key} section={section} rows={actions} actions={headings} />
			))}
		</SideNavigation.Root>,
		<>
			<span className="spacer" />
			{footerActions}
			<ThemeButton />
		</>,
	);
});
