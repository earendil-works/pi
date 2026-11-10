// The sidebar's view, built from Elanor's sidebar and side navigation: one navigation group per rollup, in the layout
// of what it collected (its relevant sessions, groups with theirs, or only its name), and the guest's list of shared
// sessions. A rollup's or a group's name opens its list in the main area; a rollup's arrow shows or hides its sessions.
// It renders what model.ts computes and calls back for every action.
import { type Grant, grantMode } from "@p2/app/v1";
import {
	ChevronIcon,
	FolderIcon,
	MoreIcon,
	PiLogo,
	PlusIcon,
	Sidebar,
	SideNavigation,
	ThemeButton,
} from "@p2/app/v1/web";
import { memo, type ReactNode, useEffect, useState } from "react";
import type { GroupSection, Section, SidebarRow } from "./model.ts";
import { inPage, pageHref, type RowActions, SessionItem, useOpenedFrom } from "./Row.tsx";
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

/** What a rollup's heading and its groups act with: the list shown in the main area, and the owner's actions. */
type HeadingActions = {
	/** The list shown in the main area, by its key. */
	page: string | undefined;
	connected: boolean;
	onPage: (key: string) => void;
	onCollapse?: (key: string, collapsed: boolean) => void;
	onOptions?: (key: string) => void;
	onNewIn?: (group: GroupSection) => void;
};

/** A group inside a rollup: a link to its list (with "+"), and its relevant sessions below it. */
function GroupItem({ group, rows, actions }: { group: GroupSection; rows: RowActions; actions: HeadingActions }) {
	const { page, onPage, onNewIn, connected } = actions;
	return (
		<SideNavigation.Item className="sidebar-group" data-key={group.key}>
			<div className="group-row">
				<SideNavigation.Link
					className="group-link"
					href={pageHref(group.key)}
					active={page === group.key}
					title={group.title}
					iconStart={<FolderIcon size={14} />}
					onClick={inPage(() => onPage(group.key))}
				>
					{group.name}
				</SideNavigation.Link>
				{onNewIn && (
					<button
						type="button"
						className="group-new"
						aria-label={`New session in ${group.name}`}
						title={`New session in ${group.name}`}
						disabled={!connected}
						onClick={() => onNewIn(group)}
					>
						<PlusIcon size={14} />
					</button>
				)}
			</div>
			<SideNavigation.List className="nested-items">
				{group.rows.map((session) => (
					<SessionItem key={session.id} session={session} scope={group.key} actions={rows} />
				))}
			</SideNavigation.List>
		</SideNavigation.Item>
	);
}

/**
 * A rollup's group of the navigation: its label (an arrow that shows or hides its sessions, its name, which opens its
 * list, its options), then its sessions or its groups, by its layout.
 */
function RollupGroup({ section, rows, actions }: { section: Section; rows: RowActions; actions: HeadingActions }) {
	const { page, onPage, onCollapse, onOptions } = actions;
	const collapsed = section.layout === "link" ? undefined : section.collapsed;
	return (
		<SideNavigation.Group className="sidebar-section" data-key={section.key}>
			<SideNavigation.GroupLabel className={`group-head ${page === section.key ? "active" : ""}`}>
				{onCollapse && collapsed !== undefined && (
					<button
						type="button"
						className="section-toggle"
						aria-label={`${collapsed ? "Show" : "Hide"} the sessions of ${section.name}`}
						aria-expanded={!collapsed}
						onClick={() => onCollapse(section.key, !collapsed)}
					>
						<span className={`chev ${collapsed ? "" : "open"}`}>
							<ChevronIcon size={12} />
						</span>
					</button>
				)}
				<a className="group-label" href={pageHref(section.key)} onClick={inPage(() => onPage(section.key))}>
					{section.name}
				</a>
				{section.layout === "link" && <span className="section-count">{section.total}</span>}
				{onOptions && (
					<button
						type="button"
						className="group-new"
						aria-label={`${section.name} options`}
						title="Options"
						onClick={() => onOptions(section.key)}
					>
						<MoreIcon />
					</button>
				)}
			</SideNavigation.GroupLabel>
			{section.layout === "sessions" && (
				<SideNavigation.List>
					{section.rows.map((session) => (
						<SessionItem key={session.id} session={session} scope={section.key} actions={rows} />
					))}
					{!section.collapsed && section.total === 0 && (
						<li className="empty-note sidebar-empty">No sessions yet.</li>
					)}
				</SideNavigation.List>
			)}
			{section.layout === "groups" && (
				<SideNavigation.List>
					{section.groups.map((group) => (
						<GroupItem key={group.key} group={group} rows={rows} actions={actions} />
					))}
				</SideNavigation.List>
			)}
		</SideNavigation.Group>
	);
}

