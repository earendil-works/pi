// The sidebar's rules, as pure functions over what p2 already knows. A rollup is a rule that collects sessions into one
// section of the sidebar: a flat list (Recents), groups of sessions (one per project, one per folder), or only a link to
// its list (the Archive). The sidebar shows each rollup's relevant sessions (relevance and the rollup's window); its
// list page shows them all, those that fell out of the window aged. No React: the views render what these return.
import type { Project } from "../../projects/contract.ts";
import type { Child } from "../../subagents/contract.ts";
import type { Session, SidebarWindow } from "../contract.ts";

/** A session as the sidebar shows it: its catalog row with its subagents, its worker's state and an operation. */
export type SidebarRow = Session & {
	subagents: Child[];
	/** `unread`: a finished answer the owner has not read on any device (see `SessionReads`). */
	worker: { busy: number[]; error?: string; unread?: boolean };
	/** A lifecycle operation of the session: running (`label` only), or failed with its error and a Dismiss. */
	operation?: { readonly label: string; readonly error?: string; readonly dismiss?: () => void };
};

/** Where a group's "+" starts a new session: in a folder, or in a project (at one of its places). */
export type NewTarget = { kind: "folder"; env: string | null; cwd: string } | { kind: "project"; project: Project };

/** A group a rollup collected: its key, name (and a longer title), its sessions and where a new one starts. */
export type Group = {
	readonly key: string;
	readonly name: string;
	readonly title?: string;
	readonly members: readonly SidebarRow[];
	readonly target: NewTarget;
};

/** What a rollup collects: a flat list of sessions, groups of sessions, or sessions shown only in its list page. */
export type Collected =
	| { readonly layout: "sessions"; readonly members: readonly SidebarRow[] }
	| { readonly layout: "groups"; readonly groups: readonly Group[] }
	| { readonly layout: "link"; readonly members: readonly SidebarRow[] };

/** What rollups collect from besides the sessions: the projects and their sessions, and how a folder is named. */
export type RollupContext = {
	readonly projects: readonly Project[];
	readonly memberships: Readonly<Record<string, string>>;
	readonly folderName: (env: string | null, cwd: string) => string;
};

/** A rule that turns sessions into one section of the sidebar. `archived`: it collects archived sessions. */
export type Rollup = {
	readonly key: string;
	readonly name: string;
	readonly archived: boolean;
	collect(rows: readonly SidebarRow[], context: RollupContext): Collected;
};

export const RECENT = "recent";
export const PROJECTS = "projects";
export const FOLDERS = "folders";
export const ARCHIVE = "archive";

export const projectKey = (name: string): string => `project:${name}`;
export const folderKey = (env: string | null, cwd: string): string => `folder:${JSON.stringify([env, cwd])}`;

const live = (rows: readonly SidebarRow[]) => rows.filter((row) => !row.archivedAt);

/** The built-in rollups, in their default order. */
export const ROLLUPS: readonly Rollup[] = [
	{
		key: RECENT,
		name: "Recents",
		archived: false,
		collect: (rows) => ({ layout: "sessions", members: live(rows) }),
	},
	{
		key: PROJECTS,
		name: "Projects",
		archived: false,
		// One group per project of projects.json that has sessions, in the file's order.
		collect: (rows, { projects, memberships }) => ({
			layout: "groups",
			groups: projects.flatMap((project) => {
				const members = live(rows).filter((row) => memberships[row.id] === project.name);
				return members.length
					? [{ key: projectKey(project.name), name: project.name, members, target: { kind: "project", project } }]
					: [];
			}),
		}),
	},
	{
		key: FOLDERS,
		name: "Folders",
		archived: false,
		// One group per folder sessions work in, by name.
		collect: (rows, { folderName }) => {
			const folders = new Map<string, { env: string | null; cwd: string; members: SidebarRow[] }>();
			for (const row of live(rows)) {
				const env = row.env ?? null;
				const key = folderKey(env, row.cwd);
				const folder = folders.get(key);
				if (folder) folder.members.push(row);
				else folders.set(key, { env, cwd: row.cwd, members: [row] });
			}
			const groups = [...folders].map(
				([key, { env, cwd, members }]): Group => ({
					key,
					name: folderName(env, cwd),
					title: env ? `${env}:${cwd}` : cwd,
					members,
					target: { kind: "folder", env, cwd },
				}),
			);
			return {
				layout: "groups",
				groups: groups.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)),
			};
		},
	},
	{
		key: ARCHIVE,
		name: "Archive",
		archived: true,
		collect: (rows) => ({ layout: "link", members: rows.filter((row) => row.archivedAt) }),
	},
];

