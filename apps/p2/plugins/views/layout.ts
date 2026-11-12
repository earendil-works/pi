// The arrangement of a session's panes on one device: a tree of splits whose leaves are areas, each a stack of views
// shown one at a time (tabs). Pure functions: every change returns a new tree; the workbench lays the panes out from
// it and keeps it in the browser's storage (layout-store.ts).

/** The transcript's place in layouts: always there, never closed. */
export const CHAT = "transcript";

/** A leaf: views stacked as tabs, `active` shown. */
export type Area = {
	readonly kind: "area";
	readonly id: string;
	readonly views: readonly string[];
	readonly active: string;
};
/** Children side by side (`row`) or stacked (`column`), `sizes` their shares, summing to 1. */
export type Split = {
	readonly kind: "split";
	readonly id: string;
	readonly dir: "row" | "column";
	readonly children: readonly LayoutNode[];
	readonly sizes: readonly number[];
};
export type LayoutNode = Area | Split;

/**
 * One device's layout of one session: the tree, the views this device closed (they come back when the agent shows
 * them again), the views it has seen (new ones get a place), and the `focus` stamps it has acted on.
 */
export type Layout = {
	readonly tree: LayoutNode;
	readonly hidden: readonly string[];
	readonly focus: Readonly<Record<string, number>>;
	/** The view shown on phones, where one shows at a time. */
	readonly phone: string;
	/** The stamp of the agent's arrangement this device adopted last (0: none). */
	readonly arranged: number;
};

/** Where a dragged view lands in an area: in its tabs, or beside it on one side. */
export type Zone = "center" | "left" | "right" | "top" | "bottom";
export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/** The smallest share a pane keeps when a splitter is dragged. */
const MIN_SHARE = 0.1;

let counter = 0;
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

const area = (views: readonly string[], active = views[0] ?? CHAT): Area => ({
	kind: "area",
	id: newId("a"),
	views,
	active,
});

/** A layout with the transcript alone. */
export function initialLayout(): Layout {
	return { tree: area([CHAT]), hidden: [], focus: {}, phone: CHAT, arranged: 0 };
}

/** The views of a tree in reading order. */
export function viewsIn(node: LayoutNode): string[] {
	return node.kind === "area" ? [...node.views] : node.children.flatMap(viewsIn);
}

/** How recently the agent must have shown a view this device sees first for a phone to switch to it. */
const RECENT = 60_000;

/**
 * The layout for the session's views at `now`: views gone leave it, new ones get a place, and a view the agent showed
 * again (`focus` grew) comes back and to the front. Phones switch to a view the agent shows while they look, not to
 * every view a device sees first (opening a session shows its chat).
 */
export function reconcile(
	layout: Layout,
	views: readonly { readonly id: string; readonly focus: number }[],
	now: number,
): Layout {
	const ids = new Set(views.map((view) => view.id));
	let tree: LayoutNode | undefined = layout.tree;
	for (const id of viewsIn(layout.tree)) if (id !== CHAT && !ids.has(id) && tree) tree = without(tree, id);
	tree ??= area([CHAT]);
	if (!viewsIn(tree).includes(CHAT)) tree = normalize(split("row", [area([CHAT]), tree], [0.5, 0.5]));
	let hidden = layout.hidden.filter((id) => ids.has(id));
	let phone = layout.phone;
	const focus: Record<string, number> = {};
	for (const view of views) {
		focus[view.id] = view.focus;
		const seen = layout.focus[view.id];
		if (seen !== undefined && view.focus <= seen) continue;
		// New, or shown again by the agent: in place, unhidden, in front.
		hidden = hidden.filter((id) => id !== view.id);
		tree = viewsIn(tree).includes(view.id) ? activate(tree, view.id) : place(tree, view.id);
		if (seen !== undefined || now - view.focus < RECENT) phone = view.id;
	}
	if (phone !== CHAT && (!ids.has(phone) || hidden.includes(phone))) phone = CHAT;
	return { tree, hidden, focus, phone, arranged: layout.arranged };
}

/** `tree` with `id` in a new place: a tab of the last area without the transcript, or a new area beside it all. */
export function place(tree: LayoutNode, id: string): LayoutNode {
	const areas = areasOf(tree).filter((each) => !each.views.includes(CHAT));
	const target = areas.at(-1);
	if (target) return mapArea(tree, target.id, (each) => ({ ...each, views: [...each.views, id], active: id }));
	return normalize(split("row", [tree, area([id])], [0.5, 0.5]));
}

