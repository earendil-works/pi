// The rows of the sidebar and its list pages, items of Elanor's side navigation. Every row has one shape (`NavRow`): a
// marker, the label (a link, an action, or the control that shows or hides what is below it, its chevron after the
// label), its details and its controls at the trailing end, all inside the one control whose hover and selected
// background spans the whole row. A session with several conversations (`/tree` branches, subagents) shows or hides
// them on a click of its row.
import {
	HOME,
	locationLabel,
	NavDisclosureIcon,
	NavEditIcon,
	PinIcon,
	routePath,
	SideNavigation,
} from "@p2/app/v1/web";
import { type MouseEvent, type ReactNode, useEffect, useId, useState, useSyncExternalStore } from "react";
import type { SidebarRow } from "./model.ts";

/** Working (pulsing), else an unread answer (steady blue), else nothing. */
export function SessionDot({ worker }: { worker: SidebarRow["worker"] }) {
	if (worker.busy.length) return <span className="live-dot" title="Working" />;
	if (worker.unread) return <span className="unread-dot" title="New answer" />;
	return null;
}

/** How long ago `time` was, in the sidebar's short form. */
function ago(time: number, now: number): string {
	const seconds = Math.max(0, (now - time) / 1000);
	if (seconds < 60) return "now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
	return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * A click handler for a link that acts in the page (`act`) on a plain primary click; any other click (a modifier, the
 * middle button, "Open in new tab") is the browser's, so the target opens in another tab or window.
 */
export const inPage = (act: () => void) => (event: MouseEvent<HTMLAnchorElement>) => {
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	event.preventDefault();
	act();
};

/** The address of a rollup's or a group's list page. */
export const pageHref = (page: string): string => routePath({ ...HOME, page });

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
 * One row: a marker (a session's activity dot, a group's icon; its column is kept when empty, so labels line up; absent:
 * no column, as a rollup's), the label (on one line, cut with "…" at its end), then details and controls at the
 * trailing end. The label is a link to `href`, an action without one, or with `expanded`, the control that shows or
 * hides what is below the row (its chevron right after the label). The whole row is one control: its hover and selected
 * background spans it, and the label's hit area covers it (the controls stay above it). `after`: a control right after
 * the label (a rollup's or a session's chevron, `Toggle`).
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
}: {
	selected?: boolean;
	className?: string;
	linkClassName?: string;
	/** The marker column (absent: the row has none): a dot or an icon, or `null` for its empty space. */
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
}) {
	const link = `nav-link ${linkClassName} ${selected ? "active" : ""}`;
	return (
		<div className={`nav-row ${selected ? "selected" : ""} ${className}`}>
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
	onRenameBranch?: (id: string, conversationId: number) => void;
	onRestore: (id: string, conversationId?: number) => void;
};

/** One of a session's conversations below its row: a `/tree` branch, or a subagent or one-shot agent. */
type Conversation =
	| { kind: "branch"; conversation: number; label: string }
	| { kind: "subagent"; conversation: number; agent: SidebarRow["subagents"][number] };

/**
 * A session's item: its row is a link to its main conversation, selected while that shows (for an archived session, an
 * action that restores and opens it). Its other conversations (`/tree` branches, the current one a link and the others
 * switches; then its subagents and one-shot agents) are below it, shown or hidden only by the chevron after its title,
 * in the secondary style with their labels and activity dots in the session's columns. Showing a subagent shows them.
 * A running or failed lifecycle operation shows below the row. `aged`: it fell out of its rollup's window and shows
 * dimmed.
 */
export function SessionItem({
	session,
	scope,
	archived = false,
	aged = false,
	actions,
}: {
	session: SidebarRow;
	/** Where the item is (a rollup's or a group's key, or the page): a session shows in several places. */
	scope: string;
	archived?: boolean;
	aged?: boolean;
	actions: RowActions;
}) {
	const {
		activeId,
		activeScope,
		conversationId: shownConversation,
		now,
		onBranch,
		onRenameBranch,
		onRestore,
	} = actions;
	const active = session.id === activeId && (activeScope === undefined || activeScope === scope);
	const conversationId = active ? shownConversation : session.main;
	// Opening a session or one of its conversations from here selects it here, not in the other places it shows.
	const onOpen = (conversation?: number) => {
		openFrom(session.id, scope);
		actions.onOpen(session.id, conversation);
	};
	// Every conversation of the session is listed: subagents and code mode's one-shot agents (read-only), the most
	// recently active first; archived subagents wait behind their own row.
	const listed = (archived ? [] : session.subagents).toSorted(
		(a, b) => (b.lastEntryId ?? 0) - (a.lastEntryId ?? 0) || b.conversationId - a.conversationId,
	);
	const stored = listed.filter((agent) => agent.archived);
	const branched = onBranch !== undefined && !archived && session.branches.length >= 2;
	const conversations: Conversation[] = [
		...(branched
			? session.branches.map(
					(branch): Conversation => ({
						kind: "branch",
						conversation: branch.conversation,
						label: branch.label ?? session.title,
					}),
				)
			: []),
		...listed
			.filter((agent) => !agent.archived)
			.map((agent): Conversation => ({ kind: "subagent", conversation: agent.conversationId, agent })),
	];
	const [showStored, setShowStored] = useState(false);
	const storedOpen = showStored || stored.some((agent) => agent.conversationId === conversationId);
	const nested = conversations.length > 0 || stored.length > 0;
	// Showing a subagent or agent shows them, so it is in view, selected; the main conversation is the row's. Not a
	// branch: right after a `/tree` switch the page shows the new branch before the row names it main.
	const showsNested = active && session.subagents.some((agent) => agent.conversationId === conversationId);
	const [expanded, setExpanded] = useState(showsNested);
	useEffect(() => {
		if (showsNested) setExpanded(true);
	}, [showsNested]);
	const listId = useId();
	const conversationRow = (item: Conversation) => {
		// The main conversation is selected on the session's row.
		const selected = active && conversationId === item.conversation && item.conversation !== session.main;
		const busy = session.worker.busy.includes(item.conversation) ? (
			<span className="live-dot" title="Working" />
		) : null;
		const href = routePath({ session: session.id, conversation: item.conversation, layers: [] });
		if (item.kind === "branch") {
			const main = item.conversation === session.main;
			return (
				<SideNavigation.Item key={`b${item.conversation}`}>
					<NavRow
						selected={selected}
						className="conversation-row"
						linkClassName="subagent-row branch-row"
						title={main ? "The current branch" : "Switch the session to this branch"}
						// Another branch is a switch of the session, not an address: an action, not a link.
						{...(main ? { href } : {})}
						onActivate={() => {
							if (main) onOpen(item.conversation);
							else {
								openFrom(session.id, scope);
								onBranch?.(session.id, item.conversation);
							}
						}}
						marker={busy}
						label={<span className="session-title">{item.label}</span>}
						controls={
							onRenameBranch && (
								<button
									type="button"
									className="nav-control branch-rename"
									aria-label={`Rename branch ${item.label}`}
									title="Rename branch"
									onClick={() => onRenameBranch(session.id, item.conversation)}
								>
									<NavEditIcon size={16} />
								</button>
							)
						}
					/>
				</SideNavigation.Item>
			);
		}
		const { agent } = item;
		return (
			<SideNavigation.Item key={`s${item.conversation}`}>
				<NavRow
					selected={selected}
					className="conversation-row"
					linkClassName={`subagent-row ${agent.kind === "agent" ? "agent-row" : ""}`}
					href={href}
					title={
						agent.location
							? `Works in ${locationLabel(agent.location.env, agent.location.cwd)}`
							: `Follows the session: ${locationLabel(session.env, session.cwd)}`
					}
					onActivate={() => onOpen(item.conversation)}
					marker={busy}
					label={<span className="session-title">{agent.name}</span>}
					details={
						<>
							{/* A subagent with its own location shows it: it stays there when the session moves. */}
							{agent.location && (
								<span className="subagent-location">
									{locationLabel(agent.location.env, agent.location.cwd)}
								</span>
							)}
							<span className="subagent-model">{agent.model.split("/").pop()}</span>
						</>
					}
				/>
			</SideNavigation.Item>
		);
	};
	const title = (
		<span className="session-title">
			{session.pinned && <PinIcon size={12} />}
			{session.title}
		</span>
	);
	const details = (
		<>
			{session.worker.error && (
				<span className="error session-worker-error" title={session.worker.error}>
					Worker failed
				</span>
			)}
			<span className="session-time">{ago(session.updatedAt, now)}</span>
		</>
	);
	const marker = <SessionDot worker={session.worker} />;
	return (
		<SideNavigation.Item className={`session-row ${aged ? "aged" : ""}`}>
			<NavRow
				selected={active && conversationId === session.main}
				className={`session-header ${nested ? "has-subagents" : ""}`}
				linkClassName="session-main"
				{...(archived
					? { title: "Restore and open" }
					: { href: routePath({ session: session.id, conversation: session.main, layers: [] }) })}
				onActivate={() => {
					if (archived) {
						openFrom(session.id, scope);
						return onRestore(session.id);
					}
					onOpen();
				}}
				marker={marker}
				label={title}
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
				<SideNavigation.List className="conversation-items" id={listId} hidden={!expanded}>
					{conversations.map(conversationRow)}
					{stored.length > 0 && (
						<SideNavigation.Item>
							<NavRow
								className="conversation-row"
								linkClassName="subagent-row subagent-stored"
								expanded={storedOpen}
								controlsId={`${listId}-stored`}
								onActivate={() => setShowStored(!storedOpen)}
								marker={null}
								label={<span className="session-title">{stored.length} archived</span>}
							/>
							<SideNavigation.List className="conversation-items" id={`${listId}-stored`} hidden={!storedOpen}>
								{stored.map((agent) =>
									conversationRow({ kind: "subagent", conversation: agent.conversationId, agent }),
								)}
							</SideNavigation.List>
						</SideNavigation.Item>
					)}
				</SideNavigation.List>
			)}
		</SideNavigation.Item>
	);
}
