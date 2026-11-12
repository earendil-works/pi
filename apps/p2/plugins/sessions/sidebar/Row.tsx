// The rows of the sidebar and its list pages, items of Elanor's side navigation. Every row has one shape (`NavRow`): a
// marker, the label (a link, an action, or the control that shows or hides what is below it, its chevron after the
// label), its details and its controls at the trailing end, all inside the one control whose hover and selected
// background spans the whole row. A session with several conversations shows or hides them on a click of its chevron:
// its `/tree` branches drawn as a tree, then its subagents as a list.
import {
	BranchIcon,
	type CommandTargetRow,
	HOME,
	inPage,
	locationLabel,
	NavDisclosureIcon,
	NavEditIcon,
	NavWarningIcon,
	openLayer,
	PinIcon,
	type Route,
	SideNavigation,
	shortPath,
	ToolActivities,
	useCommandMenuRow,
	useCommandTargetRow,
	useLinkHref,
	useRegistry,
} from "@p2/app/v1/web";
import {
	type CSSProperties,
	createContext,
	type ReactNode,
	use,
	useEffect,
	useId,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import { GlyphIcon } from "../../glyphs/GlyphIcon.tsx";
import { branchSheetLayer, branchTarget } from "../BranchSheet.tsx";
import {
	type ArchivedItem,
	type BranchItem,
	type ConversationItem,
	conversationRows,
	type SubagentItem,
} from "./conversation-tree.ts";
import { RunMark, UnreadMark, WorkingMark } from "./marks.tsx";
import type { Activity, GlyphSeed, SidebarRow } from "./model.ts";
import {
	failureWords,
	type SubagentState,
	stepWords,
	subagentState,
	subagentTitle,
	type Tools,
} from "./subagent-state.ts";

// A row says two things in two places. Its marker says whether the session runs: a frame whose dash travels around its
// icon, or a spinner where it has none; the only motion in the sidebar. The end of the row says whether it wants the
// owner: a bold title and a blue dot for an unread answer, "Failed" for a failed worker. Every state has its own shape,
// not only its own colour.

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

/** A failure that wants the owner: a warning sign and `label`, in the error colour; `title` says what failed. */
export function FailedMark({ label, title, className = "" }: { label: string; title: string; className?: string }) {
	return (
		<span className={`failed-mark ${className}`} title={title}>
			<NavWarningIcon size={14} aria-hidden="true" />
			{label}
		</span>
	);
}

/**
 * What the sessions a collapsed group or rollup hides want from the owner: how many failed (the warning sign), how many
 * have an unread answer (a blue count). Nothing when none does.
 */
export function HiddenAttention({ activity }: { activity: Activity }) {
	const { failed, unread } = activity;
	return (
		<>
			{failed > 0 && <FailedMark label={String(failed)} title={`${failed} failed`} />}
			{unread > 0 && (
				<span className="unread-count" title={`${unread} with a new answer`}>
					{unread}
				</span>
			)}
		</>
	);
}

/**
 * The end of a subagent's row, in its session's time column: its step while busy, "Failed" or "Stopped", or how long
 * ago it was last active.
 */
function SubagentEnd({ state, tools, now }: { state: SubagentState; tools: Tools; now: number }) {
	switch (state.kind) {
		case "busy":
			return <span className="subagent-step">{stepWords(state.work, tools)}</span>;
		case "failed":
			return <FailedMark label="Failed" title={state.detail ?? failureWords(state.reason)} />;
		case "stopped":
			return <span className="subagent-step">Stopped</span>;
		case "idle":
			return state.since === undefined ? null : <span className="session-time">{ago(state.since, now)}</span>;
	}
}

/** How long ago `time` was, in the sidebar's short form. */
export function ago(time: number, now: number): string {
	const seconds = Math.max(0, (now - time) / 1000);
	if (seconds < 60) return "now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
	return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * A folder's name in the sidebar: its last `segments` path segments, with its environment; its row's title has the
 * whole path.
 */
export function folderName(env: string | null, cwd: string, segments: number): string {
	const path = shortPath(cwd).split(/[\\/]/).filter(Boolean);
	const base = path.slice(-segments).join("/") || cwd;
	return env ? `${base} · ${env}` : base;
}

/** The route of a rollup's or a group's list page, for its link (`useLinkHref`). */
export const pageRoute = (page: string): Route => ({ ...HOME, page });

const SCOPES_KEY = "p2-sidebar-opened-from";
const scopeListeners = new Set<() => void>();
let openedFrom: Readonly<Record<string, string>> = readScopes();

/** The places this tab opened sessions from, as stored; unreadable storage is none. */
function readScopes(): Record<string, string> {
	try {
		const value: unknown = JSON.parse(sessionStorage.getItem(SCOPES_KEY) ?? "{}");
		return typeof value === "object" && value !== null
			? Object.fromEntries(
					Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
				)
			: {};
	} catch {
		return {};
	}
}

/** How many sessions' places a tab remembers: the most recently opened ones. */
const REMEMBERED = 200;

/**
 * Remembers, per tab, the place (a rollup's or a group's key) session `session` was opened from: it is selected there
 * only, also when Back returns to it.
 */
function openFrom(session: string, scope: string): void {
	const { [session]: _, ...others } = openedFrom;
	openedFrom = Object.fromEntries([...Object.entries(others), [session, scope]].slice(-REMEMBERED));
	try {
		sessionStorage.setItem(SCOPES_KEY, JSON.stringify(openedFrom));
	} catch {}
	for (const listener of scopeListeners) listener();
}

const subscribeScopes = (listener: () => void) => {
	scopeListeners.add(listener);
	return () => scopeListeners.delete(listener);
};

/** The places this tab opened sessions from, by session. */
export const useOpenedFrom = (): Readonly<Record<string, string>> =>
	useSyncExternalStore(subscribeScopes, () => openedFrom);

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

/** The chevron right after a row's label that shows or hides what is below the row, as its own button. */
export function Toggle({
	open,
	label,
	controls,
	className,
	onToggle,
}: {
	open: boolean;
	/** What it shows or hides, for its accessible name ("conversations", "the sessions of Recents"). */
	label: string;
	controls: string;
	className: string;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			className={`nav-control nav-toggle ${className}`}
			aria-expanded={open}
			aria-controls={controls}
			aria-label={`${open ? "Hide" : "Show"} ${label}`}
			onClick={onToggle}
		>
			<NavDisclosureIcon className="nav-chevron" size={16} />
		</button>
	);
}

/** What a session's row needs to show and act: the shown conversation, the time, and the actions. */
export type RowActions = {
	activeId?: string;
	/** The one place the open session is selected in (it may show in several); absent: everywhere it shows. */
	activeScope?: string;
	conversationId: number;
	now: number;
	onOpen: (id: string, conversationId?: number) => void;
	onBranch?: (id: string, conversationId: number) => void;
	onRestore: (id: string, conversationId?: number) => void;
};

/**
 * A session's item: its row is a link to its main conversation, selected while that shows (for an archived session, an
 * action that restores and opens it). Its other conversations are below it (`conversationRows`): from two `/tree`
 * branches on, a tree of them, conversation 1 first and each branch under the conversation it was forked from (the
 * current one a link, the others switches), drawn with connector guides; then its subagents and one-shot agents as a
 * list, archived ones behind their own row. They are shown or hidden only by the chevron after its title,
 * in the secondary style with their labels and working marks in the session's columns. Showing a subagent shows them.
 * A running or failed lifecycle operation shows below the row. `aged`: it fell out of its rollup's window and shows
 * dimmed. `glyph`: its project glyph in the marker column (framed while working), its path as the tooltip. An unread
 * answer makes its title bold with a dot before the time; a failed worker shows "Failed" there.
 */
export function SessionItem({
	session,
	scope,
	listsConversations = true,
	archived = false,
	aged = false,
	actions,
	glyph,
}: {
	session: SidebarRow;
	/** Where the item is (a rollup's or a group's key, or the page): a session shows in several places. */
	scope: string;
	/** Whether its other conversations are listed below it (the sidebar's); a list page lists sessions only. */
	listsConversations?: boolean;
	archived?: boolean;
	aged?: boolean;
	actions: RowActions;
	glyph?: GlyphSeed;
}) {
	const linkHref = useLinkHref();
	const { activeId, activeScope, conversationId: shownConversation, now, onBranch, onRestore } = actions;
	const active = session.id === activeId && (activeScope === undefined || activeScope === scope);
	const conversationId = active ? shownConversation : session.main;
	// Opening a session or one of its conversations from here selects it here, not in the other places it shows.
	const onOpen = (conversation?: number) => {
		openFrom(session.id, scope);
		actions.onOpen(session.id, conversation);
	};
	// Every conversation of the session is listed: branches (where the owner can switch them), subagents and code
	// mode's one-shot agents (read-only). An archived session lists none.
	const listed = listsConversations && !archived;
	const { main, branches, subagents } = session;
	const tree = useMemo(
		() => (listed ? conversationRows({ branches: onBranch ? branches : [], subagents }) : []),
		[listed, onBranch, branches, subagents],
	);
	const nested = tree.length > 0;
	// Showing a subagent or agent shows them, so it is in view, selected; the main conversation is the row's. Not a
	// branch: right after a `/tree` switch the page shows the new branch before the row names it main.
	const showsNested = active && subagents.some((agent) => agent.conversationId === conversationId);
	const [expanded, setExpanded] = useState(showsNested);
	useEffect(() => {
		if (showsNested) setExpanded(true);
	}, [showsNested]);
	const listId = useId();
	const tools = useRegistry(ToolActivities);
	const rows: ConversationRows = {
		// The main conversation is selected on the session's row.
		state: { session, selected: active && conversationId !== main ? conversationId : undefined, now },
		actions: {
			open: onOpen,
			switchTo: (conversation) => {
				openFrom(session.id, scope);
				onBranch?.(session.id, conversation);
			},
		},
		meta: { tools },
	};
	const { worker } = session;
	const working = worker.busy.length > 0;
	const title = (
		<span className={`session-title ${worker.unread ? "unread" : ""}`}>
			{session.pinned && <PinIcon size={12} />}
			{session.title}
		</span>
	);
	const details = (
		<>
			{worker.error !== undefined && (
				<FailedMark className="session-worker-error" label="Failed" title={`Worker failed: ${worker.error}`} />
			)}
			{worker.unread && <UnreadMark />}
			<span className="session-time">{ago(session.updatedAt, now)}</span>
		</>
	);
	const marker = glyph ? (
		<IconMarker working={working}>
			<GlyphIcon seed={glyph.seed} />
		</IconMarker>
	) : working ? (
		<WorkingMark />
	) : null;
	const target = useCommandTargetRow({ type: "session", id: session.id, kind: "Session", label: session.title });
	return (
		<SideNavigation.Item className={`session-row ${aged ? "aged" : ""}`}>
			<NavRow
				selected={active && conversationId === main}
				className={`session-header ${nested ? "has-subagents" : ""}`}
				linkClassName="session-main"
				{...(archived
					? { title: "Restore and open" }
					: {
							title: glyph?.title,
							href: linkHref({ session: session.id, conversation: main, layers: [] }),
						})}
				onActivate={() => {
					if (archived) {
						openFrom(session.id, scope);
						return onRestore(session.id);
					}
					onOpen();
				}}
				marker={marker}
				label={title}
				target={target}
				after={
					nested && (
						<Toggle
							className="subagent-toggle"
							open={expanded}
							label="conversations"
							controls={listId}
							onToggle={() => setExpanded(!expanded)}
						/>
					)
				}
				details={details}
			/>
			{session.operation && (
				<div className={`session-operation ${session.operation.error === undefined ? "" : "failed"}`}>
					<span className="session-operation-text" title={session.operation.error}>
						{session.operation.label}
						{session.operation.error === undefined ? "" : `: ${session.operation.error}`}
					</span>
					{session.operation.dismiss && (
						<button type="button" className="text-action" onClick={session.operation.dismiss}>
							Dismiss
						</button>
					)}
				</div>
			)}
			{nested && (
				<ConversationRowsContext value={rows}>
					<SideNavigation.List className="conversation-items" id={listId} hidden={!expanded}>
						{tree.map((row) => (
							<ConversationListItem key={row.key} row={row} />
						))}
					</SideNavigation.List>
				</ConversationRowsContext>
			)}
		</SideNavigation.Item>
	);
}

/**
 * What a session's conversation rows share: its row, the conversation selected below it (none while the session's
 * own row is), the time; opening a conversation, switching to a branch.
 */
type ConversationRows = {
	readonly state: { readonly session: SidebarRow; readonly selected: number | undefined; readonly now: number };
	readonly actions: {
		readonly open: (conversation: number) => void;
		readonly switchTo: (conversation: number) => void;
	};
	readonly meta: { readonly tools: Tools };
};

const ConversationRowsContext = createContext<ConversationRows | null>(null);

function useConversationRows(): ConversationRows {
	const value = use(ConversationRowsContext);
	if (value === null) throw new Error("A conversation row belongs inside its session's item");
	return value;
}

/** A style setting one CSS custom property (React's style type has none, hence the cast). */
const customProperty = (name: `--${string}`, value: number) => ({ [name]: value }) as CSSProperties;

/** One row below a session's, as an item of its list, indented by its depth (`--depth`). */
function ConversationListItem({ row }: { row: ConversationItem }) {
	return (
		<SideNavigation.Item style={customProperty("--depth", row.depth)}>{conversationRow(row)}</SideNavigation.Item>
	);
}

/** The row of `row`'s kind. */
function conversationRow(row: ConversationItem): ReactNode {
	switch (row.kind) {
		case "branch":
			return <BranchRow row={row} />;
		case "subagent":
			return <SubagentRow row={row} />;
		case "archived":
			return <ArchivedRows row={row} />;
	}
}

/**
 * A branch row's connector guides, outside its layout: its ancestors' lines that continue below it, then its own tee or
 * elbow, each at its level (`--level`).
 */
function TreeGuides({ row }: { row: BranchItem }) {
	const pipes = row.guides.flatMap((guide, at) => (guide === "pipe" ? [at + 1] : []));
	return (
		<>
			{pipes.map((level) => (
				<span
					key={level}
					className="tree-guide"
					data-guide="pipe"
					style={customProperty("--level", level)}
					aria-hidden="true"
				/>
			))}
			<span
				className="tree-guide"
				data-guide={row.joint}
				style={customProperty("--level", row.depth)}
				aria-hidden="true"
			/>
		</>
	);
}

/**
 * A `/tree` branch's row: the current one is a link to it, another one switches the session to it. Its mark
 * (`BranchItem.mark`): on a row something forked from the fork icon, framed while it works; on a leaf the ring a
 * subagent row has, the spinner while it works. Its end says what it does, as a subagent's does. Renaming: its pencil
 * (a fine pointer's, on hover or keyboard focus), or "Rename branch…" in its command menu (a long press, or Cmd+K
 * while it has focus).
 */
function BranchRow({ row }: { row: BranchItem }) {
	const { state, actions, meta } = useConversationRows();
	const linkHref = useLinkHref();
	const { session } = state;
	const id = row.branch.conversation;
	// A null label shows the session title (conversation 1's default, docs/tree.md).
	const label = row.branch.label ?? session.title;
	const main = id === session.main;
	const busy = session.worker.busy.includes(id);
	const branch = branchTarget({ session: session.id, conversation: id }, label);
	const target = useCommandMenuRow(branch);
	return (
		<NavRow
			selected={state.selected === id}
			className="conversation-row branch-nav-row"
			linkClassName="subagent-row branch-row"
			title={main ? "The current branch" : "Switch the session to this branch"}
			// Another branch is a switch of the session, not an address: an action, not a link.
			{...(main ? { href: linkHref({ session: session.id, conversation: id, layers: [] }) } : {})}
			onActivate={() => (main ? actions.open(id) : actions.switchTo(id))}
			guides={<TreeGuides row={row} />}
			marker={
				row.mark === "fork" ? (
					<IconMarker working={busy}>
						<BranchIcon size={16} />
					</IconMarker>
				) : (
					<RunMark state={busy ? "working" : "idle"} />
				)
			}
			label={<span className="session-title">{label}</span>}
			details={
				busy ? <span className="subagent-step">{stepWords(session.worker.work[id], meta.tools)}</span> : undefined
			}
			controls={
				<button
					type="button"
					className="nav-control branch-rename"
					aria-label={`Rename branch ${label}`}
					title="Rename branch"
					onClick={() => openLayer(branchSheetLayer(branch.id))}
				>
					<NavEditIcon size={16} />
				</button>
			}
			target={target}
		/>
	);
}

/**
 * A subagent's or one-shot agent's row, a link to it: a ring in its marker column that spins while it works, its end in
 * the session's time column (`SubagentEnd`: how its last run ended), its model and where it works as the tooltip.
 */
function SubagentRow({ row: { agent } }: { row: SubagentItem }) {
	const { state, actions, meta } = useConversationRows();
	const linkHref = useLinkHref();
	const { session } = state;
	const id = agent.conversationId;
	const busy = session.worker.busy.includes(id);
	const shown = subagentState(agent, busy, session.worker.work[id]);
	return (
		<NavRow
			selected={state.selected === id}
			className="conversation-row"
			linkClassName={`subagent-row ${agent.kind === "agent" ? "agent-row" : ""}`}
			href={linkHref({ session: session.id, conversation: id, layers: [] })}
			// Its model and where it works, for a pointer that rests on it; its view shows them too.
			title={subagentTitle(agent, shown, agent.location && locationLabel(agent.location.env, agent.location.cwd))}
			onActivate={() => actions.open(id)}
			marker={<RunMark state={busy ? "working" : "idle"} />}
			label={<span className="session-title">{agent.name}</span>}
			details={<SubagentEnd state={shown} tools={meta.tools} now={state.now} />}
		/>
	);
}

/**
 * The row "N archived" and the archived subagents' rows below it, shown or hidden by it (shown while one of them is
 * selected).
 */
function ArchivedRows({ row: { agents } }: { row: ArchivedItem }) {
	const { state } = useConversationRows();
	const [shown, setShown] = useState(false);
	const open = shown || agents.some((each) => each.agent.conversationId === state.selected);
	const listId = useId();
	return (
		<>
			<NavRow
				className="conversation-row"
				linkClassName="subagent-row subagent-stored"
				expanded={open}
				controlsId={listId}
				onActivate={() => setShown(!open)}
				marker={null}
				label={<span className="session-title">{agents.length} archived</span>}
			/>
			<SideNavigation.List className="conversation-items" id={listId} hidden={!open}>
				{agents.map((each) => (
					<ConversationListItem key={each.key} row={each} />
				))}
			</SideNavigation.List>
		</>
	);
}
