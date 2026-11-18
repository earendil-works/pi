// The sidebar's rules (plugins/sessions/sidebar/model.ts): what each built-in rollup collects (the sessions without a
// project, without a heading; the projects; the Archive), the sections with relevance, windows and collapsed rollups
// and groups, what failed in a session and what sessions want, the list pages with aged sessions after the others,
// folder keys and names (the command menu's folder lists), and arranging and moving rollups.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Project } from "../../plugins/projects/contract.ts";
import {
	ARCHIVE,
	activityOf,
	arranged,
	FOLDERS,
	failureOf,
	folderKey,
	type ListPageData,
	listPageOf,
	movable,
	moved,
	OTHER,
	PROJECTS,
	projectKey,
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
	it("lists sessions without a project flat, each project as a group of its relevant ones, the Archive as a link", () => {
		assert.deepEqual(sectionsOf(ROLLUPS, ROWS, CONTEXT, VIEW).map(short), [
			// "stale" (on a sandbox, outside every project) is not relevant: older than the window.
			[OTHER, "sessions", ["free"]],
			// Pinned first, then the most recently active. "web" has no session but shows anyway: its "+" starts a new
			// project's first session.
			[
				PROJECTS,
				"groups",
				[
					[projectKey("pi"), ["p", "b", "a"]],
					[projectKey("web"), []],
				],
			],
			[ARCHIVE, "link", 2],
		]);
	});

	it("shows the sessions without a project without a heading: always open, counting the ones its window hides", () => {
		const other = sectionsOf(ROLLUPS, ROWS, CONTEXT, { ...VIEW, collapsed: { [OTHER]: true } })[0]!;
		assert.ok(other.layout === "sessions");
		assert.deepEqual(
			[other.headless, other.collapsed, other.rows.map((each) => each.id), other.older],
			[true, false, ["free"], 1],
		);
	});

	it("puts a session in the project whose place holds its folder, unless it joined another one", () => {
		const rows = [
			row("inside", { cwd: "/w/web/src" }),
			row("joined", { cwd: "/w/web" }),
			row("outside", { cwd: "/w/x" }),
		];
		const context = { ...CONTEXT, memberships: { joined: "pi" } };
		assert.deepEqual(sectionsOf(ROLLUPS, rows, context, VIEW).map(short).slice(0, 2), [
			[OTHER, "sessions", ["outside"]],
			[
				PROJECTS,
				"groups",
				[
					[projectKey("pi"), ["joined"]],
					[projectKey("web"), ["inside"]],
				],
			],
		]);
	});

	it("keeps a session that something holds in view, whatever its window", () => {
		const ancient = { updatedAt: NOW - 30 * DAY };
		const held = [
			row("pinned", { ...ancient, pinned: true }),
			row("busy", { ...ancient, worker: { work: {}, busy: [1] } }),
			row("unread", { ...ancient, worker: { work: {}, busy: [], unread: true } }),
			row("failed", { ...ancient, worker: { work: {}, busy: [], error: "boom" } }),
			row("run", { ...ancient, worker: { work: {}, busy: [], failure: { reason: "model_error" } } }),
			row("moving", { ...ancient, operation: { label: "Moving…" } }),
			row("open", ancient),
			row("stopped", { ...ancient, worker: { work: {}, busy: [], failure: { reason: "aborted" } } }),
			row("closed", ancient),
		];
		const other = sectionsOf(ROLLUPS, held, CONTEXT, { ...VIEW, windows: { [OTHER]: "1d" }, open: "open" })[0]!;
		assert.deepEqual(short(other), [
			OTHER,
			"sessions",
			["pinned", "busy", "unread", "failed", "run", "moving", "open"],
		]);
	});

	it("uses each rollup's window, and the owner's collapsed rollups and groups", () => {
		const view: View = { ...VIEW, windows: { [OTHER]: "forever" }, collapsed: { [projectKey("pi")]: true } };
		const sections = sectionsOf(ROLLUPS, ROWS, CONTEXT, view);
		assert.deepEqual(short(sections[0]!), [OTHER, "sessions", ["free", "stale"]]);
		// A collapsed group keeps its row, without its sessions.
		assert.deepEqual(short(sections[1]!), [
			PROJECTS,
			"groups",
			[
				[projectKey("pi"), []],
				[projectKey("web"), []],
			],
		]);
		const closed = sectionsOf(ROLLUPS, ROWS, CONTEXT, { ...VIEW, collapsed: { [PROJECTS]: true } })[1]!;
		assert.deepEqual(short(closed), [PROJECTS, "groups", []]);
	});

	it("shows every rollup without sessions or projects too", () => {
		const context = { ...CONTEXT, projects: [], memberships: {} };
		assert.deepEqual(sectionsOf(ROLLUPS, [], context, VIEW).map(short), [
			[OTHER, "sessions", []],
			[PROJECTS, "groups", []],
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
		row("run", { worker: { work: {}, busy: [], failure: { reason: "model_error", detail: "overloaded" } } }),
		row("stopped", { worker: { work: {}, busy: [], failure: { reason: "aborted" } } }),
		row("idle"),
	];

	it("says what failed: the worker, an operation, or the main conversation's last run while it is not running", () => {
		assert.deepEqual(
			states.map((each) => [each.id, failureOf(each)]).filter(([, failure]) => failure !== undefined),
			[
				["broken", "Worker failed: boom"],
				["move", "Move failed: refused"],
				["run", "Failed: overloaded"],
			],
		);
		// A stop, a reset or a run with nothing to answer is no failure; a run again replaces the last one's ending.
		const ended = (reason: string, busy: number[] = []) =>
			failureOf(row("x", { worker: { work: {}, busy, failure: { reason } } }));
		assert.deepEqual(
			[ended("faulted"), ended("reset"), ended("nothing_to_answer"), ended("turn_limit"), ended("faulted", [1])],
			["Failed: Its run hit an error", undefined, undefined, undefined, undefined],
		);
	});

	it("counts working, failed and unread sessions; one session may count in several", () => {
		assert.deepEqual(activityOf(states), { working: 3, failed: 3, unread: 2 });
		assert.deepEqual(activityOf([]), { working: 0, failed: 0, unread: 0 });
	});

	it("says what a collapsed rollup or group hides, and nothing while it shows its sessions", () => {
		const rows = states.map((each) => ({ ...each, cwd: "/w/pi" }));
		const idle = { working: 0, failed: 0, unread: 0 };
		const all = { working: 3, failed: 3, unread: 2 };
		const open = sectionsOf(ROLLUPS, rows, CONTEXT, VIEW);
		for (const section of open) if (section.layout !== "link") assert.deepEqual(section.hidden, idle);
		// Every one works in pi's place: they are pi's sessions.
		const closed = sectionsOf(ROLLUPS, rows, CONTEXT, { ...VIEW, collapsed: { [projectKey("pi")]: true } });
		const projects = closed[1]!;
		assert.ok(projects.layout === "groups");
		assert.deepEqual(projects.hidden, idle);
		assert.deepEqual(projects.groups[0]!.hidden, all);
		const rolled = sectionsOf(ROLLUPS, rows, CONTEXT, { ...VIEW, collapsed: { [PROJECTS]: true } })[1]!;
		assert.deepEqual(rolled.layout === "groups" && rolled.hidden, all);
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
		assert.deepEqual(wantingOf(states, undefined), { count: 5, failed: true });
		assert.deepEqual(wantingOf(states, "broken"), { count: 4, failed: true });
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
		const data = listPageOf(OTHER, ROLLUPS, rows, CONTEXT, VIEW);
		assert(data?.content.layout === "sessions");
		assert.deepEqual(
			data.content.entries.map(({ row, aged }) => `${row.id}${aged ? " aged" : ""}`),
			["free", "held", "stale aged"],
		);
		assert.deepEqual(page(OTHER, { ...VIEW, windows: { [OTHER]: "forever" } }), [
			"Other sessions",
			["free", "stale"],
		]);
	});

	it("lists a rollup of groups by group (projects without sessions too), and one group alone with its target", () => {
		// Folders are no section of the sidebar, but the command menu's Open folder… lists them.
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

describe("arranged and moved", () => {
	const keys = (rollups: readonly { key: string }[]) => rollups.map((rollup) => rollup.key);

	it("keeps the rollup without a heading first, then the others in the owner's order, the unnamed ones last", () => {
		assert.deepEqual(keys(arranged(ROLLUPS, [ARCHIVE, "gone"])), [OTHER, ARCHIVE, PROJECTS]);
		// An order saved before the headless rollup existed, or one naming it, does not move it.
		assert.deepEqual(keys(arranged(ROLLUPS, ["recent", PROJECTS, "folders", ARCHIVE])), [OTHER, PROJECTS, ARCHIVE]);
		assert.deepEqual(keys(arranged(ROLLUPS, [ARCHIVE, PROJECTS, OTHER])), [OTHER, ARCHIVE, PROJECTS]);
	});

	it("swaps a rollup with a heading with its neighbour among those with one", () => {
		const shown = movable(arranged(ROLLUPS, [ARCHIVE]));
		assert.deepEqual(keys(shown), [ARCHIVE, PROJECTS]);
		assert.deepEqual(moved(shown, PROJECTS, -1), [PROJECTS, ARCHIVE]);
		assert.deepEqual(moved(shown, ARCHIVE, -1), [ARCHIVE, PROJECTS]);
	});
});
