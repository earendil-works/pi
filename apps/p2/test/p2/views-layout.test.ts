// The views' layout (plugins/views/layout.ts): new views get a place, the agent showing a view brings it back and to
// the front, tabs move into other areas or beside them, splitters resize within bounds, stored layouts are read as
// untrusted.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activate,
	adopt,
	areasOf,
	arrange,
	arrangedTree,
	arrangementError,
	CHAT,
	initialLayout,
	type Layout,
	type LayoutNode,
	move,
	parseLayout,
	reconcile,
	resize,
	viewsIn,
	without,
} from "../../plugins/views/layout.ts";

/** The tree's shape without IDs: areas as their views (the active one starred), splits as `dir(children)`. */
function shape(node: LayoutNode): string {
	if (node.kind === "area") return `[${node.views.map((id) => (id === node.active ? `*${id}` : id)).join(",")}]`;
	return `${node.dir}(${node.children.map(shape).join(" ")})`;
}

const views = (...entries: [string, number][]) => entries.map(([id, focus]) => ({ id, focus }));
/** Reconciles soon after the views' focus stamps (1 to 5 ms). */
const settle = (layout: Layout, list: { id: string; focus: number }[]) => reconcile(layout, list, 10);

describe("reconcile", () => {
	it("places a new view beside the transcript, then as a tab of the views' area", () => {
		let layout = settle(initialLayout(), views(["plan", 1]));
		assert.equal(shape(layout.tree), "row([*transcript] [*plan])");
		layout = settle(layout, views(["plan", 1], ["glyph", 2]));
		assert.equal(shape(layout.tree), "row([*transcript] [plan,*glyph])");
		assert.equal(layout.phone, "glyph");
	});

	it("drops closed views and keeps hidden ones out until the agent shows them again", () => {
		let layout = settle(initialLayout(), views(["plan", 1], ["glyph", 2]));
		layout = { ...layout, tree: without(layout.tree, "plan") ?? layout.tree, hidden: ["plan"] };
		layout = settle(layout, views(["plan", 1], ["glyph", 2]));
		assert.deepEqual(viewsIn(layout.tree), [CHAT, "glyph"]);
		// The agent opened it again: its focus grew.
		layout = settle(layout, views(["plan", 3], ["glyph", 2]));
		assert.deepEqual(layout.hidden, []);
		assert.equal(shape(layout.tree), "row([*transcript] [glyph,*plan])");
		layout = settle(layout, views(["plan", 3]));
		assert.equal(shape(layout.tree), "row([*transcript] [*plan])");
		layout = settle(layout, []);
		assert.equal(shape(layout.tree), "[*transcript]");
	});

	it("switches a phone to a view the agent shows now, not to old ones a device sees first", () => {
		assert.equal(reconcile(initialLayout(), views(["plan", 1]), 120_000).phone, CHAT);
		assert.equal(reconcile(initialLayout(), views(["plan", 100_000]), 120_000).phone, "plan");
	});

	it("brings a shown view to the front of its area", () => {
		let layout = settle(initialLayout(), views(["plan", 1], ["glyph", 2]));
		layout = settle(layout, views(["plan", 5], ["glyph", 2]));
		assert.equal(shape(layout.tree), "row([*transcript] [*plan,glyph])");
	});
});

describe("move", () => {
	const start = (): LayoutNode => settle(initialLayout(), views(["plan", 1], ["glyph", 2])).tree;

	it("moves a tab beside an area, into an area's tabs, and collapses what it leaves empty", () => {
		const first = start();
		const chat = areasOf(first).find((area) => area.views.includes(CHAT))?.id ?? "";
		let tree = move(first, "glyph", chat, "bottom");
		assert.equal(shape(tree), "row(column([*transcript] [*glyph]) [*plan])");
		const glyph = areasOf(tree).find((area) => area.views.includes("glyph"))?.id ?? "";
		tree = move(tree, "plan", glyph, "center");
		assert.equal(shape(tree), "column([*transcript] [glyph,*plan])");
		tree = move(tree, "transcript", glyph, "left");
		assert.equal(shape(tree), "row([*transcript] [glyph,*plan])");
	});

	it("leaves a lone view where it is when dropped on its own area", () => {
		const tree = start();
		const own = areasOf(tree).find((area) => area.views.includes(CHAT))?.id ?? "";
		assert.equal(move(tree, CHAT, own, "right"), tree);
		assert.equal(shape(activate(tree, "plan")), "row([*transcript] [*plan,glyph])");
	});
});

