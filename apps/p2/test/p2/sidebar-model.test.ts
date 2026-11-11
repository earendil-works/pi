// The sidebar's rules (plugins/sessions/sidebar/model.ts): what each built-in rollup collects (Recents, projects,
// folders, the Archive), the sections with relevance, windows and collapsed rollups and groups, the list pages with
// aged sessions after the others, folder keys and names, moving a rollup, and which project glyph a place shows.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Project } from "../../plugins/projects/contract.ts";
import {
	ARCHIVE,
	activityOf,
	FOLDERS,
	folderKey,
	glyphsOf,
	type ListPageData,
	listPageOf,
	moved,
	ordered,
	PROJECTS,
	projectKey,
	RECENT,
	ROLLUPS,
	type RollupContext,
	type Section,
	type SidebarRow,
	sectionsOf,
	type View,
	wantingOf,
} from "../../plugins/sessions/sidebar/model.ts";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function row(id: string, change: Partial<SidebarRow> = {}): SidebarRow {
	return {
		id,
		env: null,
		cwd: "/w",
		title: id,
		createdAt: NOW - 30 * DAY,
		updatedAt: NOW - HOUR,
		archivedAt: null,
		pinned: false,
		model: { provider: "fake", modelId: "fake" },
		thinkingLevel: "high",
		main: 1,
		branches: [],
		subagents: [],
		worker: { work: {}, busy: [] },
		...change,
	};
}

const PI: Project = { name: "pi", places: [{ env: null, path: "/w/pi" }] };
const WEB: Project = { name: "web", places: [{ env: null, path: "/w/web" }] };
const CONTEXT: RollupContext = {
	projects: [PI, WEB],
	memberships: { a: "pi", b: "pi", p: "pi", old: "pi" },
	folderName: (env, cwd, segments) => `${env ? `${env}:` : ""}${cwd.split("/").slice(-segments).join("/")}`,
	sandboxes: new Set(["box"]),
};
const VIEW: View = { windows: {}, collapsed: {}, now: NOW, open: undefined };

const ROWS = [
	row("free", { updatedAt: NOW - 2 * HOUR }),
	row("a", { updatedAt: NOW - 3 * HOUR, cwd: "/w/pi" }),
	row("b", { updatedAt: NOW - HOUR, cwd: "/w/pi" }),
	row("p", { updatedAt: NOW - 5 * HOUR, pinned: true, cwd: "/w/pi" }),
	row("old", { updatedAt: NOW - 10 * DAY, cwd: "/w/pi" }),
	row("stale", { updatedAt: NOW - 10 * DAY, cwd: "/elsewhere", env: "box" }),
	row("gone", { archivedAt: NOW - DAY, updatedAt: NOW - 2 * DAY }),
	row("gone2", { archivedAt: NOW, updatedAt: NOW - 20 * DAY }),
];

/** A section in short: its key, its layout, then its sessions' ids or its groups' keys with theirs. */
function short(section: Section): unknown[] {
	if (section.layout === "link") return [section.key, "link", section.total];
	if (section.layout === "sessions") return [section.key, "sessions", section.rows.map((each) => each.id)];
	return [section.key, "groups", section.groups.map((group) => [group.key, group.rows.map((each) => each.id)])];
}

