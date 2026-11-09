// The mobile drawer's component tree, with catalog/status/subagent/search handles supplying its data, and the owner's
// session actions on its rows.

import { Access, BACKGROUND_CONTEXT, contribute, defineFacet, type HeldIn, keptIn, liveIn, whenLive } from "@p2/app/v1";
import {
	ChevronIcon,
	closeLayers,
	conversationRoute,
	Drawer,
	MoreIcon,
	navigate,
	openLayer,
	rememberMains,
	type SessionSummary,
	Slot,
	Slots,
	toggleSidebar,
	useComposerState,
	useConnected,
	useHost,
	useNavigation,
	useNewSessionState,
	useObject,
	useOptimisticCall,
	useOwner,
	useReadable,
	useRoute,
	useSheet,
} from "@p2/app/v1/web";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Envs } from "../envs/contract.ts";
import { directoryPickerLayer } from "../envs/contract.web.tsx";
import { Search, SessionReads } from "../search/contract.ts";
import { SessionStatus } from "../status/contract.ts";
import { Subagents } from "../subagents/contract.ts";
import { SessionTree } from "../tree/contract.ts";
import { BranchSheet } from "./BranchSheet.tsx";
import { type Operation, type Session, Sessions } from "./contract.ts";
import { SessionSheet } from "./SessionSheet.tsx";

const subscribeVisibility = (listener: () => void) => {
	document.addEventListener("visibilitychange", listener);
	return () => document.removeEventListener("visibilitychange", listener);
};
/** Whether the page is shown (not a background tab or a hidden app). */
const usePageVisible = () => useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible");

/**
 * The footer's owner entries, in an explicit order, behind one "More" button whose menu opens upwards: one row of
 * buttons no longer fits them. The entries stay mounted while the menu is closed, because each renders the sheet it
 * opens (through a portal, so the hidden menu does not hide it).
 */
