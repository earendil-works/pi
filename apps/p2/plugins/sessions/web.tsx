// The sidebar and its list pages (sidebar/: the rollups' rules and their views) with the catalog, status, subagent,
// search, project and settings handles supplying their data, the owner's session actions on the rows, the session
// and rollup sheets, and the sessions' command menu commands (commands.tsx).

import {
	Access,
	BACKGROUND_CONTEXT,
	contribute,
	defineFacet,
	grantMode,
	kept,
	keptWith,
	live,
	liveWith,
	type Ref,
	whenLive,
} from "@p2/app/v1";
import {
	CommandPages,
	CommandSearches,
	Commands,
	closeLayers,
	getNavigation,
	type Layer,
	MoreIcon,
	NEW_SESSION,
	navigate,
	openLayer,
	openPage,
	rememberMains,
	SlotList,
	Slots,
	startNewSession,
	toggleSidebar,
	useComposerState,
	useConnected,
	useHost,
	useNavigation,
	useObject,
	useOptimisticCall,
	useOwner,
	useReadable,
	useRoute,
	useSheet,
} from "@p2/app/v1/web";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Envs } from "../envs/contract.ts";
import { DirectoryPicker, directoryPickerLayer } from "../envs/contract.web.tsx";
import {
	type ArchivedProject,
	type Project,
	ProjectCoordinators,
	type ProjectPlace,
	Projects,
} from "../projects/contract.ts";
import { SidebarRollups } from "../rollups/contract.ts";
import { Search, SessionReads } from "../search/contract.ts";
import { SessionStatus } from "../status/contract.ts";
import { type Child, Subagents } from "../subagents/contract.ts";
import { branchOf } from "../tree/branch-target.ts";
import { SessionTree } from "../tree/contract.ts";
import { archiveSubagent, stopRuns } from "./agent-actions.ts";
import { BRANCH_SHEET, BranchSheet } from "./BranchSheet.tsx";
import { SESSION_COMMANDS, SESSION_PAGES, SESSION_SEARCH } from "./commands.tsx";
import {
	type Operation,
	SESSIONS_OWNER,
	type Session,
	Sessions,
	SidebarSettings,
	type SidebarWindow,
} from "./contract.ts";
import { type DrawerRows, DrawerRowsContext } from "./contract.web.tsx";
import {
	locatingProject,
	PROJECT_COMMANDS,
	PROJECT_LOCATION,
	PROJECT_PAGES,
	projectJoin,
} from "./project-commands.tsx";
import { SessionSheet } from "./SessionSheet.tsx";
import { customKey, customRollup } from "./sidebar/custom.ts";
import { ListPage } from "./sidebar/ListPage.tsx";
import {
	ARCHIVE,
	arranged,
	listPageOf,
	movable,
	moved,
	type NewTarget,
	OTHER,
	PROJECTS,
	ROLLUPS,
	type RollupContext,
	type SidebarRow,
	sectionsOf,
	type Wanting,
	wantingOf,
} from "./sidebar/model.ts";
import { NEW_PROJECT, NewProjectSheet, newProjectLayer, PROJECT_FOLDER, placeOf } from "./sidebar/NewProjectSheet.tsx";
import { publishPage, usePageData } from "./sidebar/page-data.ts";
import { type CodeSource, RollupSheet } from "./sidebar/RollupSheet.tsx";
import { folderName } from "./sidebar/Row.tsx";
import { type Coordinators, SidebarView, useNow } from "./sidebar/Sidebar.tsx";

/** Closes the top layer only (a sheet), keeping those below it (a phone's drawer). */
const closeTopLayer = () => void getNavigation().close((route) => ({ ...route, layers: route.layers.slice(0, -1) }));

/** No archived projects (one value, so the page data keeps its identity across renders). */
const NO_ARCHIVED: readonly ArchivedProject[] = [];

/** The projects and the sessions' projects as the sidebar shows them: as known, with the owner's moves in flight. */
type ProjectsShown = {
	readonly projects: readonly Project[] | undefined;
	readonly memberships: Readonly<Record<string, string>> | undefined;
};

/** A move in flight: a session to a project (null: to none), or a project before another one (null: to the end). */
type ProjectGuess =
	| { readonly kind: "assign"; readonly session: string; readonly project: string | null }
	| { readonly kind: "move"; readonly name: string; readonly before: string | null };