describe("sectionsOf", () => {
	it("shows every rollup: Recents flat, projects and folders as groups with relevant sessions, the Archive as a link", () => {
		assert.deepEqual(sectionsOf(ROLLUPS, ROWS, CONTEXT, VIEW).map(short), [
			// Pinned first, then the most recently active; a session shows in every rollup and group that has it.
			[RECENT, "sessions", ["p", "b", "free", "a"]],
			// "web" has no session: no group in the sidebar (its list page has it, with its "+").
			[PROJECTS, "groups", [[projectKey("pi"), ["p", "b", "a"]]]],
			// The sandbox folder of "stale" has no relevant session: no group in the sidebar.
			[
				FOLDERS,
				"groups",
				[
					[folderKey(null, "/w/pi"), ["p", "b", "a"]],
					[folderKey(null, "/w"), ["free"]],
				],
			],
			[ARCHIVE, "link", 2],
		]);
	});

	it("keeps a session that something holds in view, whatever its window", () => {
		const ancient = { updatedAt: NOW - 30 * DAY };
		const held = [
			row("pinned", { ...ancient, pinned: true }),
			row("busy", { ...ancient, worker: { work: {}, busy: [1] } }),
			row("unread", { ...ancient, worker: { work: {}, busy: [], unread: true } }),
			row("failed", { ...ancient, worker: { work: {}, busy: [], error: "boom" } }),
			row("moving", { ...ancient, operation: { label: "Moving…" } }),
			row("open", ancient),
			row("closed", ancient),
		];
		const recent = sectionsOf(ROLLUPS, held, CONTEXT, { ...VIEW, windows: { [RECENT]: "1d" }, open: "open" })[0]!;
		assert.deepEqual(short(recent), [RECENT, "sessions", ["pinned", "busy", "unread", "failed", "moving", "open"]]);
	});

	it("uses each rollup's window, and the owner's collapsed rollups and groups", () => {
		const view: View = {
			...VIEW,
			windows: { [RECENT]: "forever", [FOLDERS]: "1d" },
			collapsed: { [PROJECTS]: true, [folderKey(null, "/w/pi")]: true },
		};
		const sections = sectionsOf(ROLLUPS, ROWS, CONTEXT, view);
		assert.deepEqual(short(sections[0]!), [RECENT, "sessions", ["p", "b", "free", "a", "old", "stale"]]);
		assert.deepEqual(short(sections[1]!), [PROJECTS, "groups", []]);
		// A collapsed group keeps its row, without its sessions.
		assert.deepEqual(short(sections[2]!), [
			FOLDERS,
			"groups",
			[
				[folderKey(null, "/w/pi"), []],
				[folderKey(null, "/w"), ["free"]],
			],
		]);
		const recent3d = sectionsOf(ROLLUPS, ROWS, CONTEXT, { ...VIEW, windows: { [RECENT]: "1d" } })[0]!;
		assert.deepEqual(short(recent3d), [RECENT, "sessions", ["p", "b", "free", "a"]]);
	});

	it("shows every rollup without sessions or projects too", () => {
		const context = { ...CONTEXT, projects: [], memberships: {} };
		assert.deepEqual(sectionsOf(ROLLUPS, [], context, VIEW).map(short), [
			[RECENT, "sessions", []],
			[PROJECTS, "groups", []],
			[FOLDERS, "groups", []],
			[ARCHIVE, "link", 0],
		]);
	});
});