describe("resize and arrange", () => {
	it("keeps every pane at least a tenth of its pair, and lays areas out without gaps", () => {
		const tree = settle(initialLayout(), views(["plan", 1])).tree;
		assert.equal(tree.kind, "split");
		if (tree.kind !== "split") return;
		const wide = resize(tree, tree.id, 0, 0.99);
		assert.equal(wide.kind === "split" && Math.round((wide.sizes[0] ?? 0) * 100), 90);
		const { areas, splitters } = arrange(resize(tree, tree.id, 0, 0.3), { x: 0, y: 0, width: 1000, height: 600 });
		assert.deepEqual(
			areas.map(({ rect }) => [rect.x, rect.width]),
			[
				[0, 300],
				[300, 700],
			],
		);
		assert.equal(splitters[0]?.rect.x, 300);
	});
});

describe("arrangements", () => {
	const known = new Set([CHAT, "plan", "glyph", "notes"]);

	it("checks an agent's arrangement against the session's views", () => {
		const good = { row: [CHAT, { column: ["plan", { tabs: ["glyph", "notes"], active: "notes" }] }], sizes: [1, 2] };
		assert.equal(arrangementError(good, known), undefined);
		assert.match(arrangementError({ row: [CHAT, "missing"] }, known) ?? "", /no view "missing"/);
		assert.match(arrangementError({ row: ["plan", { tabs: ["plan"] }] }, known) ?? "", /twice/);
		assert.match(arrangementError({ row: [CHAT, "plan"], sizes: [1] }, known) ?? "", /sizes/);
		assert.match(arrangementError({ tabs: ["plan"], active: "glyph" }, known) ?? "", /active/);
		assert.equal(
			shape(arrangedTree(good, known) ?? initialLayout().tree),
			"row([*transcript] column([*plan] [glyph,*notes]))",
		);
	});

	it("adds the transcript when left out, drops views closed since, and hides the rest", () => {
		assert.equal(
			shape(arrangedTree({ tabs: ["plan", "gone"] }, known) ?? initialLayout().tree),
			"row([*transcript] [*plan])",
		);
		const layout = adopt(
			settle(initialLayout(), views(["plan", 1], ["glyph", 2])),
			{ layout: { row: [CHAT, "glyph"] }, stamp: 7 },
			["plan", "glyph"],
		);
		assert.equal(shape(layout.tree), "row([*transcript] [*glyph])");
		assert.deepEqual([layout.hidden, layout.arranged], [["plan"], 7]);
		// Seen views stay where the arrangement put them.
		assert.equal(shape(settle(layout, views(["plan", 1], ["glyph", 2])).tree), "row([*transcript] [*glyph])");
	});
});

describe("parseLayout", () => {
	it("reads a stored layout and refuses what is none", () => {
		const layout: Layout = settle(initialLayout(), views(["plan", 1]));
		assert.equal(shape(parseLayout(JSON.parse(JSON.stringify(layout)))?.tree ?? layout.tree), shape(layout.tree));
		assert.equal(
			parseLayout({ tree: { kind: "area", id: "a", views: [], active: "x" }, hidden: [], focus: {}, phone: "x" }),
			undefined,
		);
		assert.equal(parseLayout("nonsense"), undefined);
		// A view twice is no layout.
		assert.equal(
			parseLayout({
				tree: {
					kind: "split",
					id: "s",
					dir: "row",
					sizes: [1, 1],
					children: [
						{ kind: "area", id: "a", views: ["x"], active: "x" },
						{ kind: "area", id: "b", views: ["x"], active: "x" },
					],
				},
				hidden: [],
				focus: {},
				phone: "x",
			}),
			undefined,
		);
	});
});
