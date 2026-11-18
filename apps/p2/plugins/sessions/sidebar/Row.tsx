// The rows of the sidebar and its list pages, items of Elanor's side navigation. A session and each of its subagents
// are the same item (`AgentItem`): a status, a name and a detail. The status is pi's working dots while it runs, a blue
// dot for an answer not read yet, a red dot for a failure, nothing while idle. The detail is how long ago its last
// message was; under a fine pointer, on hover or keyboard focus, it gives way to the item's one action, an icon button:
// Cancel (a cross in a circle) while it runs, Archive while idle (on touch screens the item's command menu has them,
// commands.tsx). The name is cut with "…" before the detail. A session lists its subagents below it (its chevron shows
// or hides them); its `/tree` branches are not listed.
import {
	type CommandTarget,
	HOME,
	locationLabel,
	NavArchiveIcon,
	NavCancelIcon,
	NavDisclosureIcon,
	NavWarningIcon,
	PinIcon,
	type Route,
	SideNavigation,
	shortPath,
	useCommandMenuRow,
	useLinkHref,
} from "@p2/app/v1/web";
import { type ComponentProps, type ReactNode, useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { conversationTargetId } from "../../chat/contract.ts";
import { byRecentActivity, type Child } from "../../subagents/contract.ts";
import { stoppable } from "../agent-actions.ts";
import { FailedDot, PiDots, UnreadMark } from "./marks.tsx";
import { type Activity, failureOf, type SidebarRow } from "./model.ts";
import { NavRow } from "./NavRow.tsx";
import { failureWords, runState, subagentTitle } from "./run-state.ts";

/** A failure that wants the owner: a warning sign and `label`, in the error colour; `title` says what failed. */
export function FailedMark({ label, title }: { label: string; title: string }) {
	return (
		<span className="failed-mark" title={title}>
			<NavWarningIcon size={14} aria-hidden="true" />
			{label}
		</span>
	);
}

/**
 * What the sessions a collapsed group or rollup hides do: how many run (pi's dots), how many failed (the warning sign),
 * how many have an unread answer (a blue count). Nothing when none does.
 */
export function HiddenAttention({ activity }: { activity: Activity }) {
	const { working, failed, unread } = activity;
	return (
		<>
			{working > 0 && (
				<span className="working-count" title={`${working} running`}>
					<PiDots />
					{working}
				</span>
			)}
			{failed > 0 && <FailedMark label={String(failed)} title={`${failed} failed`} />}
			{unread > 0 && (
				<span className="unread-count" title={`${unread} with a new answer`}>
					{unread}
				</span>
			)}
		</>
	);
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

/** The chevron right after a row's label that shows or hides what is below the row, as its own button. */
export function Toggle({
	open,
	label,
	controls,
	className,
	onToggle,
}: {
	open: boolean;
	/** What it shows or hides, for its accessible name ("subagents", "the sessions of Projects"). */
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

/** What an item's status mark says: working, an answer not read yet, a failure (and what failed), or nothing. */
export type ItemStatus =
	| { readonly kind: "working" }
	| { readonly kind: "unread" }
	| { readonly kind: "failed"; readonly title: string }
	| { readonly kind: "idle" };

/** An item's one action, in place of its detail on hover or keyboard focus: stopping its run, or archiving it. */
export type ItemAction = { readonly kind: "cancel" | "archive"; readonly title: string; readonly run: () => void };

function StatusMark({ status }: { status: ItemStatus }) {
	switch (status.kind) {
		case "working":
			return <PiDots />;
		case "unread":
			return <UnreadMark />;
		case "failed":
			return <FailedDot title={status.title} />;
		case "idle":
			return null;
	}
}

/**
 * One item, a session or a subagent: status, name, detail (how long ago its last message was), and its action, shown
 * over the detail while the row is hovered or has keyboard focus (the detail's column is kept for it, also without an
 * age). The name is bold while an answer is `unread`, whatever the status shows first. `menu`:
 * the command menu's target while the row is hovered or focused, opened on it with a long press (touch screens reach
 * its action there).
 */
function AgentItem({
	status,
	name,
	unread = false,
	detail,
	action,
	selected,
	href,
	title,
	onActivate,
	className = "",
	linkClassName = "",
	after,
	menu,
}: {
	status: ItemStatus;
	name: ReactNode;
	unread?: boolean;
	detail: string;
	action?: ItemAction;
	selected: boolean;
	/** Absent: the name is an action (restoring an archived session). */
	href?: string;
	title?: string;
	onActivate: () => void;
	className?: string;
	linkClassName?: string;
	/** A control right after the name (a session's chevron). */
	after?: ReactNode;
	menu?: CommandTarget;
}) {
	const row: ComponentProps<typeof NavRow> = {
		selected,
		className: `agent-item ${action ? "has-action" : ""} ${className}`,
		linkClassName,
		...(href === undefined ? {} : { href }),
		title,
		onActivate,
		marker: <StatusMark status={status} />,
		label: <span className={`session-title ${unread ? "unread" : ""}`}>{name}</span>,
		after,
		details: detail || action ? <span className="item-age">{detail}</span> : undefined,
		controls: action && (
			<button
				type="button"
				className="nav-control item-action"
				data-action={action.kind}
				aria-label={action.title}
				title={action.title}
				onClick={action.run}
			>
				{action.kind === "cancel" ? <NavCancelIcon size={16} /> : <NavArchiveIcon size={16} />}
			</button>
		),
	};
	return menu ? <MenuNavRow menu={menu} {...row} /> : <NavRow {...row} />;
}

/** A row that is the command menu's target `menu`: while hovered or focused, and opening the menu on a long press. */
function MenuNavRow({ menu, ...row }: ComponentProps<typeof NavRow> & { menu: CommandTarget }) {
	return <NavRow {...row} target={useCommandMenuRow(menu)} />;
}

/** What a session's row needs to show and act: the shown conversation, the time, and the actions. */
export type RowActions = {
	activeId?: string;
	/** The one place the open session is selected in (it may show in several); absent: everywhere it shows. */
	activeScope?: string;
	conversationId: number;
	now: number;
	onOpen: (id: string, conversationId?: number) => void;
	onRestore: (id: string, conversationId?: number) => void;
	/** Whether the reader acts on a session's agents (Cancel, a subagent's Archive): the owner, a read/write guest. */
	writable?: (id: string) => boolean;
	/** Stops the runs of these conversations of a session. */
	onCancel?: (id: string, conversations: readonly number[]) => void;
	/** Archives a session (the owner's). */
	onArchive?: (id: string) => void;
	/** Archives one of a session's subagents. */
	onArchiveAgent?: (id: string, conversation: number) => void;
};

/** A session's status: a failure first (`failureOf`), then working (any of its conversations), then unread. */
function sessionStatus(session: SidebarRow): ItemStatus {
	const failure = failureOf(session);
	if (failure !== undefined) return { kind: "failed", title: failure };
	if (session.worker.busy.length > 0) return { kind: "working" };
	if (session.worker.unread) return { kind: "unread" };
	return { kind: "idle" };
}

/**
 * A session's item: a link to its main conversation, selected while that shows (for an archived session, an action
 * that restores and opens it). Its subagents and one-shot agents are below it, the same items one step in, the most
 * recently active first, archived ones behind their own row; its chevron shows or hides them, and showing one of them
 * shows them. A running or failed lifecycle operation shows below the row. `aged`: it fell out of its rollup's window
 * and shows dimmed.
 */
export function SessionItem({
	session,
	scope,
	listsConversations = true,
	archived = false,
	aged = false,
	actions,
}: {
	session: SidebarRow;
	/** Where the item is (a rollup's or a group's key, or the page): a session shows in several places. */
	scope: string;
	/** Whether its subagents are listed below it (the sidebar's); a list page lists sessions only. */
	listsConversations?: boolean;
	archived?: boolean;
	aged?: boolean;
	actions: RowActions;
}) {
	const linkHref = useLinkHref();
	const { activeId, activeScope, conversationId: shownConversation, now, onRestore, onArchive } = actions;
	const onCancel = actions.writable?.(session.id) ? actions.onCancel : undefined;
	const active = session.id === activeId && (activeScope === undefined || activeScope === scope);
	const conversationId = active ? shownConversation : session.main;
	const onOpen = (conversation?: number) => {
		openFrom(session.id, scope);
		actions.onOpen(session.id, conversation);
	};
	const { main, subagents, worker } = session;
	const lists = listsConversations && !archived;
	const [shownAgents, stored] = useMemo(() => {
		const listed = lists ? subagents.toSorted(byRecentActivity) : [];
		return [listed.filter((agent) => !agent.archived), listed.filter((agent) => agent.archived)];
	}, [lists, subagents]);
	const nested = shownAgents.length + stored.length > 0;
	// Showing a subagent shows them, so it is in view, selected; the main conversation is the session's own row.
	const showsNested = active && subagents.some((agent) => agent.conversationId === conversationId);
	const [expanded, setExpanded] = useState(showsNested);
	useEffect(() => {
		if (showsNested) setExpanded(true);
	}, [showsNested]);
	const listId = useId();
	const status = sessionStatus(session);
	const running = stoppable(worker.busy, subagents);
	const action: ItemAction | undefined = archived
		? undefined
		: worker.busy.length > 0
			? onCancel && running.length > 0
				? {
						kind: "cancel",
						title:
							running.length > 1 ? `Stop ${session.title}: ${running.length} agents` : `Stop ${session.title}`,
						run: () => onCancel(session.id, running),
					}
				: undefined
			: onArchive && { kind: "archive", title: `Archive ${session.title}`, run: () => onArchive(session.id) };
	const name = (
		<>
			{session.pinned && <PinIcon size={12} />}
			{session.title}
		</>
	);
	return (
		<SideNavigation.Item className={`session-row ${aged ? "aged" : ""}`} data-session={session.id}>
			<AgentItem
				status={status}
				name={name}
				unread={Boolean(worker.unread)}
				detail={ago(session.updatedAt, now)}
				action={action}
				selected={active && conversationId === main}
				className={`session-header ${nested ? "has-subagents" : ""}`}
				linkClassName="session-main"
				{...(archived
					? { title: "Restore and open" }
					: { href: linkHref({ session: session.id, conversation: main, layers: [] }) })}
				onActivate={() => {
					if (archived) {
						openFrom(session.id, scope);
						return onRestore(session.id);
					}
					onOpen();
				}}
				after={
					nested && (
						<Toggle
							className="subagent-toggle"
							open={expanded}
							label="subagents"
							controls={listId}
							onToggle={() => setExpanded(!expanded)}
						/>
					)
				}
				menu={{ type: "session", id: session.id, kind: "Session", label: session.title }}
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
					{shownAgents.map((agent) => (
						<SubagentItem
							key={agent.conversationId}
							session={session}
							agent={agent}
							selected={active && conversationId === agent.conversationId}
							onOpen={() => onOpen(agent.conversationId)}
							actions={actions}
						/>
					))}
					{stored.length > 0 && (
						<ArchivedAgents
							session={session}
							agents={stored}
							selected={active ? conversationId : undefined}
							onOpen={onOpen}
							actions={actions}
						/>
					)}
				</SideNavigation.List>
			)}
		</SideNavigation.Item>
	);
}

/**
 * A subagent's or one-shot agent's item, a link to it: its status (working, failed; a stopped run shows nothing), its
 * name, how long ago its last message was, and its action: Cancel while it works (its run only), Archive while idle (a
 * subagent's; one-shot agents belong to the script waiting for them). Its model and where it works are the tooltip.
 */
function SubagentItem({
	session,
	agent,
	selected,
	onOpen,
	actions,
}: {
	session: SidebarRow;
	agent: Child;
	selected: boolean;
	onOpen: () => void;
	actions: RowActions;
}) {
	const linkHref = useLinkHref();
	const id = agent.conversationId;
	const busy = session.worker.busy.includes(id);
	const shown = runState(agent.failure, busy, session.worker.work[id]);
	const status: ItemStatus =
		shown.kind === "busy"
			? { kind: "working" }
			: shown.kind === "failed"
				? { kind: "failed", title: shown.detail ?? failureWords(shown.reason) }
				: { kind: "idle" };
	const writable = actions.writable?.(session.id) ?? false;
	const onCancel = writable ? actions.onCancel : undefined;
	const onArchiveAgent = writable ? actions.onArchiveAgent : undefined;
	const oneShot = agent.kind === "agent";
	const action: ItemAction | undefined = busy
		? onCancel && { kind: "cancel", title: `Stop ${agent.name}`, run: () => onCancel(session.id, [id]) }
		: onArchiveAgent && !oneShot && !agent.archived
			? { kind: "archive", title: `Archive ${agent.name}`, run: () => onArchiveAgent(session.id, id) }
			: undefined;
	return (
		<SideNavigation.Item>
			<AgentItem
				status={status}
				name={agent.name}
				detail={agent.updatedAt === undefined ? "" : ago(agent.updatedAt, actions.now)}
				action={action}
				selected={selected}
				className="conversation-row"
				linkClassName={`subagent-row ${oneShot ? "agent-row" : ""}`}
				href={linkHref({ session: session.id, conversation: id, layers: [] })}
				title={subagentTitle(agent, shown, agent.location && locationLabel(agent.location.env, agent.location.cwd))}
				onActivate={onOpen}
				// The command menu's target, as the chat's while it shows; a one-shot agent's chat has none (its script's).
				{...(oneShot
					? {}
					: {
							menu: {
								type: "conversation",
								id: conversationTargetId(session.id, id),
								kind: "Conversation",
								label: agent.name,
							},
						})}
			/>
		</SideNavigation.Item>
	);
}

/** The row "N archived" and the archived subagents below it, shown or hidden by it (shown while one is selected). */
function ArchivedAgents({
	session,
	agents,
	selected,
	onOpen,
	actions,
}: {
	session: SidebarRow;
	agents: readonly Child[];
	selected: number | undefined;
	onOpen: (conversation: number) => void;
	actions: RowActions;
}) {
	const [shown, setShown] = useState(false);
	const open = shown || agents.some((agent) => agent.conversationId === selected);
	const listId = useId();
	return (
		<SideNavigation.Item>
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
				{agents.map((agent) => (
					<SubagentItem
						key={agent.conversationId}
						session={session}
						agent={agent}
						selected={agent.conversationId === selected}
						onOpen={() => onOpen(agent.conversationId)}
						actions={actions}
					/>
				))}
			</SideNavigation.List>
		</SideNavigation.Item>
	);
}