function FooterMenu() {
	const [open, setOpen] = useState(false);
	const menu = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const outside = (event: PointerEvent) => {
			if (!menu.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", outside);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);
	return (
		<div className="foot-menu" ref={menu}>
			<button
				type="button"
				className={`foot-button ${open ? "on" : ""}`}
				aria-haspopup="true"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				More
				<span className="foot-menu-chevron">
					<ChevronIcon size={14} />
				</span>
			</button>
			{/* An entry's click opens its sheet, then closes the menu. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the entries are buttons; this only notices their clicks. */}
			<div className="foot-menu-list" hidden={!open} onClick={() => setOpen(false)}>
				<Slot name="sidebar-foot:providers" />
				<Slot name="sidebar-foot:mcp" />
				<Slot name="sidebar-foot:envs" />
				<Slot name="sidebar-foot:devices" />
				<Slot name="sidebar-foot:ports" />
				<Slot name="sidebar-foot:discord" />
				<Slot name="sidebar-foot:voice" />
				<Slot name="sidebar-foot:logs" />
			</div>
		</div>
	);
}

const footer = <FooterMenu />;

/** What a row says about a lifecycle operation (`Sessions.operations`), by kind: running, and failed. */
const OPERATION_LABELS: Record<Operation["kind"], { running: string; failed: string }> = {
	relocate: { running: "Moving…", failed: "Move failed" },
	clone: { running: "Cloning…", failed: "Clone failed" },
	fork: { running: "Forking…", failed: "Fork failed" },
	archive: { running: "Archiving…", failed: "Archive failed" },
};

/**
 * The operation row `session` shows: a failed one of it first (with Dismiss), else one running on it, else a copy
 * into it whose files are still being copied (its worker waits for them).
 */
function operationOf(
	operations: readonly Operation[],
	session: string,
	dismiss: (operation: string) => void,
): SessionSummary["operation"] {
	const failed = operations.find((operation) => operation.phase === "failed" && operation.session === session);
	if (failed?.phase === "failed")
		return { label: OPERATION_LABELS[failed.kind].failed, error: failed.error, dismiss: () => dismiss(failed.id) };
	const running = operations.find((operation) => operation.session === session);
	if (running) return { label: OPERATION_LABELS[running.kind].running };
	const copying = operations.find(
		(operation) => operation.phase === "running" && operation.target === session && operation.copying,
	);
	return copying ? { label: "Copying files…" } : undefined;
}

/** A change to one session's row while its call is in flight. */
type RowGuess = { readonly id: string; readonly change: Partial<Session> };
const applyRow = (rows: Session[] | undefined, { id, change }: RowGuess): Session[] | undefined =>
	rows?.map((row) => (row.id === id ? { ...row, ...change } : row));

/**
 * The drawer, and the owner's session actions on its rows: rename, pin, archive and restore (the Session sheet is
 * rendered here, opened from the top bar's button), switching and renaming `/tree` branches. Each action shows its
 * effect on the rows at once (`useOptimisticCall`); a refused one rolls back and the toast says why. Reads use
 * `keptIn`: while the connection is down the rows stay as last seen; actions need the live catalog.
 */
function Sidebar() {
	const connected = useConnected();
	const route = useRoute();
	const nav = useNavigation();
	const service = useObject(Sessions, {});
	const catalog = liveIn(service, "owner");
	const access = useObject(Access, {});
	const guest = useReadable(keptIn(access, "guest")?.grant);
	// As the server last said (kept across starts): unread marks and search hold without waiting for Access.
	const owner = useOwner();
	const status = keptIn(useObject(SessionStatus, {}), "reader");
	const agents = keptIn(useObject(Subagents, {}), "reader");
	const { fail } = useComposerState();
	const [list, edit] = useOptimisticCall(useReadable(keptIn(service, "owner", "guest")?.sessions), applyRow, fail);
	const statuses = useReadable(status?.statuses);
	const children = useReadable(agents?.children);
	useEffect(() => {
		if (list) rememberMains(list);
	}, [list]);
	// Unread answers are the owner's (any device); guests see none and mark nothing.
	const marks = useObject(SessionReads, owner ? {} : undefined);
	const answers = useReadable(marks?.answers);
	const reads = useReadable(marks?.reads);
	// Dismissing a failed operation removes its line at once.
	const [operations, dismissing] = useOptimisticCall(
		useReadable(keptIn(service, "owner")?.operations) ?? [],
		(list, operation: string) => list.filter((each) => each.id !== operation),
		fail,
	);
	const dismiss = useCallback(
		(operation: string) => {
			if (catalog) dismissing(operation, () => catalog.dismissOperation({ operation }, BACKGROUND_CONTEXT));
		},
		[catalog, dismissing],
	);
	const sessions = useMemo(
		() =>
			(list ?? []).map((session) => {
				const busy = statuses?.[session.id]?.busy ?? [];
				return {
					...session,
					env: session.env ?? null,
					worker: {
						busy,
						error: statuses?.[session.id]?.error,
						unread: (answers?.[session.id] ?? 0) > (reads?.[session.id] ?? 0),
					},
					subagents: children?.[session.id] ?? [],
					operation: operationOf(operations, session.id, dismiss),
				};
			}),
		[list, statuses, children, answers, reads, operations, dismiss],
	);
	// The open session's main conversation, shown on a visible page, is read through its latest answer.
	const visible = usePageVisible();
	const viewed = list?.find((session) => session.id === route.session);
	const shown = visible && route.conversation === viewed?.main ? route.session : undefined;
	const latest = shown ? (answers?.[shown] ?? 0) : 0;
	const read = shown ? (reads?.[shown] ?? 0) : 0;
	useEffect(() => {
		if (shown && marks && latest > read)
			void marks.markRead({ session: shown, through: latest }, BACKGROUND_CONTEXT).catch(() => {});
	}, [marks, shown, latest, read]);
	// Sandboxed groups show a lock; only the owner reads environments.
	const envs = useReadable(useObject(Envs, owner ? {} : undefined)?.envs);
	const sandboxes = useMemo(
		() => new Set((envs ?? []).flatMap((env) => (env.config.type === "gondolin" ? [env.name] : []))),
		[envs],
	);
	const search = liveIn(useObject(Search, owner ? {} : undefined), "owner");
	// A rebuild shows as running at once; it is long work (a job), so the sheet shows it running until it is done.
	const [rebuilds, reindex] = useOptimisticCall(
		useReadable(search?.rebuilds) ?? [],
		(list, session: string) => [
			...list.filter((each) => each.session !== session),
			{ session, phase: "running" as const },
		],
		fail,
	);
	const onSearch = useCallback(
		(query: string, archived: boolean) => search!.search({ query, archived }, BACKGROUND_CONTEXT),
		[search],
	);
	// A session opens at its main conversation; `/s/<id>` would open conversation 1, which redirects there.
	const onOpen = useCallback(
		(session: string, conversation?: number) =>
			navigate({ session, conversation: conversation ?? list?.find((each) => each.id === session)?.main ?? 1 }),
		[list],
	);
	// The restored row is back at once; the session opens once the server has it (an archived one would bounce).
	const onRestore = useCallback(
		(id: string, conversation?: number) => {
			if (!catalog) return;
			edit({ id, change: { archivedAt: null } }, async () => {
				await catalog.restore({ id }, BACKGROUND_CONTEXT);
				onOpen(id, conversation);
			});
		},
		[catalog, edit, onOpen],
	);
	// A branch's switch or rename: a reference of its own (the change also reaches the session row).
	const host = useHost();
	const withTree = useCallback(
		(session: string, action: (tree: HeldIn<typeof SessionTree, "owner">) => Promise<unknown>) => {
			const held = host.hold(SessionTree, { session }, BACKGROUND_CONTEXT);
			return whenLive(held)
				.then(() => {
					const tree = liveIn(held, "owner");
					if (!tree) throw new Error("Only the owner changes branches");
					return action(tree);
				})
				.finally(() => held.release());
		},
		[host],
	);
	// The row marks the chosen branch at once; the view follows once the session's main conversation moved.
	const onBranch = useCallback(
		(session: string, conversation: number) =>
			edit({ id: session, change: { main: conversation } }, async () => {
				await withTree(session, (tree) => tree.select({ conversation }, BACKGROUND_CONTEXT));
				navigate({ session, conversation });
			}),
		[withTree, edit],
	);
	const [renaming, setRenaming] = useState<{ session: string; conversation: number }>();
	const onRenameBranch = useCallback(
		(session: string, conversation: number) => setRenaming({ session, conversation }),
		[],
	);
	const renamed = renaming && list?.find((each) => each.id === renaming.session);
	const branch = renamed?.branches.find((each) => each.conversation === renaming?.conversation);
	const renameBranch = (session: Session, conversation: number, label: string | null) =>
		edit(
			{
				id: session.id,
				change: {
					branches: session.branches.map((each) =>
						each.conversation === conversation ? { ...each, label } : each,
					),
				},
			},
			() => withTree(session.id, (tree) => tree.rename({ conversation, label }, BACKGROUND_CONTEXT)),
		);
	const sessionSheet = useSheet("session");
	const { setChoice, setLocation } = useNewSessionState();
	const onNew = useCallback(() => {
		setChoice(undefined);
		navigate({});
		setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 50);
	}, [setChoice]);
	// A folder's "+": the new session starts in that folder's location.
	const onNewIn = useCallback(
		(env: string | null, cwd: string) => {
			setLocation({ env, cwd });
			onNew();
		},
		[setLocation, onNew],
	);
	return (
		<>
			<Drawer
				sessions={sessions}
				guest={guest}
				sandboxes={sandboxes}
				activeId={route.session}
				conversationId={route.conversation}
				connected={connected}
				onOpen={onOpen}
				onBranch={catalog ? onBranch : undefined}
				onRenameBranch={catalog ? onRenameBranch : undefined}
				onNew={onNew}
				onNewIn={owner ? onNewIn : undefined}
				onCollapse={toggleSidebar}
				onSearch={search ? onSearch : undefined}
				onRestore={onRestore}
				footer={footer}
				onProviders={() => openLayer({ kind: "sheet", name: "providers" }, { fromDrawer: true })}
				onEnvs={() => openLayer({ kind: "sheet", name: "envs" }, { fromDrawer: true })}
				onOwnerLink={() => openLayer({ kind: "sheet", name: "devices" }, { fromDrawer: true })}
			/>
			{renamed && branch && (
				<BranchSheet
					title={renamed.title}
					conversation={branch.conversation}
					label={branch.label}
					onSave={(label) => renameBranch(renamed, branch.conversation, label)}
					onClose={() => setRenaming(undefined)}
				/>
			)}
			{sessionSheet && catalog && viewed && route.conversation === viewed.main && (
				<SessionSheet
					session={viewed}
					onClose={closeLayers}
					onRename={(title) =>
						edit({ id: viewed.id, change: { title } }, () =>
							catalog.rename({ id: viewed.id, title }, BACKGROUND_CONTEXT),
						)
					}
					onPin={() =>
						edit({ id: viewed.id, change: { pinned: !viewed.pinned } }, () =>
							catalog.pin({ id: viewed.id, pinned: !viewed.pinned }, BACKGROUND_CONTEXT),
						)
					}
					onShare={() => openLayer({ kind: "sheet", name: "share" })}
					onCwd={() => openLayer(directoryPickerLayer(viewed.env ?? null, viewed.cwd))}
					reindex={rebuilds.find((each) => each.session === viewed.id)}
					onReindex={
						search &&
						(() => reindex(viewed.id, () => search.rebuildIndex({ session: viewed.id }, BACKGROUND_CONTEXT)))
					}
					onArchive={() => {
						closeLayers();
						void nav.replace(conversationRoute(route, undefined));
						edit({ id: viewed.id, change: { archivedAt: Date.now() } }, () =>
							catalog.archive({ id: viewed.id }, BACKGROUND_CONTEXT),
						);
					}}
				/>
			)}
		</>
	);
}

/** The top bar's button that opens the Session sheet (the drawer renders the sheet, where the rows are). */
function SessionOptions() {
	const route = useRoute();
	const rows = useReadable(useObject(Sessions, {}, { variant: "owner" })?.sessions);
	const session = rows?.find((row) => row.id === route.session);
	if (!session || route.conversation !== session.main) return null;
	return (
		<button
			type="button"
			className="icon-button"
			aria-label="Session options"
			onClick={() => openLayer({ kind: "sheet", name: "session" })}
		>
			<MoreIcon />
		</button>
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-sessions", (self) => {
		self.contribute(Slots, { sidebar: Sidebar, "session-options": SessionOptions });
	});
});
