// A pane layout's tree (`PaneLayout`; views reach part of it through `contract.web.tsx`): plain JSON a view keeps (in
// page state, in the browser's storage) and changes only through these functions. A node is a split (a row or a column
// of nodes, each with its share of the size) or a group (tabs of panes by id, one of them active). Every change keeps
// the tree tidy: a group that loses its last pane goes, a split left with one node becomes that node, a split inside a
// split of its direction merges into it, and shares always add up to 1.

/** A split: `children` side by side (`row`) or stacked (`column`), each with its share of the size in `sizes`. */
export type PaneSplit = {
	readonly kind: "split";
	readonly direction: "row" | "column";
	readonly children: readonly PaneNode[];
	readonly sizes: readonly number[];
};

/** A group of tabs: its id (unique in the tree), its panes by id in tab order, and the active one (`null`: none). */
export type PaneGroup = {
	readonly kind: "group";
	readonly id: string;
	readonly tabs: readonly string[];
	readonly active: string | null;
};

/** A node of a pane layout's tree. */
export type PaneNode = PaneSplit | PaneGroup;

/** Where a pane dropped on a group's body splits it: the new group's side. */
export type PaneEdge = "left" | "right" | "top" | "bottom";

/** The smallest share a node of a split keeps when its divider is dragged. */
export const MIN_SHARE = 0.1;

/** A tree of one group holding `panes`, the first active. */
export function paneTree(panes: readonly string[]): PaneGroup {
	return { kind: "group", id: "g1", tabs: [...panes], active: panes[0] ?? null };
}

/** Every pane of `tree`, in the tree's order (groups depth first, tabs in order). */
export function panesOf(tree: PaneNode): string[] {
	return tree.kind === "group" ? [...tree.tabs] : tree.children.flatMap(panesOf);
}

/** Every group of `tree`, in the tree's order. */
export function groupsOf(tree: PaneNode): PaneGroup[] {
	return tree.kind === "group" ? [tree] : tree.children.flatMap(groupsOf);
}

/** The group holding `pane`, if any. */
export function groupOf(tree: PaneNode, pane: string): PaneGroup | undefined {
	return groupsOf(tree).find((group) => group.tabs.includes(pane));
}

/** `tree` with `pane` active in its group (unchanged when no group holds it). */
export function activatePane(tree: PaneNode, pane: string): PaneNode {
	return mapGroups(tree, (group) => (group.tabs.includes(pane) ? { ...group, active: pane } : group));
}

/**
 * `tree` with `pane` opened, active: where it is already; else as a tab of the first group that does not hold `anchor`
 * (the group beside it); else in a new group split off to the right of `anchor`'s group (or of the whole tree).
 */
export function openPane(tree: PaneNode, pane: string, anchor: string): PaneNode {
	if (groupOf(tree, pane) !== undefined) return activatePane(tree, pane);
	const beside = groupsOf(tree).find((group) => !group.tabs.includes(anchor));
	if (beside !== undefined) return insertTab(tree, beside.id, pane, beside.tabs.length);
	const target = groupOf(tree, anchor) ?? groupsOf(tree)[0];
	if (target === undefined) return paneTree([pane]);
	return splitGroup(tree, target.id, pane, "right");
}

/**
 * `tree` without `pane`: its group activates the tab after it (else before it); a group left empty goes. A tree whose
 * last pane closes is one empty group.
 */
export function closePane(tree: PaneNode, pane: string): PaneNode {
	return tidy(removeTab(tree, pane)) ?? { kind: "group", id: "g1", tabs: [], active: null };
}

/** `tree` with `pane` moved into group `group` at tab `index` (clamped), active there. */
export function movePane(tree: PaneNode, pane: string, group: string, index: number): PaneNode {
	const source = groupOf(tree, pane);
	if (source === undefined || groupsOf(tree).every((each) => each.id !== group)) return tree;
	if (source.id === group) {
		const tabs = source.tabs.filter((tab) => tab !== pane);
		const at = Math.max(0, Math.min(index > source.tabs.indexOf(pane) ? index - 1 : index, tabs.length));
		tabs.splice(at, 0, pane);
		return mapGroups(tree, (each) => (each.id === group ? { ...each, tabs, active: pane } : each));
	}
	// The target group never empties here, so it survives the source's tidying.
	const without = tidy(removeTab(tree, pane));
	return without === undefined ? paneTree([pane]) : insertTab(without, group, pane, index);
}

