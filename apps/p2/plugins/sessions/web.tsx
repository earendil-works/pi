// The sidebar and its list pages (sidebar/: the rollups' rules and their views) with the catalog, status, subagent,
// search, project and settings handles supplying their data, the owner's session actions on the rows, and the session
// and rollup sheets.

import {
	Access,
	BACKGROUND_CONTEXT,
	contribute,
	defineFacet,
	type HeldIn,
	keptIn,
	LOCAL,
	liveIn,
	whenLive,
} from "@p2/app/v1";
import {
	closeLayers,
	conversationRoute,
	MoreIcon,
	navigate,
	openLayer,
	openPage,
	rememberMains,
	SlotList,
	Slots,
	shortPath,
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
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Envs } from "../envs/contract.ts";
import { directoryPickerLayer } from "../envs/contract.web.tsx";
import { Projects, placeOn } from "../projects/contract.ts";
import { Search, type SearchResults, SessionReads } from "../search/contract.ts";
import { SessionStatus } from "../status/contract.ts";
import { Subagents } from "../subagents/contract.ts";
import { SessionTree } from "../tree/contract.ts";
import { BranchSheet } from "./BranchSheet.tsx";
import { type Operation, type Session, Sessions, SidebarSettings, type SidebarWindow } from "./contract.ts";
import { type DrawerRows, DrawerRowsContext } from "./contract.web.tsx";
import { SessionSheet } from "./SessionSheet.tsx";
import { ListPage } from "./sidebar/ListPage.tsx";
import {
	listPageOf,
	moved,
	type NewTarget,
	ordered,
	ROLLUPS,
	type Rollup,
	type RollupContext,
	type SidebarRow,
	sectionsOf,
	type View,
} from "./sidebar/model.ts";
import { RollupSheet } from "./sidebar/RollupSheet.tsx";
import { SidebarView, useNow } from "./sidebar/Sidebar.tsx";

const subscribeVisibility = (listener: () => void) => {
	document.addEventListener("visibilitychange", listener);
	return () => document.removeEventListener("visibilitychange", listener);
};
/** Whether the page is shown (not a background tab or a hidden app). */
const usePageVisible = () => useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible");

