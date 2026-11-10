// One session in the sidebar or a list page, as an item of Elanor's side navigation: a link to the session (title, state
// dot, how long ago it was active) and, behind its expand control, its `/tree` branches and its subagents.
import {
	BranchIcon,
	ChevronIcon,
	HOME,
	locationLabel,
	PencilIcon,
	PinIcon,
	routePath,
	SideNavigation,
} from "@p2/app/v1/web";
import { type MouseEvent, useEffect, useState, useSyncExternalStore } from "react";
import type { SidebarRow } from "./model.ts";

/** Working (pulsing), else an unread answer (steady blue), else nothing. */
export function SessionDot({ worker }: { worker: SidebarRow["worker"] }) {
	if (worker.busy.length) return <span className="live-dot" title="Working" />;
	if (worker.unread) return <span className="unread-dot" title="New answer" />;
	return null;
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
 * A click handler for a link that acts in the page (`act`) on a plain primary click; any other click (a modifier, the
 * middle button, "Open in new tab") is the browser's, so the target opens in another tab or window.
 */
export const inPage = (act: () => void) => (event: MouseEvent<HTMLAnchorElement>) => {
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	event.preventDefault();
	act();
};

/** The address of conversation `conversation` of `session`. */
export const conversationHref = (session: string, conversation: number): string =>
	routePath({ session, conversation, layers: [] });

/** The address of a rollup's or a group's list page. */
export const pageHref = (page: string): string => routePath({ ...HOME, page });

const SCOPE_KEY = "p2-sidebar-scope";
const scopeListeners = new Set<() => void>();
let openedFrom: string | undefined = readScope();

/** The place this tab last opened a session from, as stored; unreadable storage is none. */
function readScope(): string | undefined {
	try {
		return sessionStorage.getItem(SCOPE_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

/** Remembers, per tab, the place (a rollup's or a group's key) a session was opened from: it is selected there only. */
function openFrom(scope: string): void {
	openedFrom = scope;
	try {
		sessionStorage.setItem(SCOPE_KEY, scope);
	} catch {}
	for (const listener of scopeListeners) listener();
}

const subscribeScope = (listener: () => void) => {
	scopeListeners.add(listener);
	return () => scopeListeners.delete(listener);
};

/** The place this tab last opened a session from (a rollup's or a group's key), if any. */
export const useOpenedFrom = (): string | undefined => useSyncExternalStore(subscribeScope, () => openedFrom);

/** A row's title (with a pin) and its meta: the worker's failure, the state dot, how long ago it was active. */
function SessionLine({ session, now, archived }: { session: SidebarRow; now: number; archived: boolean }) {
	return (
		<>
			<span className="session-title">
				{session.pinned && <PinIcon size={12} />}
				{session.title}
			</span>
			<span className="session-meta">
				{session.worker.error && (
					<span className="error session-worker-error" title={session.worker.error}>
						Worker failed
					</span>
				)}
				<SessionDot worker={session.worker} />
				{archived ? "Restore" : ago(session.updatedAt, now)}
			</span>
		</>
	);
}

/**
 * A session's `/tree` branches (docs/tree.md), newest first in a stable order: switching only moves the "current" mark.
 * Shown from two branches on, behind the session row's expand control. Choosing another branch switches the session to
 * it (`onBranch`, the owner's); the pencil beside a row renames it (`onRenameBranch`). A branch without a label
 * (conversation 1's default) shows the session title. A branch left while running goes on in the background: its row
 * shows the working dot.
 */
function BranchItems({
	session,
	conversationId,
	active,
	onOpen,
	onBranch,
	onRenameBranch,
}: {
	session: SidebarRow;
	conversationId: number;
	active: boolean;
	onOpen: (id: string, conversationId?: number) => void;
	onBranch: (id: string, conversationId: number) => void;
	onRenameBranch?: (id: string, conversationId: number) => void;
}) {
	return session.branches.map((branch) => {
		const current = branch.conversation === session.main;
		const label = branch.label ?? session.title;
		return (
			<SideNavigation.Item className="branch-item" key={branch.conversation}>
				<SideNavigation.Link
					className={`subagent-row branch-row ${active && conversationId === branch.conversation ? "active" : ""}`}
					href={conversationHref(session.id, branch.conversation)}
					active={active && conversationId === branch.conversation}
					title={current ? "The current branch" : "Switch the session to this branch"}
					iconStart={<BranchIcon size={13} />}
					onClick={inPage(() =>
						current ? onOpen(session.id, branch.conversation) : onBranch(session.id, branch.conversation),
					)}
				>
					<span className="session-title">{label}</span>
					<span className="session-meta">
						{current && "current"}
						{session.worker.busy.includes(branch.conversation) && <span className="live-dot" title="Working" />}
					</span>
				</SideNavigation.Link>
				{onRenameBranch && (
					<button
						type="button"
						className="branch-rename"
						aria-label={`Rename branch ${label}`}
						title="Rename branch"
						onClick={() => onRenameBranch(session.id, branch.conversation)}
					>
						<PencilIcon />
					</button>
				)}
			</SideNavigation.Item>
		);
	});
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

/**
 * A session's item: its link (for an archived session, one that restores and opens it), one control that expands its
 * branches and its subagents, a running or failed lifecycle operation, and the expanded items. A subagent shown
 * expands them. `aged`: it fell out of its rollup's window and shows dimmed.
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
	const branchesId = `${scope}/branches-${session.id}`;
	const subagentsId = `${scope}/subagents-${session.id}`;
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
	// Opening it from here selects it here, not in the other places it shows.
	const onOpen = (id: string, conversation?: number) => {
		openFrom(scope);
		actions.onOpen(id, conversation);
	};
	const conversationId = active ? shownConversation : session.main;
	// Not any conversation but the main one: right after a `/tree` switch the page shows the new branch before the row
	// names it main.
	const showsSubagent = session.subagents.some((agent) => agent.conversationId === conversationId);
	const [expanded, setExpanded] = useState(showsSubagent);
	useEffect(() => {
		if (showsSubagent) setExpanded(true);
	}, [showsSubagent]);
	// One-shot agents are opened from their script's tool card; archived subagents wait behind their own row.
	const listed = (archived ? [] : session.subagents)
		.filter((agent) => agent.kind !== "agent")
		.toSorted((a, b) => (b.lastEntryId ?? 0) - (a.lastEntryId ?? 0) || b.conversationId - a.conversationId);
	const agents = listed.filter((agent) => !agent.archived);
	const stored = listed.filter((agent) => agent.archived);
	const [showStored, setShowStored] = useState(false);
	const storedOpen = showStored || stored.some((agent) => agent.conversationId === conversationId);
	const branches = onBranch !== undefined && !archived && session.branches.length >= 2;
	const nested = [branches && "branches", listed.length > 0 && "subagents"].filter(Boolean).join(" and ");
	const agentItem = (agent: (typeof listed)[number]) => (
		<SideNavigation.Item key={agent.conversationId}>
			<SideNavigation.Link
				className={`subagent-row ${conversationId === agent.conversationId ? "active" : ""}`}
				href={conversationHref(session.id, agent.conversationId)}
				active={conversationId === agent.conversationId}
				title={
					agent.location
						? `Works in ${locationLabel(agent.location.env, agent.location.cwd)}`
						: `Follows the session: ${locationLabel(session.env, session.cwd)}`
				}
				onClick={inPage(() => onOpen(session.id, agent.conversationId))}
			>
				<span className="session-title">{agent.name}</span>
				<span className="session-meta">
					{/* A subagent with its own location shows it: it stays there when the session moves. */}
					{agent.location && (
						<span className="subagent-location">{locationLabel(agent.location.env, agent.location.cwd)}</span>
					)}
					{session.worker.busy.includes(agent.conversationId) && <span className="live-dot" title="Working" />}
					{agent.model.split("/").pop()}
				</span>
			</SideNavigation.Link>
		</SideNavigation.Item>
	);
	return (
		<SideNavigation.Item className={`session-row ${aged ? "aged" : ""}`}>
			<div className={`session-header ${nested ? "has-subagents" : ""}`}>
				<SideNavigation.Link
					className={`session-main ${active && conversationId === session.main ? "active" : ""}`}
					href={conversationHref(session.id, session.main)}
					active={active && conversationId === session.main}
					onClick={inPage(() => {
						openFrom(scope);
						if (archived) onRestore(session.id);
						else actions.onOpen(session.id);
					})}
				>
					<SessionLine session={session} now={now} archived={archived} />
				</SideNavigation.Link>
				{nested && (
					<button
						type="button"
						className="subagent-toggle"
						aria-label={`${expanded ? "Collapse" : "Expand"} ${nested}`}
						aria-expanded={expanded}
						aria-controls={[branches && branchesId, listed.length > 0 && subagentsId].filter(Boolean).join(" ")}
						onClick={() => setExpanded(!expanded)}
					>
						{listed.length > 0 && <span>{agents.length}</span>}
						{branches && (
							<span className="toggle-branches" title={`${session.branches.length} branches`}>
								<BranchIcon size={11} />
								{session.branches.length}
							</span>
						)}
						<span className={`chev ${expanded ? "open" : ""}`}>
							<ChevronIcon size={12} />
						</span>
					</button>
				)}
			</div>
			{session.operation && (
				<div className={`session-operation ${session.operation.error === undefined ? "" : "failed"}`}>
					<span title={session.operation.error}>
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
			{branches && (
				<SideNavigation.List className="nested-items branch-rows" id={branchesId} hidden={!expanded}>
					<BranchItems
						session={session}
						conversationId={conversationId}
						active={active}
						onOpen={onOpen}
						onBranch={(id, conversation) => {
							openFrom(scope);
							onBranch(id, conversation);
						}}
						onRenameBranch={onRenameBranch}
					/>
				</SideNavigation.List>
			)}
			{listed.length > 0 && (
				<SideNavigation.List className="nested-items" id={subagentsId} hidden={!expanded}>
					{agents.map(agentItem)}
					{stored.length > 0 && (
						<SideNavigation.Item>
							<button
								type="button"
								className="subagent-row subagent-stored"
								aria-expanded={storedOpen}
								onClick={() => setShowStored(!storedOpen)}
							>
								<span className="session-title">{stored.length} archived</span>
								<span className={`chev ${storedOpen ? "open" : ""}`}>
									<ChevronIcon size={12} />
								</span>
							</button>
						</SideNavigation.Item>
					)}
					{storedOpen && stored.map(agentItem)}
				</SideNavigation.List>
			)}
		</SideNavigation.Item>
	);
}
