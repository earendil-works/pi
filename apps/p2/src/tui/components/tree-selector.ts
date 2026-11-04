// Adapted from coding-agent interactive/components/tree-selector.ts (`/tree`, docs/tree.md): the tree layout (indent
// at branch points, connectors, gutters, the current branch first), the active path marker, selection, paging and the
// label input. Changes: nodes are p2's tree nodes (`plugins/tree/contract.ts`: user messages and answers by entry ID,
// no tool entries), so there are no filters, folding or copying; labels are branch labels, shown on each branch's first
// own message and edited for the branch holding the selected message; the instance theme and keymap (section 5.4)
// replace the globals; message text and labels are server text (`lineText`).
import {
	type Component,
	Container,
	type Focusable,
	Input,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { keyHint, lineText } from "../render-context.ts";
import { DynamicBorder, type SelectorContext } from "./selectors.ts";

/** One message of the tree; `parent` is the node before it on its branch, `conversation` the branch storing it. */
export type TreeSelectorNode = {
	readonly entry: number;
	readonly parent: number | null;
	readonly conversation: number;
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
	/** Branch labels by conversation (null labels already resolved to the session title). */
	readonly labels: Map<number, string>;
	/** The entries starting a branch: the first of a conversation's own nodes, where its label shows. */
	private readonly firsts = new Set<number>();
	onSelect?: (entry: number) => void;
	onCancel?: () => void;
	onLabelEdit?: (conversation: number) => void;

	constructor(
		ctx: SelectorContext,
		nodes: readonly TreeSelectorNode[],
		current: number | null,
		labels: ReadonlyMap<number, string>,
		maxVisible: number,
	) {
		this.ctx = ctx;
		this.maxVisible = maxVisible;
		this.labels = new Map(labels);
		const byEntry = new Map(nodes.map((node) => [node.entry, node]));
		for (let at = current; at !== null; at = byEntry.get(at)?.parent ?? null) this.activePath.add(at);
		for (const node of nodes)
			if (node.parent === null || byEntry.get(node.parent)?.conversation !== node.conversation)
				this.firsts.add(node.entry);
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
			const label = this.firsts.has(flat.node.entry) ? this.labels.get(flat.node.conversation) : undefined;
			const labelText = label === undefined ? "" : theme.fg("warning", `[${lineText(label)}] `);
			const role = flat.node.role === "user" ? theme.fg("accent", "user: ") : theme.fg("muted", "assistant: ");
			const text = lineText(flat.node.text);
			const body = `${theme.fg("dim", prefix)}${marker}${labelText}${role}${selected ? theme.bold(text) : text}`;
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
		} else if (keys.matches(data, "app.tree.editLabel")) {
			const selected = this.flat[this.selectedIndex];
			if (selected) this.onLabelEdit?.(selected.node.conversation);
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

/** pi's label input, for a branch: Enter saves the trimmed text (empty: see `TreeSelectorComponent`), Escape cancels. */
class LabelInput implements Component, Focusable {
	private readonly input = new Input();
	private readonly ctx: SelectorContext;
	private readonly prompt: string;
	private _focused = false;
	onSubmit?: (label: string) => void;
	onCancel?: () => void;

	constructor(ctx: SelectorContext, prompt: string, current: string) {
		this.ctx = ctx;
		this.prompt = prompt;
		// As a paste: the cursor ends after the text (`setValue` leaves it at the start), and server text is never keys.
		this.input.handleInput(`\x1b[200~${current}\x1b[201~`);
	}

	// Focus reaches the input for IME cursor placement.
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const theme = this.ctx.theme.current;
		const indent = "  ";
		return [
			truncateToWidth(`${indent}${theme.fg("muted", this.prompt)}`, width),
			...this.input.render(width - indent.length).map((line) => truncateToWidth(`${indent}${line}`, width)),
			truncateToWidth(
				`${indent}${keyHint(this.ctx, "tui.select.confirm", "save")}  ${keyHint(this.ctx, "tui.select.cancel", "cancel")}`,
				width,
			),
		];
	}

	handleInput(data: string): void {
		const keys = this.ctx.keys;
		if (keys.matches(data, "tui.select.confirm")) this.onSubmit?.(this.input.getValue().trim());
		else if (keys.matches(data, "tui.select.cancel")) this.onCancel?.();
		else this.input.handleInput(data);
		this.ctx.requestRender();
	}
}

/**
 * pi's `/tree` selector over the session's branches: Enter continues the session at the chosen message; the label key
 * renames the branch holding the selected message (`onRename`; empty resets conversation 1 to the session title). The
 * owner of the selector shows a saved label with `setLabel`.
 */
export class TreeSelectorComponent extends Container implements Focusable {
	private readonly ctx: SelectorContext;
	private readonly list: TreeList;
	private readonly listContainer = new Container();
	private readonly labelContainer = new Container();
	private labelInput: LabelInput | undefined;
	private _focused = false;

	constructor(
		ctx: SelectorContext,
		nodes: readonly TreeSelectorNode[],
		current: number | null,
		labels: ReadonlyMap<number, string>,
		onSelect: (entry: number) => void,
		onCancel: () => void,
		onRename: (conversation: number, label: string) => void,
	) {
		super();
		this.ctx = ctx;
		const theme = ctx.theme.current;
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Session Tree"), 1, 0));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`Continue from a message: an answer continues after it, a user message is typed again · ${keyHint(ctx, "tui.select.confirm", "select")} · ${keyHint(ctx, "app.tree.editLabel", "label")} · ${keyHint(ctx, "tui.select.cancel", "cancel")}`,
				),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(ctx));
		this.list = new TreeList(ctx, nodes, current, labels, 16);
		this.list.onSelect = onSelect;
		this.list.onCancel = onCancel;
		this.list.onLabelEdit = (conversation) => this.editLabel(conversation, onRename);
		this.listContainer.addChild(this.list);
		this.addChild(this.listContainer);
		this.addChild(this.labelContainer);
		this.addChild(new DynamicBorder(ctx));
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.labelInput) this.labelInput.focused = value;
	}

	/** Shows a branch's saved label. */
	setLabel(conversation: number, label: string): void {
		this.list.labels.set(conversation, label);
		this.ctx.requestRender();
	}

	handleInput(data: string): void {
		if (this.labelInput) this.labelInput.handleInput(data);
		else this.list.handleInput(data);
	}

	private editLabel(conversation: number, onRename: (conversation: number, label: string) => void): void {
		const input = new LabelInput(
			this.ctx,
			conversation === 1 ? "Branch label (empty: the session title):" : "Branch label:",
			this.list.labels.get(conversation) ?? "",
		);
		input.onSubmit = (label) => {
			this.closeLabel();
			onRename(conversation, label);
		};
		input.onCancel = () => this.closeLabel();
		this.labelInput = input;
		input.focused = this._focused;
		this.listContainer.clear();
		this.labelContainer.addChild(input);
	}

	private closeLabel(): void {
		this.labelInput = undefined;
		this.labelContainer.clear();
		this.listContainer.addChild(this.list);
	}
}