/** Entries above the rollups, e.g. the Familiar's. */
const head = <SlotList prefix="drawer-head" />;
/** Icon buttons at the footer's end, before the theme switch (`sidebar-actions:<name>`, e.g. the Settings gear). */
const actions = <SlotList prefix="sidebar-actions" />;

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
): SidebarRow["operation"] {
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

/** The owner's sidebar settings (`SidebarSettings`): the rollups' order and windows, collapsed rollups and groups. */
type Settings = {
	readonly order: readonly string[];
	readonly windows: Readonly<Record<string, SidebarWindow>>;
	readonly collapsed: Readonly<Record<string, boolean>>;
};
const applySettings = (state: Settings, change: Partial<Settings>): Settings => ({ ...state, ...change });
const NO_SETTINGS: Settings = { order: [], windows: {}, collapsed: {} };

/**
 * A folder's name in the sidebar: its last `segments` path segments, with its environment; its row's title has the
 * whole path.
 */
function folderName(env: string | null, cwd: string, segments: number): string {
	const path = shortPath(cwd).split(/[\\/]/).filter(Boolean);
	const base = path.slice(-segments).join("/") || cwd;
	return env ? `${base} · ${env}` : base;
}

/** What a rollup's or a group's list page shows and acts with: the sidebar's data, published by the sidebar. */
type PageData = {
	readonly rows: readonly SidebarRow[];
	readonly rollups: readonly Rollup[];
	readonly context: RollupContext;
	readonly view: View;
	/** The sessions (or, for a project's list, the projects) are not known yet. */
	readonly loading: (page: string) => boolean;
	readonly connected: boolean;
	readonly onOpen: (id: string, conversation?: number) => void;
	readonly onRestore: (id: string, conversation?: number) => void;
	readonly onSearch?: (query: string, archived: boolean, sessions: readonly string[]) => Promise<SearchResults>;
	readonly onNewIn?: (target: NewTarget) => void;
};

// The sidebar is always mounted (docked, or in the drawer) and holds the one copy of the data, with its edits shown at
// once; a list page in the main area renders from it, so both show the same rows, offline too.
const pageListeners = new Set<() => void>();
let pageData: PageData | undefined;
const subscribePage = (listener: () => void) => {
	pageListeners.add(listener);
	return () => pageListeners.delete(listener);
};
function publishPage(next: PageData): void {
	pageData = next;
	for (const listener of pageListeners) listener();
}

/**
 * The sessions as the sidebar and its list pages show them, and what they act with: the catalog's rows (with a row's
 * edit shown at once), their state (working, unread, failed, an operation), what the rollups collect from (projects),
 * the owner's settings, opening and restoring a session. Reads use `keptIn`: while the connection is down the rows
 * stay as last seen; actions need the live objects.
 */
function useSidebarData() {
	const route = useRoute();
	const service = useObject(Sessions, {});
	const catalog = liveIn(service, "owner");
	// As the server last said (kept across starts): unread marks and search hold without waiting for Access.
	const owner = useOwner();
	const status = keptIn(useObject(SessionStatus, {}), "reader");
	const agents = keptIn(useObject(Subagents, {}), "reader");
	const { fail } = useComposerState();
	const [list, edit] = useOptimisticCall(useReadable(keptIn(service, "owner", "guest")?.sessions), applyRow, fail);
	const statuses = useReadable(status?.statuses);
	const children = useReadable(agents?.children);
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
	const rows = useMemo(
		() =>
			(list ?? []).map((session): SidebarRow => {
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
	// The projects rollup reads projects.json and the sessions' projects (`Projects`, from the projects plugin).
	const projectsHeld = useObject(Projects, owner ? {} : undefined);
	const projectsKept = keptIn(projectsHeld, "owner");
	const projects = useReadable(projectsKept?.projects);
	const memberships = useReadable(projectsKept?.sessions);
	const localLabel = useReadable(projectsKept?.local);
	// Folders on a sandbox environment show a lock; only the owner reads environments.
	const envs = useReadable(useObject(Envs, owner ? {} : undefined)?.envs);
	const context = useMemo(
		(): RollupContext => ({
			projects: projects ?? [],
			memberships: memberships ?? {},
			folderName,
			sandboxes: new Set((envs ?? []).flatMap((env) => (env.config.type === "gondolin" ? [env.name] : []))),
		}),
		[projects, memberships, envs],
	);
	const settingsHeld = useObject(SidebarSettings, owner ? {} : undefined);
	const settingsKept = keptIn(settingsHeld, "owner");
	const order = useReadable(settingsKept?.order);
	const windows = useReadable(settingsKept?.windows);
	const collapsed = useReadable(settingsKept?.collapsed);
	const [settings, guessSettings] = useOptimisticCall<Settings, Partial<Settings>>(
		useMemo(
			() => (order ? { order, windows: windows ?? {}, collapsed: collapsed ?? {} } : NO_SETTINGS),
			[order, windows, collapsed],
		),
		applySettings,
		fail,
	);
	/** Shows `change` at once and calls `call` with the live settings; offline the call fails, rolling it back. */
	const changeSettings = useCallback(
		(change: Partial<Settings>, call: (live: HeldIn<typeof SidebarSettings, "owner">) => Promise<unknown>) =>
			guessSettings(change, async () => {
				const live = liveIn(settingsHeld, "owner");
				if (!live) throw new Error("Not connected");
				await call(live);
			}),
		[guessSettings, settingsHeld],
	);
	const rollups = useMemo(() => ordered(ROLLUPS, settings.order), [settings.order]);
	const now = useNow();
	const view = useMemo(
		() => ({ windows: settings.windows, collapsed: settings.collapsed, now, open: route.session }),
		[settings, now, route.session],
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
	const searchHeld = useObject(Search, owner ? {} : undefined);
	const search = liveIn(searchHeld, "owner");
	// The owner's lists keep their search field while offline; a search waits for the connection (the page skips it).
	const onSearch = useMemo(
		() =>
			searchHeld &&
			((query: string, archived: boolean, sessions: readonly string[]) => {
				const live = liveIn(searchHeld, "owner");
				if (!live) return Promise.reject(new Error("Not connected"));
				return live.search({ query, archived, sessions: [...sessions] }, BACKGROUND_CONTEXT);
			}),
		[searchHeld],
	);
	return {
		route,
		catalog,
		owner,
		fail,
		list,
		edit,
		rows,
		answers,
		reads,
		marks,
		search,
		onSearch,
		projects,
		projectsHeld,
		localLabel,
		context,
		settings,
		changeSettings,
		rollups,
		view,
		onOpen,
		onRestore,
	};
}

/**
 * The sidebar, and the owner's actions on it: the session actions on the rows (rename, pin, archive and restore: the
 * Session sheet is rendered here, opened from the top bar's button), switching and renaming `/tree` branches, a group's
 * "+", a rollup's options and collapsing rollups and groups. Each action shows its effect at once
 * (`useOptimisticCall`); a refused one rolls back and the toast says why.
 */
function Sidebar() {
	const connected = useConnected();
	const nav = useNavigation();
	const data = useSidebarData();
	const { route, catalog, owner, fail, list, edit, rows, answers, reads, marks, search, settings, changeSettings } =
		data;
	const { rollups, context, view, onOpen, onRestore } = data;
	// Sessions a `drawer-head` entry shows (the Familiar's) are left out of the rollups.
	const [apart, setApart] = useState<Readonly<Record<string, readonly string[]>>>({});
	const listApart = useCallback(
		(key: string, ids: readonly string[]) => setApart((current) => ({ ...current, [key]: ids })),
		[],
	);
	const drawerRows = useMemo<DrawerRows>(() => ({ sessions: rows, listApart }), [rows, listApart]);
	const rolledUp = useMemo(() => {
		const hidden = new Set(Object.values(apart).flat());
		return hidden.size ? rows.filter((row) => !hidden.has(row.id)) : rows;
	}, [rows, apart]);
	const sections = useMemo(() => sectionsOf(rollups, rolledUp, context, view), [rollups, rolledUp, context, view]);
	const { onSearch, projects } = data;
	const access = useObject(Access, {});
	const guest = useReadable(keptIn(access, "guest")?.grant);
	useEffect(() => {
		if (list) rememberMains(list);
	}, [list]);
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
	// A rebuild shows as running at once; it is long work (a job), so the sheet shows it running until it is done.
	const [rebuilds, reindex] = useOptimisticCall(
		useReadable(search?.rebuilds) ?? [],
		(list, session: string) => [
			...list.filter((each) => each.session !== session),
			{ session, phase: "running" as const },
		],
		fail,
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
	const { setChoice, setLocation, setJoin } = useNewSessionState();
	const focusNew = useCallback(() => {
		setChoice(undefined);
		navigate({});
		setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 50);
	}, [setChoice]);
	const onNew = useCallback(() => {
		setJoin(undefined);
		focusNew();
	}, [setJoin, focusNew]);
	const { projectsHeld, localLabel } = data;
	/**
	 * A group's "+": a folder's new session starts in the folder; a project's joins the project (once it exists) and
	 * starts at its place on the machine of its most recently active session, else at its first place.
	 */
	const onNewIn = useCallback(
		(target: NewTarget) => {
			if (target.kind === "folder") {
				setLocation({ env: target.env, cwd: target.cwd });
				setJoin(undefined);
			} else {
				const latest = rows
					.filter((row) => !row.archivedAt && context.memberships[row.id] === target.project.name)
					.toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
				const place =
					(latest && placeOn(target.project, latest.env ?? LOCAL, localLabel ?? "")) ?? target.project.places[0];
				if (place) setLocation({ env: place.env, cwd: place.path });
				setJoin({
					label: target.project.name,
					// The page is connected (the session was just created): wait for the projects to be live too.
					run: async (session) => {
						if (!projectsHeld) throw new Error("Only the owner has projects");
						await whenLive(projectsHeld);
						const live = liveIn(projectsHeld, "owner");
						if (!live) throw new Error("Only the owner has projects");
						await live.assign({ session, project: target.project.name }, BACKGROUND_CONTEXT);
					},
				});
			}
			focusNew();
		},
		[rows, context, localLabel, projectsHeld, setLocation, setJoin, focusNew],
	);
	const onCollapse = useCallback(
		(key: string, collapsed: boolean) =>
			changeSettings({ collapsed: { ...settings.collapsed, [key]: collapsed } }, (live) =>
				live.setCollapsed({ key, collapsed }, BACKGROUND_CONTEXT),
			),
		[changeSettings, settings.collapsed],
	);
	const onOptions = useCallback(
		(key: string) => openLayer({ kind: "sheet", name: "sidebar-rollup", locator: key }, { fromDrawer: true }),
		[],
	);
	const ownerNewIn = owner ? onNewIn : undefined;
	useEffect(
		() =>
			publishPage({
				rows: rolledUp,
				rollups,
				context,
				view,
				// A project's list waits for the projects too: before them it would say the list is gone.
				loading: (page) => !list || (page.startsWith("project:") && projects === undefined),
				connected,
				onOpen,
				onRestore,
				...(onSearch ? { onSearch } : {}),
				...(ownerNewIn ? { onNewIn: ownerNewIn } : {}),
			}),
		[rolledUp, rollups, context, view, list, projects, connected, onOpen, onRestore, onSearch, ownerNewIn],
	);
	const rollupSheet = useSheet("sidebar-rollup");
	const optionsOf = rollupSheet && sections.find((section) => section.key === rollupSheet.locator);
	/** A rollup's options: its window, and moving it among the rollups. */
	const rollupActions = (key: string) => {
		const at = rollups.findIndex((rollup) => rollup.key === key);
		const move = (by: -1 | 1) => () => {
			const order = moved(rollups, key, by);
			changeSettings({ order }, (live) => live.setOrder({ order }, BACKGROUND_CONTEXT));
		};
		return {
			onWindow: (window: SidebarWindow) =>
				changeSettings({ windows: { ...settings.windows, [key]: window } }, (live) =>
					live.setWindow({ key, window }, BACKGROUND_CONTEXT),
				),
			onMove: { ...(at > 0 ? { up: move(-1) } : {}), ...(at < rollups.length - 1 ? { down: move(1) } : {}) },
		};
	};
	return (
		<DrawerRowsContext.Provider value={drawerRows}>
			<SidebarView
				rows={rows}
				sections={sections}
				now={view.now}
				page={route.page}
				head={head}
				guest={guest}
				activeId={route.session}
				conversationId={route.conversation}
				connected={connected}
				onOpen={onOpen}
				onBranch={catalog ? onBranch : undefined}
				onRenameBranch={catalog ? onRenameBranch : undefined}
				onRestore={onRestore}
				onNew={onNew}
				onNewIn={ownerNewIn}
				onOptions={owner ? onOptions : undefined}
				onCollapse={owner ? onCollapse : undefined}
				onPage={openPage}
				onCollapseSidebar={toggleSidebar}
				footerActions={actions}
			/>
			{optionsOf && (
				<RollupSheet
					key={optionsOf.key}
					section={optionsOf}
					{...rollupActions(optionsOf.key)}
					onClose={closeLayers}
				/>
			)}
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
		</DrawerRowsContext.Provider>
	);
}

/** A rollup's or a group's list in the main area (`Route.page`), from the sidebar's data (`publishPage`). */
function SectionPage() {
	const route = useRoute();
	const data = useSyncExternalStore(subscribePage, () => pageData);
	const page = route.page;
	const list = useMemo(
		() => data && page !== undefined && listPageOf(page, data.rollups, data.rows, data.context, data.view),
		[data, page],
	);
	if (!data || page === undefined) return null;
	return (
		<ListPage
			key={page}
			page={page}
			data={list || undefined}
			loading={data.loading(page)}
			connected={data.connected}
			actions={{
				conversationId: route.conversation,
				now: data.view.now,
				onOpen: data.onOpen,
				onRestore: data.onRestore,
			}}
			{...(data.onSearch ? { onSearch: data.onSearch } : {})}
			{...(data.onNewIn ? { onNewIn: data.onNewIn } : {})}
		/>
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
		self.contribute(Slots, { sidebar: Sidebar, page: SectionPage, "session-options": SessionOptions });
	});
});