/** `tree` with view `id` hidden from it; undefined when nothing is left. */
export function without(tree: LayoutNode, id: string): LayoutNode | undefined {
	if (tree.kind === "area") {
		if (!tree.views.includes(id)) return tree;
		const views = tree.views.filter((each) => each !== id);
		if (!views.length) return undefined;
		const index = tree.views.indexOf(id);
		const active = tree.active === id ? (views[Math.min(index, views.length - 1)] ?? views[0] ?? CHAT) : tree.active;
		return { ...tree, views, active };
	}
	const kept: LayoutNode[] = [];
	const sizes: number[] = [];
	tree.children.forEach((child, index) => {
		const next = without(child, id);
		if (next) {
			kept.push(next);
			sizes.push(tree.sizes[index] ?? 0);
		}
	});
	if (!kept.length) return undefined;
	return normalize({ ...tree, children: kept, sizes });
}

/** `tree` with view `id` the shown tab of its area. */
export function activate(tree: LayoutNode, id: string): LayoutNode {
	const target = areasOf(tree).find((each) => each.views.includes(id));
	return target ? mapArea(tree, target.id, (each) => ({ ...each, active: id })) : tree;
}

/** `tree` with view `id` moved into area `target`'s tabs (`center`) or beside it; unchanged when that makes no sense. */
export function move(tree: LayoutNode, id: string, target: string, zone: Zone): LayoutNode {
	const source = areasOf(tree).find((each) => each.views.includes(id));
	if (!source || (source.id === target && (zone === "center" || source.views.length === 1))) return tree;
	const rest = without(tree, id);
	if (!rest || !areasOf(rest).some((each) => each.id === target)) return tree;
	if (zone === "center") return mapArea(rest, target, (each) => ({ ...each, views: [...each.views, id], active: id }));
	const added = area([id]);
	const dir = zone === "left" || zone === "right" ? "row" : "column";
	const first = zone === "left" || zone === "top";
	return normalize(mapNode(rest, target, (node) => split(dir, first ? [added, node] : [node, added], [0.5, 0.5])));
}

/** `tree` with the boundary after child `index` of split `id` at `share` of the split (from its start). */
export function resize(tree: LayoutNode, id: string, index: number, share: number): LayoutNode {
	return mapNode(tree, id, (node) => {
		if (node.kind !== "split") return node;
		const before = node.sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
		const pair = (node.sizes[index] ?? 0) + (node.sizes[index + 1] ?? 0);
		const left = Math.min(Math.max(share - before, MIN_SHARE * pair), pair - MIN_SHARE * pair);
		const sizes = [...node.sizes];
		sizes[index] = left;
		sizes[index + 1] = pair - left;
		return { ...node, sizes };
	});
}

/** Every area of a tree, in reading order. */
export function areasOf(tree: LayoutNode): Area[] {
	return tree.kind === "area" ? [tree] : tree.children.flatMap(areasOf);
}

/** Where each area and splitter goes in `rect`. A splitter's rect is the boundary; `span` is its split's. */
export function arrange(
	tree: LayoutNode,
	rect: Rect,
): {
	areas: { area: Area; rect: Rect }[];
	splitters: { split: Split; index: number; rect: Rect; span: Rect }[];
} {
	const areas: { area: Area; rect: Rect }[] = [];
	const splitters: { split: Split; index: number; rect: Rect; span: Rect }[] = [];
	const visit = (node: LayoutNode, box: Rect) => {
		if (node.kind === "area") {
			areas.push({ area: node, rect: box });
			return;
		}
		const row = node.dir === "row";
		const length = row ? box.width : box.height;
		let at = 0;
		node.children.forEach((child, index) => {
			const size = (node.sizes[index] ?? 0) * length;
			const start = Math.round(at);
			const end = Math.round(at + size);
			visit(
				child,
				row
					? { x: box.x + start, y: box.y, width: end - start, height: box.height }
					: { x: box.x, y: box.y + start, width: box.width, height: end - start },
			);
			at += size;
			if (index < node.children.length - 1)
				splitters.push({
					split: node,
					index,
					span: box,
					rect: row
						? { x: box.x + end, y: box.y, width: 0, height: box.height }
						: { x: box.x, y: box.y + end, width: box.width, height: 0 },
				});
		});
	};
	visit(tree, rect);
	return { areas, splitters };
}

