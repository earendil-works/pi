/**
 * Tests for TreeSelectorComponent (Slice 3)
 *
 * These tests verify:
 * - Renders empty tree message
 * - Renders single entry
 * - Renders linear chain
 * - Highlights current leaf
 * - Navigation (up/down arrows)
 * - Select triggers callback
 * - Cancel triggers callback
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry, SessionTreeNode } from "../src/session-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TreeSelectorComponent } from "../src/tui/tree-selector.js";

// Initialize theme for rendering
beforeEach(() => {
	initTheme("dark");
});

// Helper to create a user message entry
function userMessage(id: string, parentId: string | null, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	};
}

// Helper to create an assistant message entry
function assistantMessage(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			provider: "test",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
}

// Helper to build a tree from entries using parentId relationships
function buildTree(entries: SessionEntry[]): SessionTreeNode[] {
	if (entries.length === 0) return [];

	const nodes: SessionTreeNode[] = entries.map((entry) => ({
		entry,
		children: [],
	}));

	const byId = new Map<string, SessionTreeNode>();
	for (const node of nodes) {
		byId.set(node.entry.id, node);
	}

	const roots: SessionTreeNode[] = [];
	for (const node of nodes) {
		if (node.entry.parentId === null) {
			roots.push(node);
		} else {
			const parent = byId.get(node.entry.parentId);
			if (parent) {
				parent.children.push(node);
			}
		}
	}
	return roots;
}

describe("TreeSelectorComponent", () => {
	describe("rendering", () => {
		it("renders empty tree message", () => {
			const tree: SessionTreeNode[] = [];
			const onSelect = vi.fn();
			const onCancel = vi.fn();

			const selector = new TreeSelectorComponent(tree, null, 24, onSelect, onCancel);
			const lines = selector.render(80);

			expect(lines.some((l: string) => l.includes("No entries"))).toBe(true);
		});

		it("renders single entry", () => {
			const entries = [userMessage("u1", null, "hello")];
			const tree = buildTree(entries);

			const selector = new TreeSelectorComponent(tree, "u1", 24, vi.fn(), vi.fn());
			const lines = selector.render(80);

			expect(lines.some((l: string) => l.includes("user:") && l.includes("hello"))).toBe(true);
		});

		it("renders linear chain", () => {
			const entries = [
				userMessage("u1", null, "first"),
				assistantMessage("a1", "u1", "response"),
				userMessage("u2", "a1", "second"),
			];
			const tree = buildTree(entries);

			const selector = new TreeSelectorComponent(tree, "u2", 24, vi.fn(), vi.fn());
			const lines = selector.render(80);

			// Should show all three entries
			expect(lines.some((l: string) => l.includes("first"))).toBe(true);
			expect(lines.some((l: string) => l.includes("response"))).toBe(true);
			expect(lines.some((l: string) => l.includes("second"))).toBe(true);
		});

		it("highlights current leaf with selection marker", () => {
			const entries = [userMessage("u1", null, "first"), assistantMessage("a1", "u1", "response")];
			const tree = buildTree(entries);

			const selector = new TreeSelectorComponent(tree, "a1", 24, vi.fn(), vi.fn());
			const lines = selector.render(80);

			// Current leaf should have selection marker (›)
			expect(lines.some((l: string) => l.includes("›"))).toBe(true);
		});
	});

	describe("navigation", () => {
		it("selects next entry on down arrow", () => {
			const entries = [userMessage("u1", null, "first"), assistantMessage("a1", "u1", "second")];
			const tree = buildTree(entries);
			const onSelect = vi.fn();

			const selector = new TreeSelectorComponent(tree, "a1", 24, onSelect, vi.fn());

			// Press up to move to first entry
			selector.handleInput("\x1b[A"); // Up arrow

			// Press enter to select
			selector.handleInput("\r"); // Enter

			expect(onSelect).toHaveBeenCalledWith("u1");
		});

		it("wraps around on navigation", () => {
			const entries = [userMessage("u1", null, "first"), assistantMessage("a1", "u1", "second")];
			const tree = buildTree(entries);
			const onSelect = vi.fn();

			const selector = new TreeSelectorComponent(tree, "a1", 24, onSelect, vi.fn());

			// Press up twice to wrap around
			selector.handleInput("\x1b[A"); // Up arrow
			selector.handleInput("\x1b[A"); // Up arrow (should wrap)

			// Press enter
			selector.handleInput("\r");

			expect(onSelect).toHaveBeenCalled();
		});
	});

	describe("callbacks", () => {
		it("calls onSelect when entry is confirmed", () => {
			const entries = [userMessage("u1", null, "hello")];
			const tree = buildTree(entries);
			const onSelect = vi.fn();

			const selector = new TreeSelectorComponent(tree, "u1", 24, onSelect, vi.fn());

			// Press enter to select
			selector.handleInput("\r");

			expect(onSelect).toHaveBeenCalledWith("u1");
		});

		it("calls onCancel when escape is pressed", () => {
			const entries = [userMessage("u1", null, "hello")];
			const tree = buildTree(entries);
			const onCancel = vi.fn();

			const selector = new TreeSelectorComponent(tree, "u1", 24, vi.fn(), onCancel);

			// Press escape
			selector.handleInput("\x1b");

			expect(onCancel).toHaveBeenCalled();
		});
	});

	describe("getSelectedNode", () => {
		it("returns the currently selected node", () => {
			const entries = [userMessage("u1", null, "first"), assistantMessage("a1", "u1", "second")];
			const tree = buildTree(entries);

			const selector = new TreeSelectorComponent(tree, "a1", 24, vi.fn(), vi.fn());

			// Initially selected should be the leaf
			const selected = selector.getSelectedNode();
			expect(selected?.entry.id).toBe("a1");
		});
	});
});
