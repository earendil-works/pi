/**
 * TreeSelectorComponent - TUI component for viewing and navigating conversation tree
 *
 * Simplified implementation for Slice 3. Supports:
 * - Basic tree rendering
 * - Navigation (up/down arrows)
 * - Selection (enter)
 * - Cancel (escape)
 */

import { type Component, Container, Text } from "@kennyfrc/mu-tui";
import type { SessionTreeNode } from "../session-manager.js";

/** Flattened tree node for navigation */
interface FlatNode {
	node: SessionTreeNode;
	indent: number;
}

/** Truncate string to max width */
function truncateToWidth(str: string, maxWidth: number): string {
	if (str.length <= maxWidth) return str;
	return str.slice(0, maxWidth - 3) + "...";
}

/**
 * Internal tree list component
 */
class TreeList implements Component {
	private flatNodes: FlatNode[] = [];
	private selectedIndex = 0;
	private maxVisibleLines: number;

	public onSelect?: (entryId: string) => void;
	public onCancel?: () => void;

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		maxVisibleLines: number,
		initialSelectedId?: string,
	) {
		this.maxVisibleLines = maxVisibleLines;
		this.flatNodes = this.flattenTree(tree);

		// Start with initialSelectedId if provided, otherwise current leaf
		if (initialSelectedId && this.flatNodes.length > 0) {
			const idx = this.flatNodes.findIndex((n) => n.node.entry.id === initialSelectedId);
			this.selectedIndex = idx >= 0 ? idx : this.flatNodes.length - 1;
		} else if (currentLeafId && this.flatNodes.length > 0) {
			const idx = this.flatNodes.findIndex((n) => n.node.entry.id === currentLeafId);
			this.selectedIndex = idx >= 0 ? idx : this.flatNodes.length - 1;
		} else {
			this.selectedIndex = 0;
		}
	}

	private flattenTree(roots: SessionTreeNode[]): FlatNode[] {
		const result: FlatNode[] = [];
		const stack: Array<{ node: SessionTreeNode; indent: number }> = [];

		// Add roots in order
		for (let i = roots.length - 1; i >= 0; i--) {
			stack.push({ node: roots[i]!, indent: 0 });
		}

		while (stack.length > 0) {
			const { node, indent } = stack.pop()!;
			result.push({ node, indent });

			// Add children in reverse order for correct traversal
			for (let i = node.children.length - 1; i >= 0; i--) {
				stack.push({ node: node.children[i]!, indent: indent + 1 });
			}
		}

		return result;
	}

	invalidate(): void {}

	getSelectedNode(): SessionTreeNode | undefined {
		return this.filteredNodes[this.selectedIndex]?.node;
	}

	private get filteredNodes(): FlatNode[] {
		// For now, no filtering - return all nodes
		return this.flatNodes;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const nodes = this.filteredNodes;

		if (nodes.length === 0) {
			lines.push(truncateToWidth("  No entries found", width));
			return lines;
		}

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisibleLines / 2), nodes.length - this.maxVisibleLines),
		);
		const endIndex = Math.min(startIndex + this.maxVisibleLines, nodes.length);

		for (let i = startIndex; i < endIndex; i++) {
			const flatNode = nodes[i];
			if (!flatNode) continue;

			const entry = flatNode.node.entry;
			const isSelected = i === this.selectedIndex;

			// Build line: cursor + indent + content
			const cursor = isSelected ? "› " : "  ";
			const indent = "  ".repeat(flatNode.indent);
			const content = this.getEntryDisplayText(entry);

			let line = cursor + indent + content;
			if (isSelected) {
				// Highlight selected line (simplified - just bold)
				line = `\x1b[1m${line}\x1b[0m`;
			}
			lines.push(truncateToWidth(line, width));
		}

		return lines;
	}

	private getEntryDisplayText(entry: SessionTreeNode["entry"]): string {
		if (entry.type !== "message") {
			return `[${entry.type}]`;
		}

		const msg = entry.message as { role: string; content: unknown };
		const role = msg.role;

		const extractText = (content: unknown): string => {
			const maxLen = 60;
			if (typeof content === "string") return content.slice(0, maxLen);
			if (Array.isArray(content)) {
				for (const c of content) {
					if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
						return ((c as { text?: string }).text || "").slice(0, maxLen);
					}
				}
			}
			return "";
		};

		const text = extractText(msg.content);

		if (role === "user") {
			return `user: ${text}`;
		} else if (role === "assistant") {
			return `assistant: ${text || "(no content)"}`;
		} else if (role === "toolResult") {
			const toolMsg = msg as { toolName?: string };
			return `[${toolMsg.toolName || "tool"}]`;
		}

		return `[${role}]`;
	}

	handleInput(keyData: string): void {
		const nodes = this.filteredNodes;

		// Up arrow
		if (keyData === "\x1b[A") {
			this.selectedIndex = this.selectedIndex === 0 ? nodes.length - 1 : this.selectedIndex - 1;
		}
		// Down arrow
		else if (keyData === "\x1b[B") {
			this.selectedIndex = this.selectedIndex === nodes.length - 1 ? 0 : this.selectedIndex + 1;
		}
		// Enter
		else if (keyData === "\r") {
			const selected = nodes[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.node.entry.id);
			}
		}
		// Escape
		else if (keyData === "\x1b") {
			this.onCancel?.();
		}
	}
}

/**
 * TreeSelectorComponent - main component wrapper
 */
export class TreeSelectorComponent extends Container implements Component {
	private treeList: TreeList;

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		terminalHeight: number,
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		_onLabelChange?: (entryId: string, label: string | undefined) => void,
		initialSelectedId?: string,
	) {
		super();

		const maxVisibleLines = Math.max(5, Math.floor(terminalHeight / 2));

		this.treeList = new TreeList(tree, currentLeafId, maxVisibleLines, initialSelectedId);
		this.treeList.onSelect = onSelect;
		this.treeList.onCancel = onCancel;

		this.addChild(new Text("Session Tree", 1, 0));
		this.addChild(this.treeList);

		// If tree is empty, cancel after a short delay
		if (tree.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	handleInput(keyData: string): void {
		this.treeList.handleInput(keyData);
	}

	getSelectedNode(): SessionTreeNode | undefined {
		return this.treeList.getSelectedNode();
	}
}