/**
 * Why an agent's arrangement (`view_arrange`) is no layout of the views `known` (the transcript included),
 * or undefined when it is one. A node is a view's ID, `{ tabs: [IDs], active? }`, or `{ row | column: [nodes],
 * sizes? }`; each view at most once.
 */
export function arrangementError(value: unknown, known: ReadonlySet<string>): string | undefined {
	const seen = new Set<string>();
	const visit = (node: unknown, depth: number): string | undefined => {
		if (depth > 8) return "nested too deep";
		if (typeof node === "string") {
			if (!known.has(node)) return `no view "${node}"`;
			if (seen.has(node)) return `"${node}" appears twice`;
			seen.add(node);
			return undefined;
		}
		if (!isRecord(node)) return "a node is a view ID, { tabs }, { row } or { column }";
		if (Array.isArray(node.tabs)) {
			if (!node.tabs.length) return "empty tabs";
			for (const id of node.tabs) {
				const error = typeof id === "string" ? visit(id, depth + 1) : "tabs hold view IDs";
				if (error) return error;
			}
			if (node.active !== undefined && !node.tabs.includes(node.active)) return "active is not one of its tabs";
			return undefined;
		}
		const children = Array.isArray(node.row) ? node.row : Array.isArray(node.column) ? node.column : undefined;
		if (!children?.length) return "a node is a view ID, { tabs }, { row } or { column } with children";
		const sizes = node.sizes;
		if (
			sizes !== undefined &&
			(!Array.isArray(sizes) ||
				sizes.length !== children.length ||
				!sizes.every((size) => typeof size === "number" && size > 0))
		)
			return "sizes: one positive number per child";
		for (const child of children) {
			const error = visit(child, depth + 1);
			if (error) return error;
		}
		return undefined;
	};
	return visit(value, 0);
}

/**
 * The tree of an agent's arrangement (checked by `arrangementError` when it was made), keeping only the views in
 * `known`: views closed since drop out; the transcript comes first in a row when it was left out.
 */
export function arrangedTree(value: unknown, known: ReadonlySet<string>): LayoutNode | undefined {
	const build = (node: unknown, depth: number): LayoutNode | undefined => {
		if (depth > 8) return undefined;
		if (typeof node === "string") return known.has(node) ? area([node]) : undefined;
		if (!isRecord(node)) return undefined;
		if (Array.isArray(node.tabs)) {
			const views = node.tabs.filter((id): id is string => typeof id === "string" && known.has(id));
			if (!views.length) return undefined;
			return area(views, typeof node.active === "string" && views.includes(node.active) ? node.active : views[0]);
		}
		const dir = Array.isArray(node.row) ? "row" : "column";
		const list: unknown[] = Array.isArray(node.row) ? node.row : Array.isArray(node.column) ? node.column : [];
		const sizes = Array.isArray(node.sizes) ? node.sizes : [];
		const children: LayoutNode[] = [];
		const shares: number[] = [];
		list.forEach((child, index) => {
			const built = build(child, depth + 1);
			if (!built) return;
			children.push(built);
			const share = sizes[index];
			shares.push(typeof share === "number" && share > 0 ? share : 1);
		});
		return children.length ? normalize(split(dir, children, shares)) : undefined;
	};
	const tree = build(value, 0);
	if (!tree) return undefined;
	return viewsIn(tree).includes(CHAT) ? tree : normalize(split("row", [area([CHAT]), tree], [0.4, 0.6]));
}

/** The view IDs an arrangement names, as stored (any version may have written it). */
function namedViews(value: unknown, depth = 0): string[] {
	if (depth > 8) return [];
	if (typeof value === "string") return [value];
	if (!isRecord(value)) return [];
	const children = [value.tabs, value.row, value.column].find(Array.isArray) ?? [];
	return children.flatMap((child) => namedViews(child, depth + 1));
}

/**
 * `layout` with an agent's arrangement adopted: its tree, the session's other views hidden here (the Views sheet shows
 * them again), and its stamp, so a device adopts each arrangement once and the person may change it afterwards.
 */
