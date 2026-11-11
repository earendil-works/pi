// Rollups made from code as sidebar rules (plugins/sessions/sidebar/custom.ts): a saved rollup's output resolved to the
// sidebar's rows (archived and unknown IDs dropped), groups under the rollup's key with their targets, a member's `at`
// and `keep` in the window, `none` showing every member, and a rollup without output collecting nothing.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RollupDefinition, RollupEntry, RollupOutput } from "../../plugins/rollups/contract.ts";
import { customKey, customRollup } from "../../plugins/sessions/sidebar/custom.ts";
import {
	keyPart,
	listPageOf,
	type RollupContext,
	type Section,
	type SidebarRow,
	sectionsOf,
	type View,
} from "../../plugins/sessions/sidebar/model.ts";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function row(id: string, change: Partial<SidebarRow> = {}): SidebarRow {
	return {
		id,
		env: null,
		cwd: "/w",
		title: id,
		createdAt: NOW - 30 * DAY,
		updatedAt: NOW - 10 * DAY,
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

const CONTEXT: RollupContext = {
	projects: [{ name: "pi", places: [{ env: null, path: "/w/pi" }] }],
	memberships: {},
	folderName: (_env, cwd) => cwd,
	sandboxes: new Set(["box"]),
};
const VIEW: View = { windows: {}, collapsed: {}, now: NOW, open: undefined };
const ROWS = [row("recent", { updatedAt: NOW - DAY }), row("old"), row("gone", { archivedAt: NOW })];

function entry(output: RollupOutput | null, change: Partial<RollupDefinition> = {}): RollupEntry {
	return {
		definition: { key: "mine", name: "Mine", window: "3d", refresh: { kind: "auto" }, code: "return 1", ...change },
		output,
		checkedAt: NOW,
		error: null,
		reads: [],
		fingerprint: null,
	};
}

/** A section in short: its layout, then its sessions' ids or its groups' keys with theirs. */
function short(section: Section): unknown[] {
	if (section.layout === "link") return ["link", section.total];
	if (section.layout === "sessions") return ["sessions", section.rows.map((each) => each.id)];
	return ["groups", section.groups.map((group) => [group.key, group.rows.map((each) => each.id)])];
}

const sectionOf = (rollup: RollupEntry, view = VIEW) =>
	short(sectionsOf([customRollup(rollup)], ROWS, CONTEXT, view)[0]!);

describe("customRollup", () => {
	it("shows the members within its window, drops archived and unknown IDs, and lists every live member", () => {
		const mine = entry({ layout: "sessions", members: ["recent", "old", "gone", "nobody"] });
		assert.deepEqual(sectionOf(mine), ["sessions", ["recent"]]);
		const page = listPageOf(customKey("mine"), [customRollup(mine)], ROWS, CONTEXT, VIEW);
		assert.deepEqual(
			page?.content.layout === "sessions" && page.content.entries.map(({ row, aged }) => [row.id, aged]),
			[
				["recent", false],
				["old", true],
			],
		);
	});

	it("takes a member's own time and keep, and shows every member without a window", () => {
		const timed = entry({
			layout: "sessions",
			members: [
				{ id: "old", at: NOW - 1000 },
				{ id: "recent", at: 0 },
			],
		});
		assert.deepEqual(sectionOf(timed), ["sessions", ["old"]]);
		const kept = entry({ layout: "sessions", members: [{ id: "old", keep: true }] });
		assert.deepEqual(sectionOf(kept), ["sessions", ["old"]]);
		const all = entry({ layout: "sessions", members: ["old", "recent"] }, { window: "none" });
		assert.deepEqual(sectionOf(all), ["sessions", ["recent", "old"]]);
		// The owner's window replaces the rollup's own, but not `none`.
		const forever = { ...VIEW, windows: { [customKey("mine")]: "forever" as const } };
		assert.deepEqual(sectionOf(entry({ layout: "sessions", members: ["old"] }), forever), ["sessions", ["old"]]);
	});

	it("puts its groups under its key, with their targets, a lock on a sandbox folder, and kept empty groups", () => {
		const rollup = customRollup(
			entry({
				layout: "groups",
				groups: [
					{ key: "a/b", name: "Box", members: ["recent"], target: { kind: "folder", env: "box", cwd: "/x" } },
					{ key: "pi", name: "Pi", members: ["old"], target: { kind: "project", project: "pi" } },
					{
						key: "none",
						name: "Nowhere",
						members: [],
						target: { kind: "project", project: "missing" },
						keep: true,
					},
				],
			}),
		);
		const collected = rollup.collect(ROWS, CONTEXT);
		assert.equal(collected.layout, "groups");
		const groups = collected.layout === "groups" ? collected.groups : [];
		assert.deepEqual(
			groups.map((group) => [group.key, group.sandboxed, group.target?.kind]),
			[
				[`rollup:mine:${keyPart("a/b")}`, true, "folder"],
				[`rollup:mine:${keyPart("pi")}`, false, "project"],
				[`rollup:mine:${keyPart("none")}`, false, undefined],
			],
		);
		// "Pi" has no session within the window: hidden; "Nowhere" is kept.
		assert.deepEqual(short(sectionsOf([rollup], ROWS, CONTEXT, VIEW)[0]!), [
			"groups",
			[
				[`rollup:mine:${keyPart("a/b")}`, ["recent"]],
				[`rollup:mine:${keyPart("none")}`, []],
			],
		]);
		// A group's list page, by its key.
		const page = listPageOf(`rollup:mine:${keyPart("pi")}`, [rollup], ROWS, CONTEXT, VIEW);
		assert.equal(page?.name, "Pi");
	});

	it("collects nothing before its first good run, and only a link for a link", () => {
		assert.deepEqual(sectionOf(entry(null)), ["sessions", []]);
		assert.deepEqual(sectionOf(entry({ layout: "link", members: ["old", "recent", "gone"] })), ["link", 2]);
	});
});
