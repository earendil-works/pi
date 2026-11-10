// The sidebar's rules, as pure functions over what p2 already knows. A rollup is a rule that collects sessions into one
// section of the sidebar: a flat list (Recents), groups of sessions (one per project, one per folder), or only a link to
// its list (the Archive). The sidebar shows each rollup's relevant sessions (relevance and the rollup's window); its
// list page shows them all, those that fell out of the window aged. No React: the views render what these return.
import { placeSeed, projectSeed } from "../../glyphs/seed.ts";
import type { Project } from "../../projects/contract.ts";
import type { RollupWindow } from "../../rollups/contract.ts";
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

/**
 * A group a rollup collected: its key, name (and a longer title), its sessions and where a new one starts (none: no
 * "+"). `keep`: shown even without a relevant session.
 */
export type Group = {
	readonly key: string;
	readonly name: string;
	readonly title?: string;
	/** Its sessions run in a sandbox (a folder on a sandbox environment): it shows a lock. */
	readonly sandboxed: boolean;
	readonly members: readonly SidebarRow[];
	readonly target?: NewTarget;
	readonly keep?: boolean;
};

/** What a rollup collects: a flat list of sessions, groups of sessions, or sessions shown only in its list page. */
export type Collected =
	| { readonly layout: "sessions"; readonly members: readonly SidebarRow[] }
	| { readonly layout: "groups"; readonly groups: readonly Group[] }
	| { readonly layout: "link"; readonly members: readonly SidebarRow[] };

/** What rollups collect from besides the sessions: projects and their sessions, folder names, sandbox environments. */
export type RollupContext = {
	readonly projects: readonly Project[];
	readonly memberships: Readonly<Record<string, string>>;
	/** A folder's name in the sidebar; two folders of the same name get their parents (`disambiguate`). */
	readonly folderName: (env: string | null, cwd: string, segments: number) => string;
	readonly sandboxes: ReadonlySet<string>;
};

/**
 * A rule that turns sessions into one section of the sidebar. `archived`: it collects archived sessions. `prefix`: the
 * key prefix of the groups it collects. `window`: its window until the owner picks one (default 3 days; `none`: every
 * session it collects shows). `timeOf`: the time its window compares and its list sorts by (default `updatedAt`).
 * `keeps`: sessions it shows whatever their time, as pinned ones.
 */
export type Rollup = {
	readonly key: string;
	readonly name: string;
	readonly archived: boolean;
	readonly prefix?: string;
	readonly window?: RollupWindow;
	readonly timeOf?: (row: SidebarRow) => number;
	readonly keeps?: (row: SidebarRow) => boolean;
	collect(rows: readonly SidebarRow[], context: RollupContext): Collected;
};

/** A place's project glyph (plugins/glyphs): what it hashes, and the path its row's tooltip shows. */
export type GlyphSeed = { readonly seed: string; readonly title: string };

/** The sidebar's glyphs: a group's, by where its "+" starts a session; a session's, in a flat list (Recents). */
export type Glyphs = {
	readonly target: (target: NewTarget) => GlyphSeed;
	readonly row: (row: SidebarRow) => GlyphSeed;
};

/**
 * Glyphs by project (`placeSeed`): a project, its folders and its sessions show the project's glyph; any other place
 * its own path's. The tooltip is the place's path, a project's its places.
 */
export function glyphsOf({ projects, memberships }: Pick<RollupContext, "projects" | "memberships">): Glyphs {
	const label = (env: string | null, path: string) => (env ? `${env}:${path}` : path);
	const at = (env: string | null, cwd: string, member?: string): GlyphSeed => ({
		seed: placeSeed(projects, env, cwd, member),
		title: label(env, cwd),
	});
	return {
		target: (target) =>
			target.kind === "folder"
				? at(target.env, target.cwd)
				: {
						seed: projectSeed(target.project),
						title:
							target.project.places.map((place) => label(place.env, place.path)).join("\n") ||
							target.project.name,
					},
		row: (row) => at(row.env ?? null, row.cwd, memberships[row.id]),
	};
}