/** `shown` with `guess` applied, as the server will have it. */
function applyProjectGuess(shown: ProjectsShown, guess: ProjectGuess): ProjectsShown {
	if (guess.kind === "assign") {
		const { [guess.session]: _left, ...others } = shown.memberships ?? {};
		return { ...shown, memberships: guess.project === null ? others : { ...others, [guess.session]: guess.project } };
	}
	const list = shown.projects ?? [];
	const moved = list.find((project) => project.name === guess.name);
	if (!moved || guess.before === guess.name) return shown;
	const rest = list.filter((project) => project !== moved);
	const at = guess.before === null ? -1 : rest.findIndex((project) => project.name === guess.before);
	return { ...shown, projects: at === -1 ? [...rest, moved] : [...rest.slice(0, at), moved, ...rest.slice(at)] };
}

/** A session without subagents (one value, so its rows keep their identity across renders). */
const NO_SUBAGENTS: readonly Child[] = [];

const subscribeVisibility = (listener: () => void) => {
	document.addEventListener("visibilitychange", listener);
	return () => document.removeEventListener("visibilitychange", listener);
};
/** Whether the page is shown (not a background tab or a hidden app). */
const usePageVisible = () => useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible");

/** Rows before the sidebar's "New session", each a list item (`sidebar-start:<name>`, e.g. the Familiar's). */
const startRows = <SlotList prefix="sidebar-start" />;
/** Icon buttons at the footer's end, before the theme switch (`sidebar-actions:<name>`, e.g. the Settings gear). */
const actions = <SlotList prefix="sidebar-actions" />;
/** Icon buttons in the header, before the collapse button (`sidebar-header:<name>`, e.g. the scope prompt's). */
const headerActions = <SlotList prefix="sidebar-header" />;

/** The sidebar's New session: the new-session screen, without the project or model chosen before. */
const newSession = () => startNewSession();

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

/** A subagent archived while its call is in flight. */
type ChildGuess = { readonly session: string; readonly conversation: number };
type Children = Readonly<Record<string, readonly Child[]>>;
const applyArchived = (children: Children | undefined, { session, conversation }: ChildGuess): Children | undefined =>
	children && {
		...children,
		[session]: (children[session] ?? []).map((child) =>
			child.conversationId === conversation ? { ...child, archived: true } : child,
		),
	};

/** The owner's sidebar settings (`SidebarSettings`): the rollups' order and windows, collapsed rollups and groups. */
type Settings = {
	readonly order: readonly string[];
	readonly windows: Readonly<Record<string, SidebarWindow>>;
	readonly collapsed: Readonly<Record<string, boolean>>;
};
const applySettings = (state: Settings, change: Partial<Settings>): Settings => ({ ...state, ...change });
const NO_SETTINGS: Settings = { order: [], windows: {}, collapsed: {} };

// What the other sessions want from the owner, for the menu button's badge (`MenuBadge`), which the top bars render
// outside the sidebar; published by the sidebar, which holds the rows. A new value only when it changed.
const wantingListeners = new Set<() => void>();
let wanting: Wanting = { count: 0, failed: false };
const subscribeWanting = (listener: () => void) => {
	wantingListeners.add(listener);
	return () => wantingListeners.delete(listener);
};
function publishWanting(next: Wanting): void {
	if (next.count === wanting.count && next.failed === wanting.failed) return;
	wanting = next;
	for (const listener of wantingListeners) listener();
}

/**
 * The sessions as the sidebar and its list pages show them, and what they act with: the catalog's rows (with a row's
 * edit shown at once), their state (working, unread, failed, an operation), what the rollups collect from (projects),
 * the owner's settings, opening and restoring a session, and its items' actions (stopping runs, archiving a session or
 * a subagent). Reads use `keptIn`: while the connection is down the rows stay as last seen; actions need the live
 * objects.
 */