/** The keys of the rollups and groups whose sidebar rows show session `id`, in the sidebar's order. */
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
	head,
	guest,
	activeId,
	conversationId,
	connected,
	onOpen,
	onBranch,
	onRenameBranch,
	onRestore,
	onNew,
	onNewIn,
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
	/** Entries above the rollups (plugins' `drawer-head` slots, e.g. the Familiar's). */
	head?: ReactNode;
	guest?: Grant;
	activeId?: string;
	conversationId: number;
	connected: boolean;
	onOpen: (id: string, conversationId?: number) => void;
	/** Switches a session to one of its `/tree` branches (the owner's). */
	onBranch?: (id: string, conversationId: number) => void;
	/** Asks for a new label of one of a session's `/tree` branches (the owner's). */
	onRenameBranch?: (id: string, conversationId: number) => void;
	onRestore: (id: string, conversationId?: number) => void;
	onNew: () => void;
	/** Starts a new session in a group; absent: groups have no "+". */
	onNewIn?: (group: GroupSection) => void;
	/** Opens a rollup's options (its window and place). */
	onOptions?: (key: string) => void;
	/** Shows or hides a rollup's sessions. */
	onCollapse?: (key: string, collapsed: boolean) => void;
	/** Opens a rollup's or a group's list in the main area. */
	onPage: (key: string) => void;
	onCollapseSidebar: () => void;
	/** Icon buttons at the footer's end, before the theme switch (the owner's), e.g. the Settings gear. */
	footerActions?: ReactNode;
}) {
	// The open session is selected in one place only: where it was opened from, else the first place it shows.
	const openedFrom = useOpenedFrom();
	const places = activeId === undefined ? [] : placesOf(sections, activeId);
	const activeScope = openedFrom !== undefined && places.includes(openedFrom) ? openedFrom : (places[0] ?? "");
	const actions: RowActions = {
		activeId,
		activeScope,
		conversationId,
		now,
		onOpen,
		onBranch,
		onRenameBranch,
		onRestore,
	};
	// A guest's list shows each session once.
	const guestActions: RowActions = { ...actions, activeScope: undefined };
	const headings: HeadingActions = { page, connected, onPage, onCollapse, onOptions, onNewIn };
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
						<SessionItem key={session.id} session={session} scope="shared" actions={guestActions} />
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
			<div className="brand">
				<PiLogo compact />
			</div>
			<div className="drawer-actions">
				<button type="button" className="new-session" onClick={onNew} disabled={!connected}>
					<PlusIcon size={16} />
					<span>New session</span>
				</button>
				<Sidebar.Trigger className="collapse-sidebar" aria-label="Collapse sidebar" />
			</div>
		</div>,
		<>
			{head}
			<SideNavigation.Root className="sidebar-nav" aria-label="Rollups">
				{sections.map((section) => (
					<RollupGroup key={section.key} section={section} rows={actions} actions={headings} />
				))}
			</SideNavigation.Root>
		</>,
		<>
			<span className="spacer" />
			{footerActions}
			<ThemeButton />
		</>,
	);
});