export const RECENT = "recent";
export const PROJECTS = "projects";
export const FOLDERS = "folders";
export const ARCHIVE = "archive";

export const projectKey = (name: string): string => `project:${name}`;

/** A folder's key: its environment and path, encoded (`keyPart`). */
export const folderKey = (env: string | null, cwd: string): string => `folder:${keyPart(JSON.stringify([env, cwd]))}`;

/** `text` base64url-encoded, so a key made of it has no slash (keys go into `/list/<key>`). */
export function keyPart(text: string): string {
	const bytes = new TextEncoder().encode(text);
	const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

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
		prefix: "project:",
		// One group per project of projects.json, in the file's order, sessions or not (a new one starts from its "+").
		collect: (rows, { projects, memberships }) => {
			const byProject = new Map<string, SidebarRow[]>();
			for (const row of live(rows)) {
				const project = memberships[row.id];
				if (project === undefined) continue;
				const members = byProject.get(project);
				if (members) members.push(row);
				else byProject.set(project, [row]);
			}
			return {
				layout: "groups",
				groups: projects.map((project) => ({
					key: projectKey(project.name),
					name: project.name,
					sandboxed: false,
					members: byProject.get(project.name) ?? [],
					target: { kind: "project", project },
				})),
			};
		},
	},
	{
		key: FOLDERS,
		name: "Folders",
		archived: false,
		prefix: "folder:",
		// One group per folder sessions work in, by name.
		collect: (rows, { folderName, sandboxes }) => {
			const folders = new Map<string, { env: string | null; cwd: string; members: SidebarRow[] }>();
			for (const row of live(rows)) {
				const env = row.env ?? null;
				const key = folderKey(env, row.cwd);
				const folder = folders.get(key);
				if (folder) folder.members.push(row);
				else folders.set(key, { env, cwd: row.cwd, members: [row] });
			}
			const names = disambiguate([...folders.values()], ({ env, cwd }, segments) => folderName(env, cwd, segments));
			const groups = [...folders].map(
				([key, folder], index): Group => ({
					key,
					name: names[index]!,
					title: folder.env ? `${folder.env}:${folder.cwd}` : folder.cwd,
					sandboxed: folder.env !== null && sandboxes.has(folder.env),
					members: folder.members,
					target: { kind: "folder", env: folder.env, cwd: folder.cwd },
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

/**
 * Names for `items` by `name(item, segments)`: one segment each, more for the items whose name another one shares,
 * until they differ (or stop changing: the same path on two machines differs by its machine only).
 */
function disambiguate<T>(items: readonly T[], name: (item: T, segments: number) => string): string[] {
	const names = items.map((item) => name(item, 1));
	for (let segments = 2; segments <= 8; segments++) {
		const counts = new Map<string, number>();
		for (const each of names) counts.set(each, (counts.get(each) ?? 0) + 1);
		const shared = names.flatMap((each, index) => ((counts.get(each) ?? 0) > 1 ? [index] : []));
		if (shared.length === 0) break;
		let changed = false;
		for (const index of shared) {
			const longer = name(items[index]!, segments);
			changed ||= longer !== names[index];
			names[index] = longer;
		}
		if (!changed) break;
	}
	return names;
}

/** The rollups in the owner's order: the keys in `order` first, then the rest in their default order. */
export function ordered(rollups: readonly Rollup[], order: readonly string[]): Rollup[] {
	const rank = new Map(order.map((key, index) => [key, index]));
	const placed = (rollup: Rollup) => rank.get(rollup.key) ?? Number.MAX_SAFE_INTEGER;
	// A stable sort: rollups the order does not name keep their default order behind the named ones.
	return rollups.toSorted((a, b) => placed(a) - placed(b));
}

const DEFAULT_WINDOW: SidebarWindow = "3d";
const DAY = 24 * 60 * 60 * 1000;
const WINDOW_MS: Record<RollupWindow, number> = {
	"1d": DAY,
	"3d": 3 * DAY,
	"1w": 7 * DAY,
	forever: Infinity,
	none: Infinity,
};

/** The windows a rollup offers, with their labels, shortest first. */
export const WINDOWS: readonly { readonly window: SidebarWindow; readonly label: string }[] = [
	{ window: "1d", label: "24 hours" },
	{ window: "3d", label: "3 days" },
	{ window: "1w", label: "1 week" },
	{ window: "forever", label: "Forever" },
];

/** A rollup's window: the owner's choice, else its own, else 3 days; a rollup without one (`none`) offers no choice. */
function windowOf(rollup: Rollup, view: View): RollupWindow {
	if (rollup.window === "none") return "none";
	return view.windows[rollup.key] ?? rollup.window ?? DEFAULT_WINDOW;
}

/** The time `rollup`'s window compares for `row`. */
const timeIn = (rollup: Rollup, row: SidebarRow) => rollup.timeOf?.(row) ?? row.updatedAt;

/**
 * Whether the sidebar shows `row` in `rollup`: something keeps it in view (pinned, open now, working, an unread answer,
 * a failed worker, a running or failed operation, the rollup keeps it), or its time is within the rollup's window.
 */
function isRelevant(rollup: Rollup, row: SidebarRow, window: RollupWindow, view: View): boolean {
	return (
		row.pinned ||
		row.id === view.open ||
		row.worker.busy.length > 0 ||
		Boolean(row.worker.unread) ||
		row.worker.error !== undefined ||
		row.operation !== undefined ||
		Boolean(rollup.keeps?.(row)) ||
		view.now - timeIn(rollup, row) < WINDOW_MS[window]
	);
}

/** Pinned sessions first, then the latest by `rollup`'s time. */
const byPinThenTime = (rollup: Rollup) => (a: SidebarRow, b: SidebarRow) =>
	Number(b.pinned) - Number(a.pinned) || timeIn(rollup, b) - timeIn(rollup, a);

/** The owner's sidebar settings (`SidebarSettings`), and what relevance depends on. */
export type View = {
	readonly windows: Readonly<Record<string, SidebarWindow>>;
	/** Whether a rollup or a group shows only its heading, by key; one not named shows its sessions. */
	readonly collapsed: Readonly<Record<string, boolean>>;
	readonly now: number;
	readonly open: string | undefined;
};

/** A group in the sidebar: its relevant sessions (none while collapsed). */
export type GroupSection = Omit<Group, "members"> & {
	readonly collapsed: boolean;
	readonly rows: readonly SidebarRow[];
};

/** A rollup's section of the sidebar, by the layout of what it collected. */
export type Section = { readonly key: string; readonly name: string; readonly window: RollupWindow } & (
	| { readonly layout: "sessions"; readonly collapsed: boolean; readonly rows: readonly SidebarRow[] }
	| { readonly layout: "groups"; readonly collapsed: boolean; readonly groups: readonly GroupSection[] }
	| { readonly layout: "link"; readonly total: number }
);

/**
 * The sidebar's sections, one per rollup in order, every rollup always (its label is where it is managed): each shows
 * its relevant sessions, flat or in groups. A session shows in every rollup and group that has it; a group shows only
 * while it has relevant sessions.
 */
export function sectionsOf(
	rollups: readonly Rollup[],
	rows: readonly SidebarRow[],
	context: RollupContext,
	view: View,
): Section[] {
	return rollups.map((rollup): Section => {
		const window = windowOf(rollup, view);
		const collapsed = view.collapsed[rollup.key] ?? false;
		const relevant = (members: readonly SidebarRow[]) =>
			members.filter((row) => isRelevant(rollup, row, window, view)).sort(byPinThenTime(rollup));
		const base = { key: rollup.key, name: rollup.name, window };
		const collected = rollup.collect(rows, context);
		if (collected.layout === "link") return { ...base, layout: "link", total: collected.members.length };
		if (collected.layout === "sessions")
			return { ...base, layout: "sessions", collapsed, rows: collapsed ? [] : relevant(collected.members) };
		const groups = collapsed
			? []
			: collected.groups.flatMap(({ members, ...group }) => {
					const shown = relevant(members);
					const closed = view.collapsed[group.key] ?? false;
					return shown.length === 0 && !group.keep
						? []
						: [{ ...group, collapsed: closed, rows: closed ? [] : shown }];
				});
		return { ...base, layout: "groups", collapsed, groups };
	});
}

/** A row of a list page: `aged` when it fell out of the rollup's window (still part of it, shown dimmed). */
export type ListEntry = { readonly row: SidebarRow; readonly aged: boolean };

/** A group of a list page: its sessions, and where its "+" starts a new one. */
export type ListGroup = Omit<Group, "members"> & { readonly entries: readonly ListEntry[] };

/** A list page: a flat list of sessions, or groups with theirs, of one rollup or one of its groups. */
export type ListPageData = {
	readonly name: string;
	/** The rollup's window; absent for archived sessions. */
	readonly window?: RollupWindow;
	readonly archived: boolean;
	/** For one group's page: where its "+" starts a new session. */
	readonly target?: NewTarget;
	readonly content:
		| { readonly layout: "sessions"; readonly entries: readonly ListEntry[] }
		| { readonly layout: "groups"; readonly groups: readonly ListGroup[] };
};

/**
 * The list page of `key`, a rollup's or one of its groups' (a rollup of groups lists every group, sessions or not):
 * every session, those its rollup's window still shows first (pinned first, then the most recently active), then the
 * aged ones; archived sessions newest archived first. Undefined for a key no rollup has (a folder without sessions).
 */
export function listPageOf(
	key: string,
	rollups: readonly Rollup[],
	rows: readonly SidebarRow[],
	context: RollupContext,
	view: View,
): ListPageData | undefined {
	const rollup = rollups.find(
		(each) => each.key === key || (each.prefix !== undefined && key.startsWith(each.prefix)),
	);
	if (!rollup) return undefined;
	const window = windowOf(rollup, view);
	const order = byPinThenTime(rollup);
	const entries = (members: readonly SidebarRow[]): ListEntry[] =>
		rollup.archived
			? members.toSorted((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)).map((row) => ({ row, aged: false }))
			: members
					.map((row) => ({ row, aged: !isRelevant(rollup, row, window, view) }))
					.sort((a, b) => Number(a.aged) - Number(b.aged) || order(a.row, b.row));
	const base = { archived: rollup.archived, ...(rollup.archived ? {} : { window }) };
	const collected = rollup.collect(rows, context);
	if (collected.layout !== "groups")
		return { ...base, name: rollup.name, content: { layout: "sessions", entries: entries(collected.members) } };
	if (key === rollup.key)
		return {
			...base,
			name: rollup.name,
			content: {
				layout: "groups",
				groups: collected.groups.map(({ members, ...group }) => ({ ...group, entries: entries(members) })),
			},
		};
	const group = collected.groups.find((each) => each.key === key);
	return (
		group && {
			...base,
			name: group.name,
			target: group.target,
			content: { layout: "sessions", entries: entries(group.members) },
		}
	);
}

/** The keys of the rollups in `rollups`' order, with `key` moved one place up (`-1`) or down (`1`). */
export function moved(rollups: readonly Rollup[], key: string, by: -1 | 1): string[] {
	const keys = rollups.map((rollup) => rollup.key);
	const from = keys.indexOf(key);
	const to = from + by;
	if (from < 0 || to < 0 || to >= keys.length) return keys;
	const next = [...keys];
	[next[from], next[to]] = [next[to]!, next[from]!];
	return next;
}
