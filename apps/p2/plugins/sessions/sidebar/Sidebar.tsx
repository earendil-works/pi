// The sidebar's view, built from Elanor's sidebar and side navigation: one navigation group per rollup, in the layout
// of what it collected (the projects as groups of their sessions, the sessions without a project, the Archive's name),
// and the guest's list of shared sessions. Every row has the same shape (NavRow.tsx): a marker, a label, details and
// controls at the trailing end. The owner's list starts with the rows plugins put there (the Familiar's), then the row
// that opens the new-session screen. A rollup's name opens its list page, its chevron shows or hides its sessions; the
// Projects rollup's "+" creates a project; a project's name opens its coordinator session, its chevron shows or hides
// its sessions, its ⋯ (or a long press) opens its commands; another group's row shows or hides its sessions; a
// session's row opens it, its chevron shows or hides its subagents. With a mouse, sessions and projects are dragged
// (drag.ts). It renders what model.ts computes and calls back for every action.
import { type Grant, grantMode } from "@p2/app/v1";
import {
	listenModifierTap,
	NavAddIcon,
	NavFolderIcon,
	NavLockIcon,
	NavMoreIcon,
	NEW_SESSION,
	openCommandMenu,
	PiLogo,
	Sidebar,
	SideNavigation,
	ThemeButton,
	useLinkHref,
} from "@p2/app/v1/web";
import { type ComponentProps, memo, type ReactNode, useEffect, useId, useState } from "react";
import { projectTarget } from "../project-commands.tsx";
import { type DropActions, useSidebarDrag } from "./drag.ts";
import { IconMarker, UnreadMark } from "./marks.tsx";
import { type GroupSection, type NewTarget, PROJECTS, type Section, type SidebarRow } from "./model.ts";
import { NavRow } from "./NavRow.tsx";
import {
	HiddenAttention,
	openFrom,
	pageRoute,
	type RowActions,
	SessionItem,
	TargetNavRow,
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
	/** Starts a new project (the Projects rollup's "+"; the owner's). */
	onNewProject?: () => void;
	/** Whether a project's row has its commands (⋯, a long press; the owner's). */
	projectMenus?: boolean;
	/** The projects' coordinators (the owner's): a project's name opens its coordinator. */
	coordinators?: Coordinators;
	/** The open session. */
	activeId?: string;
};

/** The projects' coordinator sessions in the sidebar: each project's row stands for its coordinator. */
export type Coordinators = {
	/** A project's coordinator's row, once the project has one (archived ones included). */
	rowOf: (project: string) => SidebarRow | undefined;
	/** Opens a project's coordinator, made or restored first when it has to be. */
	onOpen: (project: string) => void;
};

/**
 * A group inside a rollup: its row (a folder, a lock for a sandbox; its name, a project's ⋯, "+"), which shows
 * or hides its relevant sessions below it, one step in. A project's row stands for its coordinator: its name opens it
 * (selected while it shows; the folder framed while it works, bold with a dot for its unread answer) and the chevron
 * after the name shows or hides the sessions. Its tooltip is its path (a project's: its places). Collapsed, it says what
 * its hidden sessions do: how many run, failed or have a new answer.
 */
