// Adapted from coding-agent interactive/components/tree-selector.ts (`/tree`, docs/tree.md): the tree layout (indent
// at branch points, connectors, gutters, the current branch first), the active path marker, selection and paging.
// Changes: nodes are p2's tree nodes (`plugins/tree/contract.ts`: user messages and answers by entry ID, no tool
// entries), so there are no filters, folding, labels or copying; the instance theme and keymap (section 5.4) replace the
// globals; message text is server text (`lineText`).
import { type Component, Container, type Focusable, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { keyHint, lineText } from "../render-context.ts";
import { DynamicBorder, type SelectorContext } from "./selectors.ts";

/** One message of the tree; `parent` is the node before it on its branch. */
export type TreeSelectorNode = {
	readonly entry: number;
	readonly parent: number | null;
	readonly role: "user" | "assistant";
	readonly text: string;
};

type TreeNode = { readonly node: TreeSelectorNode; readonly children: TreeNode[] };

/** Gutter: the indent level where a connector was shown, and whether its branch goes on below (`│`). */
type Gutter = { readonly position: number; readonly show: boolean };

type FlatNode = {
	readonly node: TreeSelectorNode;
	readonly indent: number;
	/** A connector (`├─`/`└─`): its parent has several children. */
	readonly showConnector: boolean;
	readonly isLast: boolean;
	readonly gutters: readonly Gutter[];
	/** A root among several: shown without a connector. */
	readonly isVirtualRootChild: boolean;
};

class TreeList implements Component {
	private readonly flat: FlatNode[];
	private readonly activePath = new Set<number>();
	private readonly multipleRoots: boolean;
	private selectedIndex: number;
	private readonly ctx: SelectorContext;
	private readonly maxVisible: number;
	onSelect?: (entry: number) => void;
	onCancel?: () => void;

	constructor(ctx: SelectorContext, nodes: readonly TreeSelectorNode[], current: number | null, maxVisible: number) {
		this.ctx = ctx;
		this.maxVisible = maxVisible;
		const byEntry = new Map(nodes.map((node) => [node.entry, node]));
		for (let at = current; at !== null; at = byEntry.get(at)?.parent ?? null) this.activePath.add(at);
		const roots = buildTree(nodes);
		this.multipleRoots = roots.length > 1;
		this.flat = this.flatten(roots);
		const index = current === null ? -1 : this.flat.findIndex((each) => each.node.entry === current);
		this.selectedIndex = index >= 0 ? index : Math.max(0, this.flat.length - 1);
	}

	/**
	 * coding-agent's `flattenTree`: indent +1 where a parent branches (and once more for the first generation after a
	 * branch), flat for single-child chains; the subtree holding the current branch comes first.
	 */
	private flatten(roots: readonly TreeNode[]): FlatNode[] {
		const result: FlatNode[] = [];
		// Children before parents (pre-order reversed), without recursion: a long session is one deep chain.
		const containsActive = new Map<TreeNode, boolean>();
		const preOrder: TreeNode[] = [];
		for (const pending = [...roots]; pending.length > 0; ) {
			const tree = pending.pop()!;
			preOrder.push(tree);
			pending.push(...tree.children);
		}
		for (const tree of preOrder.toReversed())
			containsActive.set(
				tree,
				this.activePath.has(tree.node.entry) || tree.children.some((child) => containsActive.get(child)),
			);
		const first = (list: readonly TreeNode[]) =>
			[...list].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
		type Item = [TreeNode, number, boolean, boolean, boolean, readonly Gutter[], boolean];
		const stack: Item[] = [];
		const multiple = roots.length > 1;
		const orderedRoots = first(roots);
		for (let i = orderedRoots.length - 1; i >= 0; i--)
			stack.push([
				orderedRoots[i]!,
				multiple ? 1 : 0,
				multiple,
				multiple,
				i === orderedRoots.length - 1,
				[],
				multiple,
			]);
		while (stack.length > 0) {
			const [tree, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;
			result.push({ node: tree.node, indent, showConnector, isLast, gutters, isVirtualRootChild });
			const children = first(tree.children);
			const branches = children.length > 1;
			const childIndent = branches || (justBranched && indent > 0) ? indent + 1 : indent;
			const displayIndent = this.multipleRoots ? Math.max(0, indent - 1) : indent;
			const childGutters =
				showConnector && !isVirtualRootChild
					? [...gutters, { position: Math.max(0, displayIndent - 1), show: !isLast }]
					: gutters;
			for (let i = children.length - 1; i >= 0; i--)
				stack.push([children[i]!, childIndent, branches, branches, i === children.length - 1, childGutters, false]);
		}
		return result;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const theme = this.ctx.theme.current;
		if (!this.flat.length) return [theme.fg("muted", "  No messages yet")];
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.flat.length - this.maxVisible),
		);
		const end = Math.min(start + this.maxVisible, this.flat.length);
		const lines: string[] = [];
		for (let i = start; i < end; i++) {
			const flat = this.flat[i]!;
			const selected = i === this.selectedIndex;
			const displayIndent = this.multipleRoots ? Math.max(0, flat.indent - 1) : flat.indent;
			const connector = flat.showConnector && !flat.isVirtualRootChild;
			const connectorAt = connector ? displayIndent - 1 : -1;
			let prefix = "";
			for (let level = 0; level < displayIndent; level++) {
				const gutter = flat.gutters.find((each) => each.position === level);
				if (gutter) prefix += gutter.show ? "│  " : "   ";
				else if (level === connectorAt) prefix += flat.isLast ? "└─ " : "├─ ";
				else prefix += "   ";
			}
			const marker = this.activePath.has(flat.node.entry) ? theme.fg("accent", "• ") : "";
			const role = flat.node.role === "user" ? theme.fg("accent", "user: ") : theme.fg("muted", "assistant: ");
			const text = lineText(flat.node.text);
			const body = `${theme.fg("dim", prefix)}${marker}${role}${selected ? theme.bold(text) : text}`;
			const line = truncateToWidth(`${selected ? theme.fg("accent", "› ") : "  "}${body}`, width);
			lines.push(selected ? theme.bg("selectedBg", line) : line);
		}
		lines.push(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.flat.length})`));
		return lines;
	}

	handleInput(data: string): void {
		const keys = this.ctx.keys;
		const last = this.flat.length - 1;
		if (keys.matches(data, "tui.select.up"))
			this.selectedIndex = this.selectedIndex === 0 ? last : this.selectedIndex - 1;
		else if (keys.matches(data, "tui.select.down"))
			this.selectedIndex = this.selectedIndex === last ? 0 : this.selectedIndex + 1;
		else if (keys.matches(data, "tui.select.pageUp") || keys.matches(data, "tui.editor.cursorLeft"))
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		else if (keys.matches(data, "tui.select.pageDown") || keys.matches(data, "tui.editor.cursorRight"))
			this.selectedIndex = Math.min(last, this.selectedIndex + this.maxVisible);
		else if (keys.matches(data, "tui.select.confirm")) {
			const selected = this.flat[this.selectedIndex];
			if (selected) this.onSelect?.(selected.node.entry);
		} else if (keys.matches(data, "tui.select.cancel")) this.onCancel?.();
		this.ctx.requestRender();
	}
}

/** Nodes (parents first) as trees: each node below its `parent`; nodes without a known parent are roots. */
function buildTree(nodes: readonly TreeSelectorNode[]): TreeNode[] {
	const trees = new Map<number, TreeNode>();
	const roots: TreeNode[] = [];
	for (const node of nodes) {
		const tree: TreeNode = { node, children: [] };
		trees.set(node.entry, tree);
		const parent = node.parent === null ? undefined : trees.get(node.parent);
		if (parent) parent.children.push(tree);
		else roots.push(tree);
	}
	return roots;
}

/** pi's `/tree` selector over the session's branches: Enter continues the session at the chosen message. */
export class TreeSelectorComponent extends Container implements Focusable {
	focused = false;
	private readonly list: TreeList;

	constructor(
		ctx: SelectorContext,
		nodes: readonly TreeSelectorNode[],
		current: number | null,
		onSelect: (entry: number) => void,
		onCancel: () => void,
	) {
		super();
		const theme = ctx.theme.current;
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Session Tree"), 1, 0));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`Continue from a message: an answer continues after it, a user message is typed again · ${keyHint(ctx, "tui.select.confirm", "select")} · ${keyHint(ctx, "tui.select.cancel", "cancel")}`,
				),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(ctx));
		this.list = new TreeList(ctx, nodes, current, 16);
		this.list.onSelect = onSelect;
		this.list.onCancel = onCancel;
		this.addChild(this.list);
		this.addChild(new DynamicBorder(ctx));
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}