/** The rollups in the owner's order: the keys in `order` first, then the rest in their default order. */
export function ordered(rollups: readonly Rollup[], order: readonly string[]): Rollup[] {
	const rank = new Map(order.map((key, index) => [key, index]));
	const placed = (rollup: Rollup) => rank.get(rollup.key) ?? Number.MAX_SAFE_INTEGER;
	// A stable sort: rollups the order does not name keep their default order behind the named ones.
	return rollups.toSorted((a, b) => placed(a) - placed(b));
}

/** The window of a rollup the owner did not set. */
export const DEFAULT_WINDOW: SidebarWindow = "3d";

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_MS: Record<SidebarWindow, number> = { "1d": DAY, "3d": 3 * DAY, "1w": 7 * DAY, forever: Infinity };

/** The windows a rollup offers, with their labels, shortest first. */
export const WINDOWS: readonly { readonly window: SidebarWindow; readonly label: string }[] = [
	{ window: "1d", label: "24 hours" },
	{ window: "3d", label: "3 days" },
	{ window: "1w", label: "1 week" },
	{ window: "forever", label: "Forever" },
];

/**
 * Whether the sidebar shows `row`: something keeps it in view (pinned, open now, working, an unread answer, a failed
 * worker, a running or failed operation), or it had activity within the rollup's window.
 */
export function isRelevant(row: SidebarRow, window: SidebarWindow, now: number, open: string | undefined): boolean {
	return (
		row.pinned ||
		row.id === open ||
		row.worker.busy.length > 0 ||
		Boolean(row.worker.unread) ||
		row.worker.error !== undefined ||
		row.operation !== undefined ||
		now - row.updatedAt < WINDOW_MS[window]
	);
}

/** Pinned sessions first, then the most recently active. */
const byPinThenActivity = (a: SidebarRow, b: SidebarRow) =>
	Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt;

/** The owner's sidebar settings (`SidebarSettings`), and what relevance depends on. */
export type View = {
	readonly windows: Readonly<Record<string, SidebarWindow>>;
	readonly collapsed: Readonly<Record<string, boolean>>;
	readonly now: number;
	readonly open: string | undefined;
};

/** A group in the sidebar: its relevant sessions and how many it has. */
export type GroupSection = Omit<Group, "members"> & { readonly rows: readonly SidebarRow[]; readonly total: number };

/** A rollup's section of the sidebar, by the layout of what it collected. */
export type Section = { readonly key: string; readonly name: string; readonly window: SidebarWindow } & (
	| {
			readonly layout: "sessions";
			readonly collapsed: boolean;
			readonly rows: readonly SidebarRow[];
			readonly total: number;
	  }
	| { readonly layout: "groups"; readonly collapsed: boolean; readonly groups: readonly GroupSection[] }
	| { readonly layout: "link"; readonly total: number }
);

/**
 * The sidebar's sections, one per rollup in order: each shows its relevant sessions, flat or in groups. A session shows
 * in every rollup and group that has it. A group shows only while it has relevant sessions; a rollup of groups shows
 * once it has a group (its heading opens them all), a link once it has a session.
 */
export function sectionsOf(
	rollups: readonly Rollup[],
	rows: readonly SidebarRow[],
	context: RollupContext,
	view: View,
): Section[] {
	return rollups.flatMap((rollup) => {
		const section = sectionOf(rollup, rows, context, view);
		return section ? [section] : [];
	});
}

