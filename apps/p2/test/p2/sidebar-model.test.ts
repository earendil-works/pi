// The sidebar's rules (plugins/sessions/sidebar/model.ts): what each built-in rollup collects (Recents, projects,
// folders, the Archive), the sections with relevance, windows and collapsed rollups, the list pages with
// aged sessions after the others, and moving a rollup.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Project } from "../../plugins/projects/contract.ts";
import {
	ARCHIVE,
	FOLDERS,
	folderKey,
	isRelevant,
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
		worker: { busy: [] },
		...change,
	};
}

const PI: Project = { name: "pi", places: [{ env: null, path: "/w/pi" }] };
const WEB: Project = { name: "web", places: [{ env: null, path: "/w/web" }] };
const CONTEXT: RollupContext = {
	projects: [PI, WEB],
	memberships: { a: "pi", b: "pi", p: "pi", old: "pi" },
	folderName: (env, cwd) => `${env ? `${env}:` : ""}${cwd}`,
};
const VIEW: View = { windows: {}, collapsed: {}, now: NOW, open: undefined };

const ROWS = [
	row("free", { updatedAt: NOW - 2 * HOUR }),
	row("a", { updatedAt: NOW - 3 * HOUR, cwd: "/w/pi" }),
	row("b", { updatedAt: NOW - HOUR, cwd: "/w/pi" }),
	row("p", { updatedAt: NOW - 5 * HOUR, pinned: true, cwd: "/w/pi" }),
	row("old", { updatedAt: NOW - 10 * DAY, cwd: "/w/pi" }),
	row("stale", { updatedAt: NOW - 10 * DAY, cwd: "/elsewhere", env: "mac" }),
	row("gone", { archivedAt: NOW }),
];

/** A section in short: its key, its layout, then its sessions' ids or its groups' keys with theirs. */
function short(section: Section): unknown[] {
	if (section.layout === "link") return [section.key, "link", section.total];
	if (section.layout === "sessions") return [section.key, "sessions", section.rows.map((each) => each.id)];
	return [section.key, "groups", section.groups.map((group) => [group.key, group.rows.map((each) => each.id)])];
}

describe("isRelevant", () => {
	it("keeps what something holds in view, else what was active within the window", () => {
		const old = row("old", { updatedAt: NOW - 2 * DAY });
		assert.equal(isRelevant(old, "1d", NOW, undefined), false);
		assert.equal(isRelevant(old, "3d", NOW, undefined), true);
		assert.equal(isRelevant(row("x", { updatedAt: NOW - 30 * DAY }), "forever", NOW, undefined), true);
		const ancient = { updatedAt: NOW - 30 * DAY };
		for (const held of [
			row("pinned", { ...ancient, pinned: true }),
			row("busy", { ...ancient, worker: { busy: [1] } }),
			row("unread", { ...ancient, worker: { busy: [], unread: true } }),
			row("failed", { ...ancient, worker: { busy: [], error: "boom" } }),
			row("moving", { ...ancient, operation: { label: "Moving…" } }),
		])
			assert.equal(isRelevant(held, "1d", NOW, undefined), true, held.id);
		assert.equal(isRelevant(row("open", ancient), "1d", NOW, "open"), true);
		assert.equal(isRelevant(row("closed", ancient), "1d", NOW, "open"), false);
	});
});

describe("sectionsOf", () => {
	it("shows Recents flat, projects and folders as groups with relevant sessions only, and the Archive as a link", () => {
		assert.deepEqual(sectionsOf(ROLLUPS, ROWS, CONTEXT, VIEW).map(short), [
			// Pinned first, then the most recently active; a session shows in every rollup and group that has it.
			[RECENT, "sessions", ["p", "b", "free", "a"]],
			// "web" has no session: no group.
			[PROJECTS, "groups", [[projectKey("pi"), ["p", "b", "a"]]]],
			// The folder of "stale" has no relevant session: no group in the sidebar (its list page has it).
			[
				FOLDERS,
				"groups",
				[
					[folderKey(null, "/w"), ["free"]],
					[folderKey(null, "/w/pi"), ["p", "b", "a"]],
				],
			],
			[ARCHIVE, "link", 1],
		]);
	});

	it("uses each rollup's window and the owner's collapsed rollups", () => {
		const view: View = { ...VIEW, windows: { [RECENT]: "forever" }, collapsed: { [PROJECTS]: true } };
		const sections = sectionsOf(ROLLUPS, ROWS, CONTEXT, view);
		assert.deepEqual(short(sections[0]!), [RECENT, "sessions", ["p", "b", "free", "a", "old", "stale"]]);
		assert.deepEqual(short(sections[1]!), [PROJECTS, "groups", []]);
	});

	it("has only Recents when there are no sessions", () => {
		assert.deepEqual(sectionsOf(ROLLUPS, [], CONTEXT, VIEW).map(short), [[RECENT, "sessions", []]]);
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

	it("lists every session of a rollup, the others first and the aged ones after them", () => {
		assert.deepEqual(page(RECENT), ["Recents", ["p", "b", "free", "a", "old aged", "stale aged"]]);
		assert.deepEqual(page(RECENT, { ...VIEW, windows: { [RECENT]: "forever" } }), [
			"Recents",
			["p", "b", "free", "a", "old", "stale"],
		]);
	});

	it("lists a rollup of groups by group, and one group alone", () => {
		assert.deepEqual(page(FOLDERS), [
			"Folders",
			[
				["/w", ["free"]],
				["/w/pi", ["p", "b", "a", "old aged"]],
				["mac:/elsewhere", ["stale aged"]],
			],
		]);
		assert.deepEqual(page(projectKey("pi")), ["pi", ["p", "b", "a", "old aged"]]);
		assert.equal(page(folderKey(null, "/nowhere")), undefined);
	});

	it("lists the archived sessions, none aged", () => {
		assert.deepEqual(page(ARCHIVE), ["Archive", ["gone"]]);
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