function useSidebarData() {
	const route = useRoute();
	const host = useHost();
	const nav = useNavigation();
	const service = useObject(Sessions, {});
	const catalog = liveWith(service, ...SESSIONS_OWNER);
	// As the server last said (kept across starts): unread marks and search hold without waiting for Access.
	const owner = useOwner();
	const status = keptWith(useObject(SessionStatus, {}), "statuses");
	const agents = keptWith(useObject(Subagents, {}), "children");
	const { fail, focusWhenOpen } = useComposerState();
	const [list, edit] = useOptimisticCall(useReadable(keptWith(service, "sessions")?.sessions), applyRow, fail);
	const statuses = useReadable(status?.statuses);
	// A subagent's Archive hides it at once; the worker's report follows (or the call fails and it shows again).
	const [children, archiving] = useOptimisticCall(useReadable(agents?.children), applyArchived, fail);
	// Unread answers are the owner's (any device); guests see none and mark nothing.
	const marks = useObject(SessionReads, owner ? {} : undefined);
	const answers = useReadable(marks?.answers);
	const reads = useReadable(marks?.reads);
	// Dismissing a failed operation removes its line at once.
	const [operations, dismissing] = useOptimisticCall(
		useReadable(keptWith(service, ...SESSIONS_OWNER)?.operations) ?? [],
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
						work: statuses?.[session.id]?.work ?? {},
						error: statuses?.[session.id]?.error,
						failure: statuses?.[session.id]?.failure,
						unread: (answers?.[session.id] ?? 0) > (reads?.[session.id] ?? 0),
					},
					subagents: children?.[session.id] ?? NO_SUBAGENTS,
					operation: operationOf(operations, session.id, dismiss),
				};
			}),
		[list, statuses, children, answers, reads, operations, dismiss],
	);
	// The projects rollup reads the projects and the sessions' projects (`Projects`, from the projects plugin); moving a
	// session or a project shows at once.
	const projectsHeld = useObject(Projects, owner ? {} : undefined);
	const projectsKept = kept(projectsHeld);
	const knownProjects = useReadable(projectsKept?.projects);
	const knownMemberships = useReadable(projectsKept?.sessions);
	const archivedProjects = useReadable(projectsKept?.archived) ?? NO_ARCHIVED;
	const [shownProjects, guessProjects] = useOptimisticCall<ProjectsShown, ProjectGuess>(
		useMemo(() => ({ projects: knownProjects, memberships: knownMemberships }), [knownProjects, knownMemberships]),
		applyProjectGuess,
		fail,
	);
	const { projects, memberships } = shownProjects;
	/** Shows `guess` at once and calls `call` with the live projects; offline the call fails, rolling it back. */
	const changeProjects = useCallback(
		(guess: ProjectGuess, call: (live: Ref<typeof Projects>) => Promise<unknown>) =>
			guessProjects(guess, async () => {
				const live = liveWith(projectsHeld);
				if (!live) throw new Error("Not connected");
				await call(live);
			}),
		[guessProjects, projectsHeld],
	);
	const onAssign = useCallback(
		(session: string, project: string | null) =>
			changeProjects({ kind: "assign", session, project }, (live) =>
				live.assign({ session, project }, BACKGROUND_CONTEXT),
			),
		[changeProjects],
	);
	const onMoveProject = useCallback(
		(name: string, before: string | null) =>
			changeProjects({ kind: "move", name, before }, (live) => live.move({ name, before }, BACKGROUND_CONTEXT)),
		[changeProjects],
	);
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
	const settingsKept = kept(settingsHeld);
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
		(change: Partial<Settings>, call: (live: Ref<typeof SidebarSettings>) => Promise<unknown>) =>
			guessSettings(change, async () => {
				const live = liveWith(settingsHeld);
				if (!live) throw new Error("Not connected");
				await call(live);
			}),
		[guessSettings, settingsHeld],
	);
	// Rollups made from code (plugins/rollups), before the Archive until the owner moves them.
	const rollupsHeld = useObject(SidebarRollups, owner ? {} : undefined);
	const entries = useReadable(keptWith(rollupsHeld, "rollups")?.rollups);
	const rollups = useMemo(() => {
		const custom = (entries ?? []).map(customRollup);
		const archive = ROLLUPS.filter((rollup) => rollup.key === ARCHIVE);
		return arranged([...ROLLUPS.filter((rollup) => rollup.key !== ARCHIVE), ...custom, ...archive], settings.order);
	}, [entries, settings.order]);
	const now = useNow();
	const view = useMemo(
		() => ({ windows: settings.windows, collapsed: settings.collapsed, now, open: route.session }),
		[settings, now, route.session],
	);
	// A session opens at its main conversation; `/s/<id>` would open conversation 1, which redirects there.
	const targetOf = useCallback(
		(session: string, conversation?: number) => ({
			session,
			conversation: conversation ?? list?.find((each) => each.id === session)?.main ?? 1,
		}),
		[list],
	);
	// The opened composer takes the focus, unless a touch opened it: that would open the keyboard, which a tap on the
	// composer does.
	const onOpen = useCallback(
		(session: string, conversation?: number) => {
			const target = targetOf(session, conversation);
			focusWhenOpen(target);
			navigate(target);
		},
		[targetOf, focusWhenOpen],
	);
	// The restored row is back at once; the session opens once the server has it (an archived one would bounce).
	const onRestore = useCallback(
		(id: string, conversation?: number) => {
			if (!catalog) return;
			const target = targetOf(id, conversation);
			const cancel = focusWhenOpen(target);
			edit({ id, change: { archivedAt: null } }, async () => {
				try {
					await catalog.restore({ id }, BACKGROUND_CONTEXT);
				} catch (error) {
					cancel();
					throw error;
				}
				navigate(target);
			});
		},
		[catalog, edit, targetOf, focusWhenOpen],
	);
	// Who may act on a session's agents: the owner, and a guest with read/write access to it.
	const access = useObject(Access, {});
	const guest = useReadable(keptWith(access, "grant")?.grant);
	const writable = useCallback((session: string) => owner || grantMode(guest, session) === "full", [owner, guest]);
	// An item's Cancel: its runs stop; the inputs they had queued wait as drafts in their conversations.
	const onCancel = useCallback(
		(session: string, conversations: readonly number[]) => void stopRuns(host, session, conversations).catch(fail),
		[host, fail],
	);
	// A session's Archive (the owner's): gone at once, as the Session sheet's Archive; the open one leaves the page.
	const onArchive = useCallback(
		(id: string) =>
			edit({ id, change: { archivedAt: Date.now() } }, async () => {
				if (!catalog) throw new Error("Not connected");
				if (route.session === id) void nav.replace(NEW_SESSION);
				await catalog.archive({ id }, BACKGROUND_CONTEXT);
			}),
		[catalog, route.session, nav, edit],
	);
	const onArchiveAgent = useCallback(
		(session: string, conversation: number) =>
			archiving({ session, conversation }, () => archiveSubagent(host, session, conversation)),
		[archiving, host],
	);
	const searchHeld = useObject(Search, owner ? {} : undefined);
	const search = live(searchHeld);
	// The owner's lists keep their search field while offline; a search waits for the connection (the page skips it).
	const onSearch = useMemo(
		() =>
			searchHeld &&
			((query: string, archived: boolean, sessions: readonly string[]) => {
				const live = liveWith(searchHeld);
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
		archivedProjects,
		onAssign,
		onMoveProject,
		context,
		settings,
		changeSettings,
		rollups,
		rollupsHeld,
		entries,
		view,
		onOpen,
		onRestore,
		guest,
		writable,
		onCancel,
		onArchive: owner ? onArchive : undefined,
		onArchiveAgent,
	};
}

/**
 * The sidebar, and the owner's actions on it: the session actions (rename, pin, archive and restore: the Session sheet
 * is rendered here, opened from the top bar's button), renaming a `/tree` branch (its sheet; the tree panel's command
 * menu opens it), a group's "+", New project, a rollup's options and collapsing rollups and groups. Each action shows
 * its effect at once (`useOptimisticCall`); a refused one rolls back and the toast says why.
 */
function Sidebar() {
	const connected = useConnected();
	const nav = useNavigation();
	const data = useSidebarData();
	const { route, catalog, owner, fail, list, edit, rows, answers, reads, marks, search, settings, changeSettings } =
		data;
	const { rollups, rollupsHeld, entries, context, view, onOpen, onRestore, guest } = data;
	// Sessions a plugin's sidebar entry shows (the Familiar's, a `sidebar-start` row) are left out of the rollups.
	const [apart, setApart] = useState<Readonly<Record<string, readonly string[]>>>({});
	const listApart = useCallback(
		(key: string, ids: readonly string[]) => setApart((current) => ({ ...current, [key]: ids })),
		[],
	);
	const drawerRows = useMemo<DrawerRows>(() => ({ sessions: rows, listApart }), [rows, listApart]);
	// Each project's coordinator: its project's row stands for it, so it is left out of the rollups too.
	const coordinatorsHeld = useObject(ProjectCoordinators, owner ? {} : undefined);
	const coordinatorSessions = useReadable(kept(coordinatorsHeld)?.sessions);
	const rolledUp = useMemo(() => {
		const hidden = new Set([...Object.values(apart).flat(), ...Object.values(coordinatorSessions ?? {})]);
		return hidden.size ? rows.filter((row) => !hidden.has(row.id)) : rows;
	}, [rows, apart, coordinatorSessions]);
	const { onSearch, projects } = data;
	// The owner's sessions are grouped by project: until the projects and their coordinators are known, they would all
	// show without one (a coordinator among its project's sessions), then jump into their places.
	const projectsUnknown = owner && (projects === undefined || coordinatorSessions === undefined);
	const sections = useMemo(
		() => (projectsUnknown ? [] : sectionsOf(rollups, rolledUp, context, view)),
		[projectsUnknown, rollups, rolledUp, context, view],
	);
	// A project's name opens its coordinator; the server makes or restores it first when it has to, one open at a time.
	const openingProject = useRef(false);
	const coordinators = useMemo((): Coordinators | undefined => {
		if (!owner) return undefined;
		const byId = new Map(rows.map((row) => [row.id, row]));
		const rowOf = (project: string) => {
			const id = coordinatorSessions?.[project];
			return id === undefined ? undefined : byId.get(id);
		};
		return {
			rowOf,
			onOpen: (project) => {
				const row = rowOf(project);
				if (row && row.archivedAt === null) return onOpen(row.id);
				const live = liveWith(coordinatorsHeld);
				if (!live) return fail(new Error("Not connected"));
				if (openingProject.current) return;
				openingProject.current = true;
				void live
					.open({ name: project }, BACKGROUND_CONTEXT)
					.then(({ id }) => onOpen(id))
					.catch(fail)
					.finally(() => {
						openingProject.current = false;
					});
			},
		};
	}, [owner, coordinatorSessions, rows, coordinatorsHeld, onOpen, fail]);
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
	// A branch's rename: a reference of its own (the change also reaches the session row).
	const host = useHost();
	const withTree = useCallback(
		(session: string, action: (tree: Ref<typeof SessionTree>) => Promise<unknown>) => {
			const held = host.hold(SessionTree, { session }, BACKGROUND_CONTEXT);
			return whenLive(held)
				.then(() => {
					const tree = live(held);
					if (!tree) throw new Error("Only the owner changes branches");
					return action(tree);
				})
				.finally(() => held.release());
		},
		[host],
	);
	// The Projects rollup's "+": the folder picker, then the sheet naming the project (each a layer over the drawer).
	const onNewProject = useCallback(
		() => openLayer(directoryPickerLayer(null, "~", PROJECT_FOLDER), { fromDrawer: true }),
		[],
	);
	// A branch's rename sheet: a layer "Rename branch…" opens (commands.tsx; the tree panel's branch labels target it).
	const branchSheet = useSheet(BRANCH_SHEET);
	const renaming = branchOf(branchSheet?.locator);
	const renamed = renaming && list?.find((each) => each.id === renaming.session);
	const branch = renamed?.branches.find((each) => each.conversation === renaming?.conversation);
	// A layer naming no branch of the loaded sessions (an old address, a branch of a deleted session) goes away.
	const staleBranchSheet = branchSheet !== undefined && list !== undefined && branch === undefined;
	useEffect(() => {
		if (staleBranchSheet) closeLayers();
	}, [staleBranchSheet]);
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
	const { projectsHeld, archivedProjects, onAssign, onMoveProject, writable, onCancel, onArchive, onArchiveAgent } =
		data;
	/**
	 * A group's "+": a folder's new session starts in the folder; a project's joins the project (once it exists) and
	 * starts at its default place.
	 */
	const onNewIn = useCallback(
		(target: NewTarget) => {
			if (target.kind === "folder") return startNewSession({ location: { env: target.env, cwd: target.cwd } });
			const place = target.project.places[0];
			startNewSession({
				...(place ? { location: { env: place.env, cwd: place.path } } : {}),
				join: projectJoin(host, target.project.name),
			});
		},
		[host],
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
	const drop = useMemo(() => (owner ? { onAssign, onMoveProject } : undefined), [owner, onAssign, onMoveProject]);
	useEffect(() => publishWanting(wantingOf(rows, route.session)), [rows, route.session]);
	useEffect(
		() =>
			publishPage({
				rows: rolledUp,
				rollups,
				context,
				view,
				// A project's list and the sessions without one wait for the projects too, a rollup made from code for the
				// rollups: before them they would show the wrong sessions, or say the list is gone.
				loading: (page) =>
					!list ||
					((page === OTHER || page.startsWith("project:")) && projectsUnknown) ||
					(page.startsWith("rollup:") && entries === undefined),
				connected,
				onOpen,
				onRestore,
				writable,
				onCancel,
				...(onArchive ? { onArchive } : {}),
				onArchiveAgent,
				...(onSearch ? { onSearch } : {}),
				...(ownerNewIn ? { onNewIn: ownerNewIn } : {}),
				archivedProjects,
				...(owner ? { onAssign, onMoveProject } : {}),
			}),
		[
			rolledUp,
			rollups,
			context,
			view,
			list,
			owner,
			projectsUnknown,
			entries,
			connected,
			onOpen,
			onRestore,
			writable,
			onCancel,
			onArchive,
			onArchiveAgent,
			onSearch,
			ownerNewIn,
			archivedProjects,
			onAssign,
			onMoveProject,
		],
	);
	const rollupSheet = useSheet("sidebar-rollup");
	const optionsOf = rollupSheet && sections.find((section) => section.key === rollupSheet.locator);
	const [refreshing, setRefreshing] = useState<string>();
	/** The options of a rollup made from code: its refresh, last check and failure, and Refresh now while connected. */
	const codeOf = (key: string): CodeSource | undefined => {
		const entry = entries?.find((each) => customKey(each.definition.key) === key);
		if (!entry) return undefined;
		const live = liveWith(rollupsHeld, "rollups");
		const refresh = () => {
			if (!live) return;
			setRefreshing(key);
			void live
				.refresh({ key: entry.definition.key }, BACKGROUND_CONTEXT)
				.catch(fail)
				.finally(() => setRefreshing(undefined));
		};
		return {
			refresh: entry.definition.refresh,
			checkedAt: entry.checkedAt,
			error: entry.error,
			refreshing: refreshing === key,
			...(live ? { onRefresh: refresh } : {}),
		};
	};
	const projectFolder = useSheet(PROJECT_FOLDER);
	// A project's Change default location… (project-commands.tsx): the picker, then the project's new default place.
	const projectLocation = useSheet(PROJECT_LOCATION);
	const locating = projectLocation && context.projects.find((project) => project.name === locatingProject());
	const withProjects = (action: (live: Ref<typeof Projects>) => Promise<unknown>) => {
		const live = liveWith(projectsHeld);
		return live ? action(live).catch(fail) : fail(new Error("Not connected"));
	};
	const newProject = useSheet(NEW_PROJECT);
	const newPlace = placeOf(newProject?.locator);
	/** Each step of New project is a layer over the rollup's options: Back returns to the previous one. */
	const pushLayer = (layer: Layer) => {
		const nav = getNavigation();
		void nav.push({ ...nav.route, layers: [...nav.route.layers, layer] });
	};
	const createProject = async (name: string, place: ProjectPlace) => {
		const live = liveWith(projectsHeld);
		if (!live) throw new Error("Not connected");
		await live.create({ name, place }, BACKGROUND_CONTEXT);
	};
	/** A rollup's options: its window, and moving it among the rollups with a heading (one without stays first). */
	const rollupActions = (key: string) => {
		const ordering = movable(rollups);
		const at = ordering.findIndex((rollup) => rollup.key === key);
		const move = (by: -1 | 1) => () => {
			const order = moved(ordering, key, by);
			changeSettings({ order }, (live) => live.setOrder({ order }, BACKGROUND_CONTEXT));
		};
		return {
			onWindow: (window: SidebarWindow) =>
				changeSettings({ windows: { ...settings.windows, [key]: window } }, (live) =>
					live.setWindow({ key, window }, BACKGROUND_CONTEXT),
				),
			onMove: {
				...(at > 0 ? { up: move(-1) } : {}),
				...(at >= 0 && at < ordering.length - 1 ? { down: move(1) } : {}),
			},
		};
	};
	return (
		<DrawerRowsContext.Provider value={drawerRows}>
			<SidebarView
				rows={rows}
				sections={sections}
				now={view.now}
				page={route.page}
				newSession={route.newSession === true}
				startRows={startRows}
				guest={guest}
				activeId={route.session}
				conversationId={route.conversation}
				connected={connected}
				onOpen={onOpen}
				onRestore={onRestore}
				writable={writable}
				onCancel={onCancel}
				onArchive={onArchive}
				onArchiveAgent={onArchiveAgent}
				onNew={newSession}
				onNewIn={ownerNewIn}
				onNewProject={owner && projectsHeld ? onNewProject : undefined}
				onOptions={owner ? onOptions : undefined}
				onCollapse={owner ? onCollapse : undefined}
				onPage={openPage}
				onCollapseSidebar={toggleSidebar}
				{...(drop ? { drop } : {})}
				{...(coordinators ? { coordinators } : {})}
				headerActions={headerActions}
				footerActions={actions}
			/>
			{optionsOf && (
				<RollupSheet
					key={optionsOf.key}
					section={optionsOf}
					code={codeOf(optionsOf.key)}
					now={view.now}
					{...(optionsOf.key === PROJECTS
						? { onNewProject: () => pushLayer(directoryPickerLayer(null, "~", PROJECT_FOLDER)) }
						: {})}
					{...rollupActions(optionsOf.key)}
					onClose={closeLayers}
				/>
			)}
			{projectFolder && (
				<DirectoryPicker
					sheet={PROJECT_FOLDER}
					title="Project folder"
					sessions={list}
					env={null}
					value="~"
					onChange={(env, path) => pushLayer(newProjectLayer({ env, path }))}
					onClose={closeLayers}
				/>
			)}
			{projectLocation && locating && (
				<DirectoryPicker
					sheet={PROJECT_LOCATION}
					title={`Default location of ${locating.name}`}
					sessions={list}
					env={locating.places[0]?.env ?? null}
					value={locating.places[0]?.path ?? "~"}
					onChange={(env, path) => {
						closeLayers();
						void withProjects((live) =>
							live.locate({ name: locating.name, place: { env, path } }, BACKGROUND_CONTEXT),
						);
					}}
					onClose={closeLayers}
				/>
			)}
			{newProject && newPlace && (
				<NewProjectSheet
					key={newProject.locator}
					place={newPlace}
					taken={[...context.projects, ...archivedProjects].map((project) => project.name)}
					onCreate={(name) => createProject(name, newPlace)}
					onClose={closeLayers}
				/>
			)}
			{catalog && renamed && branch && (
				<BranchSheet
					title={renamed.title}
					conversation={branch.conversation}
					label={branch.label}
					onSave={(label) => renameBranch(renamed, branch.conversation, label)}
					// Only the sheet closes: a phone's drawer it was opened over stays open.
					onClose={closeTopLayer}
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
						void nav.replace(NEW_SESSION);
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
	const data = usePageData();
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
				writable: data.writable,
				onCancel: data.onCancel,
				...(data.onArchive ? { onArchive: data.onArchive } : {}),
				onArchiveAgent: data.onArchiveAgent,
			}}
			{...(data.onSearch ? { onSearch: data.onSearch } : {})}
			{...(data.onNewIn ? { onNewIn: data.onNewIn } : {})}
			archivedProjects={data.archivedProjects}
		/>
	);
}

/**
 * The menu button's badge (the `menu-badge` slot): how many other sessions want the owner (a failure or an unread
 * answer), in the error colour when one failed, else the unread blue. Steady: only working moves in the sidebar.
 */
function MenuBadge() {
	const { count, failed } = useSyncExternalStore(subscribeWanting, () => wanting);
	if (count === 0) return null;
	return (
		<span
			className={`menu-badge ${failed ? "failed" : ""}`}
			title={failed ? `${count} want you, a failure among them` : `${count} with a new answer`}
		>
			{count}
		</span>
	);
}

/** The top bar's button that opens the Session sheet (the drawer renders the sheet, where the rows are). */
function SessionOptions() {
	const route = useRoute();
	const rows = useReadable(liveWith(useObject(Sessions, {}), ...SESSIONS_OWNER)?.sessions);
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
		self.contribute(Slots, {
			sidebar: Sidebar,
			page: SectionPage,
			"session-options": SessionOptions,
			"menu-badge": MenuBadge,
		});
		self.contribute(Commands, { ...SESSION_COMMANDS, ...PROJECT_COMMANDS });
		self.contribute(CommandPages, { ...SESSION_PAGES, ...PROJECT_PAGES });
		self.contribute(CommandSearches, { sessions: SESSION_SEARCH });
	});
});