function GroupItem({ group, rows, actions }: { group: GroupSection; rows: RowActions; actions: HeadingActions }) {
	const { onCollapse, onNewIn, connected, projectMenus, coordinators, activeId } = actions;
	const { target } = group;
	const listId = useId();
	const linkHref = useLinkHref();
	// A project's tooltip: its places, one per line.
	const places =
		target?.kind === "project"
			? target.project.places.map((place) => (place.env ? `${place.env}:${place.path}` : place.path)).join("\n")
			: undefined;
	const menu = projectMenus && target?.kind === "project" ? projectTarget(target.project.name) : undefined;
	const project = coordinators && target?.kind === "project" ? target.project.name : undefined;
	const coordinator = project === undefined ? undefined : coordinators?.rowOf(project);
	const unread = coordinator?.worker.unread === true;
	const icon = group.sandboxed ? <NavLockIcon size={16} aria-label="Sandbox" /> : <NavFolderIcon size={16} />;
	const hidden = group.hidden.working + group.hidden.failed + group.hidden.unread > 0 && (
		<HiddenAttention activity={group.hidden} />
	);
	const shows: Pick<ComponentProps<typeof NavRow>, "expanded" | "controlsId" | "onActivate" | "after"> = project ===
	undefined
		? {
				...(onCollapse ? { expanded: !group.collapsed, controlsId: listId } : {}),
				onActivate: () => onCollapse?.(group.key, !group.collapsed),
			}
		: {
				onActivate: () => coordinators?.onOpen(project),
				after: onCollapse && (
					<Toggle
						className="group-toggle"
						open={!group.collapsed}
						label={`the sessions of ${group.name}`}
						controls={listId}
						onToggle={() => onCollapse(group.key, !group.collapsed)}
					/>
				),
			};
	const row: ComponentProps<typeof NavRow> = {
		className: "group-row",
		linkClassName: "group-link",
		...shows,
		// A live coordinator's address, so its name opens like a session's (a new tab too); otherwise an action.
		...(coordinator && coordinator.archivedAt === null
			? { href: linkHref({ session: coordinator.id, conversation: coordinator.main, layers: [] }) }
			: {}),
		selected: coordinator !== undefined && coordinator.id === activeId,
		title: group.title ?? (places || undefined),
		marker:
			project === undefined ? (
				icon
			) : (
				<IconMarker working={coordinator !== undefined && coordinator.worker.busy.length > 0}>{icon}</IconMarker>
			),
		label: <span className={`session-title ${unread ? "unread" : ""}`}>{group.name}</span>,
		details: unread ? (
			<>
				{hidden}
				<UnreadMark />
			</>
		) : (
			hidden
		),
		controls: (
			<>
				{menu && (
					<button
						type="button"
						className="nav-control group-options"
						aria-label={`${group.name} options`}
						title="Options"
						onClick={() => openCommandMenu(menu)}
					>
						<NavMoreIcon size={16} />
					</button>
				)}
				{onNewIn && target && (
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
				)}
			</>
		),
	};
	return (
		<SideNavigation.Item
			className="sidebar-group"
			data-key={group.key}
			{...(target?.kind === "project" ? { "data-project": target.project.name } : {})}
		>
			{menu ? <TargetNavRow menu={menu} {...row} /> : <NavRow {...row} />}
			{/* Hidden while empty too: an empty list still takes its margins, so expanding a project without sessions
			    would push the rows below it down. Only the chevron turns then. */}
			<SideNavigation.List className="group-items" id={listId} hidden={group.collapsed || group.rows.length === 0}>
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
 * "No activity" when it has none to show. Collapsed, its row says what its hidden sessions do. The Projects rollup has
 * a "+" that creates a project.
 */
function RollupGroup({ section, rows, actions }: { section: Section; rows: RowActions; actions: HeadingActions }) {
	const { page, onPage, onCollapse, onOptions, onNewProject, connected } = actions;
	const linkHref = useLinkHref();
	const listId = useId();
	if (section.layout === "sessions" && section.headless)
		return <HeadlessGroup section={section} rows={rows} selected={page === section.key} onPage={onPage} />;
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
							<HiddenAttention activity={section.hidden} />
						)
					)
				}
				controls={
					<>
						{section.key === PROJECTS && onNewProject && (
							<button
								type="button"
								className="nav-control new-project"
								aria-label="New project"
								title="New project"
								disabled={!connected}
								onClick={onNewProject}
							>
								<NavAddIcon size={16} />
							</button>
						)}
						{onOptions && (
							<button
								type="button"
								className="nav-control rollup-options"
								aria-label={`${section.name} options`}
								title="Options"
								onClick={() => onOptions(section.key)}
							>
								<NavMoreIcon size={16} />
							</button>
						)}
					</>
				}
			/>
			{section.layout !== "link" && (
				<SideNavigation.List id={listId} hidden={section.collapsed}>
					{section.layout === "sessions" &&
						section.rows.map((session) => (
							<SessionItem key={session.id} session={session} scope={section.key} actions={rows} />
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

/**
 * A rollup without a heading (the sessions without a project): its sessions, then, when its window hides some, a row
 * that opens its list ("3 older").
 */
function HeadlessGroup({
	section,
	rows,
	selected,
	onPage,
}: {
	section: Extract<Section, { layout: "sessions" }>;
	rows: RowActions;
	selected: boolean;
	onPage: (key: string) => void;
}) {
	const linkHref = useLinkHref();
	return (
		<SideNavigation.Group className="sidebar-section headless" data-key={section.key}>
			<SideNavigation.List aria-label={section.name}>
				{section.rows.map((session) => (
					<SessionItem key={session.id} session={session} scope={section.key} actions={rows} />
				))}
				{section.older > 0 && (
					<SideNavigation.Item>
						<NavRow
							selected={selected}
							className="older-row"
							href={linkHref(pageRoute(section.key))}
							onActivate={() => onPage(section.key)}
							marker={null}
							label={`${section.older} older`}
						/>
					</SideNavigation.Item>
				)}
			</SideNavigation.List>
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

/** The session rows of the sidebar's expanded sections, top to bottom, with the place (rollup's or group's key) of each. */
function shownRows(sections: readonly Section[]): { id: string; scope: string }[] {
	return sections.flatMap((section) => {
		if (section.layout === "sessions") return section.rows.map((row) => ({ id: row.id, scope: section.key }));
		if (section.layout === "groups")
			return section.groups.flatMap((group) => group.rows.map((row) => ({ id: row.id, scope: group.key })));
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
	startRows,
	guest,
	activeId,
	conversationId,
	connected,
	onOpen,
	onRestore,
	writable,
	onCancel,
	onArchive,
	onArchiveAgent,
	onNew,
	onNewIn,
	onNewProject,
	onOptions,
	onCollapse,
	onPage,
	onCollapseSidebar,
	drop,
	coordinators,
	headerActions,
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
	/** The owner's rows before "New session", each a list item (the `sidebar-start:<name>` slots: the Familiar's). */
	startRows?: ReactNode;
	guest?: Grant;
	activeId?: string;
	conversationId: number;
	connected: boolean;
	onOpen: (id: string, conversationId?: number) => void;
	onRestore: (id: string, conversationId?: number) => void;
	/** Whether the reader acts on a session's agents (Cancel, a subagent's Archive). */
	writable?: (id: string) => boolean;
	/** Stops runs of a session's conversations (its items' Cancel). */
	onCancel?: (id: string, conversations: readonly number[]) => void;
	/** Archives a session (its item's Archive; the owner's). */
	onArchive?: (id: string) => void;
	/** Archives a subagent (its item's Archive). */
	onArchiveAgent?: (id: string, conversation: number) => void;
	onNew: () => void;
	/** Starts a new session in a group; absent: groups have no "+". */
	onNewIn?: (target: NewTarget) => void;
	/** Starts a new project (the Projects rollup's "+"; the owner's). */
	onNewProject?: () => void;
	/** Opens a rollup's options (its window and place). */
	onOptions?: (key: string) => void;
	/** Shows or hides a rollup's or a group's sessions. */
	onCollapse?: (key: string, collapsed: boolean) => void;
	/** Opens a rollup's or a group's list in the main area. */
	onPage: (key: string) => void;
	onCollapseSidebar: () => void;
	/** Moving sessions and projects by drag and drop (the owner's): what a drop does. */
	drop?: DropActions;
	/** The projects' coordinators (the owner's): a project's name opens its coordinator. */
	coordinators?: Coordinators;
	/** Icon buttons in the owner's header, before the collapse button (e.g. the scope prompt's). */
	headerActions?: ReactNode;
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
		dragging: drop !== undefined && !guest,
		activeId,
		activeScope,
		conversationId,
		now,
		onOpen,
		onRestore,
		writable,
		onCancel,
		onArchive,
		onArchiveAgent,
	};
	const headings: HeadingActions = {
		page,
		connected,
		onPage,
		onCollapse,
		onOptions,
		onNewIn,
		onNewProject,
		projectMenus: drop !== undefined,
		...(coordinators ? { coordinators } : {}),
		...(activeId === undefined ? {} : { activeId }),
	};
	useSidebarDrag(guest ? undefined : drop);
	// Cmd+Shift (Ctrl+Shift off macOS), tapped: the session below the open one's row, from the top after the last.
	useEffect(() => {
		if (guest) return;
		return listenModifierTap("p2.sessions.next", () => {
			const shown = shownRows(sections);
			if (shown.length === 0) return;
			const at = shown.findIndex((row) => row.id === activeId && row.scope === activeScope);
			const next = shown[(at + 1) % shown.length]!;
			openFrom(next.id, next.scope);
			onOpen(next.id);
		});
	}, [guest, sections, activeId, activeScope, onOpen]);
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
			<div className="brand">
				<PiLogo compact />
			</div>
			{headerActions}
			<Sidebar.Trigger className="collapse-sidebar" aria-label="Collapse sidebar" />
		</div>,
		<SideNavigation.Root className="sidebar-nav" aria-label="Rollups" {...(drop ? { "data-drag": "" } : {})}>
			<SideNavigation.List className="sidebar-start">
				{startRows}
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