/**
 * `tree` with `pane` moved into a new group on the `edge` side of group `group`, which keeps the other half. Nothing
 * changes when `pane` is the only tab of `group` (there would be nothing left to split).
 */
export function splitPane(tree: PaneNode, pane: string, group: string, edge: PaneEdge): PaneNode {
	const source = groupOf(tree, pane);
	if (source === undefined || (source.id === group && source.tabs.length === 1)) return tree;
	if (groupsOf(tree).every((each) => each.id !== group)) return tree;
	const without = tidy(removeTab(tree, pane));
	return without === undefined ? paneTree([pane]) : splitGroup(without, group, pane, edge);
}

/**
 * `tree` with the divider after child `index` of the split at `path` (child indexes from the root) moved by `delta`
 * (a share of the split's size): the two children beside it change, each keeping at least `MIN_SHARE`.
 */
export function resizeSplit(tree: PaneNode, path: readonly number[], index: number, delta: number): PaneNode {
	return atPath(tree, path, (node) => {
		if (node.kind !== "split" || index < 0 || index + 1 >= node.sizes.length) return node;
		const pair = node.sizes[index]! + node.sizes[index + 1]!;
		const first = Math.min(Math.max(node.sizes[index]! + delta, MIN_SHARE), pair - MIN_SHARE);
		const sizes = [...node.sizes];
		sizes[index] = first;
		sizes[index + 1] = pair - first;
		return { ...node, sizes };
	});
}

/**
 * `tree` with only the panes `keep` holds (a pane gone from the view, a thing removed from a session), tidied; `null`
 * when none is left.
 */
export function keepPanes(tree: PaneNode, keep: (pane: string) => boolean): PaneNode | null {
	const pruned = mapGroups(tree, (group) => {
		const tabs = group.tabs.filter(keep);
		if (tabs.length === group.tabs.length) return group;
		const active = group.active !== null && tabs.includes(group.active) ? group.active : (tabs[0] ?? null);
		return { ...group, tabs, active };
	});
	return tidy(pruned) ?? null;
}

/** Whether `a` and `b` are the same tree, compared field by field (a view sets a new tree only when it changed). */
export function sameTree(a: PaneNode, b: PaneNode): boolean {
	if (a === b) return true;
	if (a.kind === "group" || b.kind === "group") {
		return (
			a.kind === "group" &&
			b.kind === "group" &&
			a.id === b.id &&
			a.active === b.active &&
			a.tabs.length === b.tabs.length &&
			a.tabs.every((tab, index) => tab === b.tabs[index])
		);
	}
	return (
		a.direction === b.direction &&
		a.children.length === b.children.length &&
		a.sizes.every((size, index) => size === b.sizes[index]) &&
		a.children.every((child, index) => sameTree(child, b.children[index]!))
	);
}

/**
 * `value` as a pane tree, or `undefined` when it is not one (a trust boundary: JSON from the browser's storage, which
 * another version of the view or a person may have written): every group with an id, tabs of strings, an active tab
 * among them; every split with a direction and positive shares, one per child. Read trees are tidied.
 */
export function parsePaneTree(value: unknown): PaneNode | undefined {
	const node = parsedNode(value);
	if (node === undefined) return undefined;
	const ids = groupsOf(node).map((group) => group.id);
	if (new Set(ids).size !== ids.length) return undefined;
	const panes = panesOf(node);
	if (new Set(panes).size !== panes.length) return undefined;
	return tidy(node) ?? { kind: "group", id: "g1", tabs: [], active: null };
}

/** One node of `value`, checked (see `parsePaneTree`). */
function parsedNode(value: unknown): PaneNode | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const node = value as Record<string, unknown>;
	if (node.kind === "group") {
		const { id, tabs, active } = node;
		if (typeof id !== "string" || !Array.isArray(tabs) || !tabs.every((tab) => typeof tab === "string")) {
			return undefined;
		}
		const shown =
			typeof active === "string" && tabs.includes(active) ? active : ((tabs[0] as string | undefined) ?? null);
		return { kind: "group", id, tabs: tabs as string[], active: shown };
	}
	if (node.kind === "split") {
		const { direction, children, sizes } = node;
		if ((direction !== "row" && direction !== "column") || !Array.isArray(children) || !Array.isArray(sizes)) {
			return undefined;
		}
		if (children.length !== sizes.length || !sizes.every((size) => typeof size === "number" && size > 0)) {
			return undefined;
		}
		const parsed = children.map(parsedNode);
		if (parsed.some((child) => child === undefined)) return undefined;
		return { kind: "split", direction, children: parsed as PaneNode[], sizes: normalized(sizes as number[]) };
	}
	return undefined;
}