describe("activity", () => {
	const states = [
		row("busy", { worker: { work: {}, busy: [1] } }),
		row("child", { worker: { work: {}, busy: [3] } }),
		row("read", { worker: { work: {}, busy: [], unread: true } }),
		row("both", { worker: { work: {}, busy: [1], unread: true } }),
		row("broken", { worker: { work: {}, busy: [], error: "boom" } }),
		row("move", { operation: { label: "Move failed", error: "refused" } }),
		row("moving", { operation: { label: "Moving…" } }),
		row("idle"),
	];

	it("counts working, failed (worker or operation) and unread sessions; one session may count in several", () => {
		assert.deepEqual(activityOf(states), { working: 3, failed: 2, unread: 2 });
		assert.deepEqual(activityOf([]), { working: 0, failed: 0, unread: 0 });
	});

	it("says what a collapsed rollup or group hides, and nothing while it shows its sessions", () => {
		const rows = states.map((each) => ({ ...each, cwd: "/w/pi" }));
		const idle = { working: 0, failed: 0, unread: 0 };
		const all = { working: 3, failed: 2, unread: 2 };
		const open = sectionsOf(ROLLUPS, rows, CONTEXT, VIEW);
		for (const section of open) if (section.layout !== "link") assert.deepEqual(section.hidden, idle);
		const group = folderKey(null, "/w/pi");
		const closed = sectionsOf(ROLLUPS, rows, CONTEXT, { ...VIEW, collapsed: { [RECENT]: true, [group]: true } });
		assert.deepEqual(closed[0]!.layout === "sessions" && closed[0]!.hidden, all);
		const folders = closed[2]!;
		assert.ok(folders.layout === "groups");
		assert.deepEqual(folders.hidden, idle);
		assert.deepEqual(folders.groups[0]!.hidden, all);
		// A collapsed rollup of groups counts a session in two groups once (a rollup made from code may list it twice).
		const twice = {
			...ROLLUPS[1]!,
			collect: () => ({
				layout: "groups" as const,
				groups: [
					{ key: "g:1", name: "1", sandboxed: false, members: states },
					{ key: "g:2", name: "2", sandboxed: false, members: states },
				],
			}),
		};
		const [both] = sectionsOf([twice], rows, CONTEXT, { ...VIEW, collapsed: { [twice.key]: true } });
		assert.deepEqual(both!.layout === "groups" && both!.hidden, all);
	});

	it("counts the live sessions that want the owner, apart from the one on screen, and whether one failed", () => {
		assert.deepEqual(wantingOf(states, undefined), { count: 4, failed: true });
		assert.deepEqual(wantingOf(states, "broken"), { count: 3, failed: true });
		const unread = [
			row("read", { worker: { work: {}, busy: [], unread: true } }),
			row("gone", { archivedAt: NOW, worker: { work: {}, busy: [], unread: true } }),
		];
		assert.deepEqual(wantingOf(unread, undefined), { count: 1, failed: false });
		assert.deepEqual(wantingOf(unread, "read"), { count: 0, failed: false });
	});
});

describe("listPageOf", () => {
	/** A page in short: its name, then its entries' ids (aged marked), flat or by group. */
	const page = (key: string, view = VIEW) => {
		const data: ListPageData | undefined = listPageOf(key, ROLLUPS, ROWS, CONTEXT, view);
		if (!data) return undefined;
		const content = data.content;
		const entries = (list: readonly { row: SidebarRow; aged: boolean }[]) =>
			list.map(({ row, aged }) => `${row.id}${aged ? " aged" : ""}`);
		return [
			data.name,
			content.layout === "sessions"
				? entries(content.entries)
				: content.groups.map((group) => [group.name, entries(group.entries)]),
		];
	};

	it("lists every session of a rollup, the relevant ones first, then the aged ones, whatever their activity", () => {
		// "held" is older than "old" but unread: it is relevant, so it comes before the aged "old".
		const rows = [...ROWS, row("held", { updatedAt: NOW - 20 * DAY, worker: { work: {}, busy: [], unread: true } })];
		const data = listPageOf(RECENT, ROLLUPS, rows, CONTEXT, VIEW);
		assert(data?.content.layout === "sessions");
		assert.deepEqual(
			data.content.entries.map(({ row, aged }) => `${row.id}${aged ? " aged" : ""}`),
			["p", "b", "free", "a", "held", "old aged", "stale aged"],
		);
		assert.deepEqual(page(RECENT, { ...VIEW, windows: { [RECENT]: "forever" } }), [
			"Recents",
			["p", "b", "free", "a", "old", "stale"],
		]);
	});

	it("lists a rollup of groups by group (projects without sessions too), and one group alone with its target", () => {
		assert.deepEqual(page(FOLDERS), [
			"Folders",
			[
				["box:elsewhere", ["stale aged"]],
				["pi", ["p", "b", "a", "old aged"]],
				["w", ["free"]],
			],
		]);
		assert.deepEqual(page(PROJECTS), [
			"Projects",
			[
				["pi", ["p", "b", "a", "old aged"]],
				["web", []],
			],
		]);
		const group = listPageOf(projectKey("web"), ROLLUPS, ROWS, CONTEXT, VIEW);
		assert.deepEqual(group?.target, { kind: "project", project: WEB });
		assert.equal(page(folderKey(null, "/nowhere")), undefined);
	});

	it("lists the archived sessions newest archived first, none aged", () => {
		assert.deepEqual(page(ARCHIVE), ["Archive", ["gone2", "gone"]]);
	});
});