export function adopt(
	layout: Layout,
	arrangement: { layout: unknown; stamp: number },
	views: readonly string[],
): Layout {
	const known = new Set([CHAT, ...views]);
	const tree = arrangedTree(arrangement.layout, known);
	// An arrangement whose views are all gone (closed since, or of a removed kind) arranges nothing: it does not hide
	// the views the session has now.
	const named = namedViews(arrangement.layout).filter((id) => id !== CHAT);
	if (!tree || (named.length > 0 && !named.some((id) => known.has(id))))
		return { ...layout, arranged: arrangement.stamp };
	const placed = new Set(viewsIn(tree));
	return {
		...layout,
		tree,
		hidden: views.filter((id) => !placed.has(id)),
		phone: placed.has(layout.phone) ? layout.phone : CHAT,
		arranged: arrangement.stamp,
	};
}

/** A stored layout (the browser's storage: untrusted), or undefined when it is not one. */
export function parseLayout(value: unknown): Layout | undefined {
	if (!isRecord(value) || !isRecord(value.focus) || typeof value.phone !== "string") return undefined;
	const tree = parseNode(value.tree, 0);
	const hidden = Array.isArray(value.hidden) ? value.hidden.filter((id) => typeof id === "string") : undefined;
	if (!tree || !hidden) return undefined;
	const focus: Record<string, number> = {};
	for (const [id, stamp] of Object.entries(value.focus)) if (typeof stamp === "number") focus[id] = stamp;
	const views = viewsIn(tree);
	if (new Set(views).size !== views.length) return undefined;
	const arranged = typeof value.arranged === "number" ? value.arranged : 0;
	return { tree, hidden, focus, phone: value.phone, arranged };
}

function parseNode(value: unknown, depth: number): LayoutNode | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || depth > 12) return undefined;
	if (value.kind === "area") {
		const views = Array.isArray(value.views) ? value.views.filter((id) => typeof id === "string") : [];
		if (!views.length || typeof value.active !== "string") return undefined;
		return {
			kind: "area",
			id: value.id,
			views,
			active: views.includes(value.active) ? value.active : (views[0] ?? CHAT),
		};
	}
	if (value.kind !== "split" || (value.dir !== "row" && value.dir !== "column")) return undefined;
	if (!Array.isArray(value.children) || !Array.isArray(value.sizes)) return undefined;
	const children = value.children.map((child) => parseNode(child, depth + 1));
	if (!children.length || children.some((child) => !child) || value.sizes.length !== children.length) return undefined;
	const sizes = value.sizes.map((size) => (typeof size === "number" && size > 0 ? size : 0));
	return normalize({ kind: "split", id: value.id, dir: value.dir, children: children.filter(isNode), sizes });
}

const isNode = (node: LayoutNode | undefined): node is LayoutNode => node !== undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function split(dir: "row" | "column", children: LayoutNode[], sizes: number[]): Split {
	return { kind: "split", id: newId("s"), dir, children, sizes };
}

/** One child splits collapse into it; a split inside one of its own direction merges into it; shares sum to 1. */
function normalize(node: LayoutNode): LayoutNode {
	if (node.kind === "area") return node;
	const children: LayoutNode[] = [];
	const sizes: number[] = [];
	node.children.forEach((child, index) => {
		const inner = normalize(child);
		const share = node.sizes[index] ?? 0;
		if (inner.kind === "split" && inner.dir === node.dir) {
			const total = inner.sizes.reduce((sum, size) => sum + size, 0) || 1;
			inner.children.forEach((grand, at) => {
				children.push(grand);
				sizes.push((share * (inner.sizes[at] ?? 0)) / total);
			});
		} else {
			children.push(inner);
			sizes.push(share);
		}
	});
	const [only] = children;
	if (children.length === 1 && only) return only;
	const total = sizes.reduce((sum, size) => sum + size, 0);
	return {
		...node,
		children,
		sizes: total > 0 ? sizes.map((size) => size / total) : sizes.map(() => 1 / sizes.length),
	};
}

function mapNode(tree: LayoutNode, id: string, change: (node: LayoutNode) => LayoutNode): LayoutNode {
	if (tree.id === id) return change(tree);
	if (tree.kind === "area") return tree;
	return { ...tree, children: tree.children.map((child) => mapNode(child, id, change)) };
}

function mapArea(tree: LayoutNode, id: string, change: (area: Area) => Area): LayoutNode {
	return mapNode(tree, id, (node) => (node.kind === "area" ? change(node) : node));
}