/** `tree` with `change` applied to every group. */
function mapGroups(tree: PaneNode, change: (group: PaneGroup) => PaneNode): PaneNode {
	if (tree.kind === "group") return change(tree);
	return { ...tree, children: tree.children.map((child) => mapGroups(child, change)) };
}

/** `tree` with `change` applied to the node at `path` (child indexes from the root). */
function atPath(tree: PaneNode, path: readonly number[], change: (node: PaneNode) => PaneNode): PaneNode {
	const [first, ...rest] = path;
	if (first === undefined) return change(tree);
	if (tree.kind !== "split" || first >= tree.children.length) return tree;
	const children = tree.children.map((child, index) => (index === first ? atPath(child, rest, change) : child));
	return { ...tree, children };
}

/** `tree` with `pane` inserted into group `group` at `index` (clamped), active. */
function insertTab(tree: PaneNode, group: string, pane: string, index: number): PaneNode {
	return mapGroups(tree, (each) => {
		if (each.id !== group) return each;
		const tabs = [...each.tabs];
		tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, pane);
		return { ...each, tabs, active: pane };
	});
}

/** `tree` with `pane` taken out of its group (the group may be left empty: `tidy` removes it). */
function removeTab(tree: PaneNode, pane: string): PaneNode {
	return mapGroups(tree, (group) => {
		const at = group.tabs.indexOf(pane);
		if (at === -1) return group;
		const tabs = group.tabs.filter((tab) => tab !== pane);
		const active = group.active === pane ? (tabs[at] ?? tabs[at - 1] ?? null) : group.active;
		return { ...group, tabs, active };
	});
}

/** `tree` with group `group` replaced by a split of it and a new group of `pane` on the `edge` side. */
function splitGroup(tree: PaneNode, group: string, pane: string, edge: PaneEdge): PaneNode {
	const added: PaneGroup = { kind: "group", id: freshGroupId(tree), tabs: [pane], active: pane };
	const direction = edge === "left" || edge === "right" ? "row" : "column";
	const before = edge === "left" || edge === "top";
	return tidy(
		mapGroups(tree, (each) =>
			each.id === group
				? { kind: "split", direction, children: before ? [added, each] : [each, added], sizes: [0.5, 0.5] }
				: each,
		),
	)!;
}

/** A group id `tree` does not use: `g<n>`, one more than the largest such number in it. */
function freshGroupId(tree: PaneNode): string {
	const numbers = groupsOf(tree).map((group) => Number(/^g(\d+)$/.exec(group.id)?.[1] ?? 0));
	return `g${Math.max(0, ...numbers) + 1}`;
}

/**
 * `node` tidied: empty groups removed, a split of one child replaced by it, a child split of the same direction merged
 * into its parent (its children taking its share), shares renormalized; `undefined` when nothing is left.
 */
function tidy(node: PaneNode): PaneNode | undefined {
	if (node.kind === "group") return node.tabs.length === 0 ? undefined : node;
	const children: PaneNode[] = [];
	const sizes: number[] = [];
	node.children.forEach((child, index) => {
		const kept = tidy(child);
		if (kept === undefined) return;
		const share = node.sizes[index] ?? 1 / node.children.length;
		if (kept.kind === "split" && kept.direction === node.direction) {
			kept.children.forEach((grandchild, at) => {
				children.push(grandchild);
				sizes.push(share * kept.sizes[at]!);
			});
			return;
		}
		children.push(kept);
		sizes.push(share);
	});
	if (children.length === 0) return undefined;
	if (children.length === 1) return children[0];
	return { kind: "split", direction: node.direction, children, sizes: normalized(sizes) };
}

/** `sizes` scaled to add up to 1. */
function normalized(sizes: readonly number[]): number[] {
	const total = sizes.reduce((sum, size) => sum + size, 0);
	return sizes.map((size) => size / total);
}