describe("folders", () => {
	it("are keyed without a slash, locked on a sandbox, and named by as many segments as tell them apart", () => {
		const rows = [
			row("x", { cwd: "/work/app" }),
			row("y", { cwd: "/oss/app" }),
			row("z", { cwd: "/srv/üñî code" }),
			row("s", { cwd: "/srv/app", env: "box" }),
		];
		const data = listPageOf(FOLDERS, ROLLUPS, rows, CONTEXT, VIEW);
		assert(data?.content.layout === "groups");
		assert.deepEqual(
			data.content.groups.map((group) => [group.name, group.sandboxed]),
			[
				// Only the two "app" folders of this machine need their parent; the sandbox one differs by its machine.
				["box:app", true],
				["oss/app", false],
				["üñî code", false],
				["work/app", false],
			],
		);
		for (const group of data.content.groups) assert.match(group.key, /^folder:[A-Za-z0-9_-]+$/);
	});
});

describe("ordered and moved", () => {
	it("puts the rollups the order names first, and swaps a rollup with its neighbour", () => {
		const rollups = ordered(ROLLUPS, [FOLDERS, "gone"]);
		assert.deepEqual(
			rollups.map((rollup) => rollup.key),
			[FOLDERS, RECENT, PROJECTS, ARCHIVE],
		);
		assert.deepEqual(moved(rollups, RECENT, -1), [RECENT, FOLDERS, PROJECTS, ARCHIVE]);
		assert.deepEqual(moved(rollups, ARCHIVE, 1), [FOLDERS, RECENT, PROJECTS, ARCHIVE]);
	});
});

describe("glyphsOf", () => {
	const REMOTE: Project = {
		name: "remote",
		places: [
			{ env: "gpu", path: "~/remote" },
			{ env: null, path: "/w/remote" },
		],
	};
	const glyphs = glyphsOf({
		projects: [PI, WEB, REMOTE, { name: "nowhere", places: [] }],
		memberships: { member: "web" },
	});

	it("seeds a project by its first place and lists its places as the tooltip", () => {
		assert.deepEqual(glyphs.target({ kind: "project", project: REMOTE }), {
			seed: "~/remote",
			title: "gpu:~/remote\n/w/remote",
		});
		assert.deepEqual(glyphs.target({ kind: "project", project: { name: "nowhere", places: [] } }), {
			seed: "nowhere",
			title: "nowhere",
		});
	});

	it("gives a folder or a session inside a project's place the project's glyph, with its own path as the tooltip", () => {
		assert.deepEqual(glyphs.target({ kind: "folder", env: null, cwd: "/w/pi/apps/p2" }), {
			seed: "/w/pi",
			title: "/w/pi/apps/p2",
		});
		assert.deepEqual(glyphs.row(row("x", { env: "gpu", cwd: "/home/me/remote/src" })), {
			seed: "~/remote",
			title: "gpu:/home/me/remote/src",
		});
		// Membership decides first: a session started from a project's row, wherever it works now.
		assert.deepEqual(glyphs.row(row("member", { cwd: "/w/pi" })).seed, "/w/web");
	});

	it("seeds any other place by its own path", () => {
		assert.deepEqual(glyphs.row(row("free", { cwd: "/elsewhere" })), { seed: "/elsewhere", title: "/elsewhere" });
		// Inside a project's path, on another machine where the project has no place: the folder's own path.
		assert.deepEqual(glyphs.target({ kind: "folder", env: "gpu", cwd: "/w/web/x" }), {
			seed: "/w/web/x",
			title: "gpu:/w/web/x",
		});
	});
});