/** Rollup `rollup`'s section, or undefined when it has nothing to show. */
function sectionOf(
	rollup: Rollup,
	rows: readonly SidebarRow[],
	context: RollupContext,
	view: View,
): Section | undefined {
	const window = view.windows[rollup.key] ?? DEFAULT_WINDOW;
	const collapsed = view.collapsed[rollup.key] ?? false;
	const relevant = (members: readonly SidebarRow[]) =>
		members.filter((row) => isRelevant(row, window, view.now, view.open)).sort(byPinThenActivity);
	const base = { key: rollup.key, name: rollup.name, window };
	const collected = rollup.collect(rows, context);
	if (collected.layout === "link")
		return collected.members.length === 0 ? undefined : { ...base, layout: "link", total: collected.members.length };
	if (collected.layout === "sessions")
		return {
			...base,
			layout: "sessions",
			collapsed,
			rows: collapsed ? [] : relevant(collected.members),
			total: collected.members.length,
		};
	if (collected.groups.length === 0) return undefined;
	const groups = collapsed
		? []
		: collected.groups.flatMap(({ members, ...group }) => {
				const shown = relevant(members);
				return shown.length === 0 ? [] : [{ ...group, rows: shown, total: members.length }];
			});
	return { ...base, layout: "groups", collapsed, groups };
}

/** A row of a list page: `aged` when it fell out of the rollup's window (still part of it, shown dimmed). */
export type ListEntry = { readonly row: SidebarRow; readonly aged: boolean };

/** A list page: a flat list of sessions, or groups with theirs, of one rollup or one of its groups. */
export type ListPageData = {
	readonly name: string;
	/** The rollup's window; absent for archived sessions. */
	readonly window?: SidebarWindow;
	readonly archived: boolean;
	readonly content:
		| { readonly layout: "sessions"; readonly entries: readonly ListEntry[] }
		| {
				readonly layout: "groups";
				readonly groups: readonly {
					readonly key: string;
					readonly name: string;
					readonly entries: readonly ListEntry[];
				}[];
		  };
};

/**
 * The list page of `key`, a rollup's or one of its groups' (a rollup of groups lists every group): every session, those
 * its rollup's window still shows first (pinned first, then the most recently active), then the aged ones; archived
 * sessions newest archived first. Undefined for a key no rollup
 * has (a folder without sessions any more).
 */
export function listPageOf(
	key: string,
	rollups: readonly Rollup[],
	rows: readonly SidebarRow[],
	context: RollupContext,
	view: View,
): ListPageData | undefined {
	for (const rollup of rollups) {
		const window = view.windows[rollup.key] ?? DEFAULT_WINDOW;
		const entries = (members: readonly SidebarRow[]): ListEntry[] =>
			rollup.archived
				? members.toSorted((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)).map((row) => ({ row, aged: false }))
				: members
						.map((row) => ({ row, aged: !isRelevant(row, window, view.now, view.open) }))
						.sort((a, b) => Number(a.aged) - Number(b.aged) || byPinThenActivity(a.row, b.row));
		const base = { archived: rollup.archived, ...(rollup.archived ? {} : { window }) };
		const collected = rollup.collect(rows, context);
		if (collected.layout === "groups") {
			if (key === rollup.key)
				return {
					...base,
					name: rollup.name,
					content: {
						layout: "groups",
						groups: collected.groups.map((group) => ({
							key: group.key,
							name: group.name,
							entries: entries(group.members),
						})),
					},
				};
			const group = collected.groups.find((each) => each.key === key);
			if (group)
				return { ...base, name: group.name, content: { layout: "sessions", entries: entries(group.members) } };
		} else if (key === rollup.key)
			return { ...base, name: rollup.name, content: { layout: "sessions", entries: entries(collected.members) } };
	}
	return undefined;
}

/** The rollups' keys in their order, with `key` moved one place up (`-1`) or down (`1`). */
export function moved(rollups: readonly Rollup[], key: string, by: -1 | 1): string[] {
	const keys = rollups.map((rollup) => rollup.key);
	const from = keys.indexOf(key);
	const to = from + by;
	if (from < 0 || to < 0 || to >= keys.length) return keys;
	const next = [...keys];
	[next[from], next[to]] = [next[to]!, next[from]!];
	return next;
}
