/**
 * Tab manager — coordinates tabs and split panes for the terminal multiplexer.
 *
 * Each tab owns a split tree (SplitNode) and a set of panes. The active tab's
 * tree is rendered by PaneContainer in the TUI.
 */

import type { SplitDirection, SplitNode } from "@mariozechner/pi-tui";
import { adjacentPane, allPanes, newLeaf, paneCount, removePane, splitPane as splitTree } from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Tab {
	id: string;
	label: string;
	splitRoot: SplitNode;
	activePaneId: string;
}

// ---------------------------------------------------------------------------
// TabManager
// ---------------------------------------------------------------------------

export class TabManager {
	private tabs: Tab[] = [];
	private activeTabIndex = 0;
	private nextTabId = 1;
	private nextPaneId = 1;

	private generateTabId(): string {
		return `tab-${this.nextTabId++}`;
	}

	private generatePaneId(): string {
		return `pane-${this.nextPaneId++}`;
	}

	/**
	 * Create a new tab with a single pane.
	 * Returns the tab and the pane ID of the initial pane.
	 */
	createTab(label?: string): { tab: Tab; paneId: string } {
		const tabId = this.generateTabId();
		const paneId = this.generatePaneId();
		const tab: Tab = {
			id: tabId,
			label: label || `Tab ${this.tabs.length + 1}`,
			splitRoot: newLeaf(paneId),
			activePaneId: paneId,
		};
		this.tabs.push(tab);
		this.activeTabIndex = this.tabs.length - 1;
		return { tab, paneId };
	}

	/**
	 * Close a tab by ID. Returns the closed tab's pane IDs for cleanup,
	 * or undefined if the tab cannot be closed (last tab).
	 */
	closeTab(tabId: string): string[] | undefined {
		if (this.tabs.length <= 1) return undefined;
		const idx = this.tabs.findIndex((t) => t.id === tabId);
		if (idx < 0) return undefined;
		const closedTab = this.tabs[idx];
		const closedPaneIds = allPanes(closedTab.splitRoot);
		this.tabs.splice(idx, 1);
		if (this.activeTabIndex >= this.tabs.length) {
			this.activeTabIndex = this.tabs.length - 1;
		}
		return closedPaneIds;
	}

	/**
	 * Switch to a tab by index.
	 */
	switchTab(index: number): void {
		if (index >= 0 && index < this.tabs.length) {
			this.activeTabIndex = index;
		}
	}

	nextTab(): void {
		this.switchTab((this.activeTabIndex + 1) % this.tabs.length);
	}

	prevTab(): void {
		this.switchTab((this.activeTabIndex - 1 + this.tabs.length) % this.tabs.length);
	}

	/**
	 * Split the current pane in the active tab.
	 * Returns the new pane ID, or undefined if the split failed.
	 */
	splitCurrentPane(direction: SplitDirection): string | undefined {
		const tab = this.activeTab;
		if (!tab) return undefined;
		const newPaneId = this.generatePaneId();
		const newRoot = splitTree(tab.splitRoot, tab.activePaneId, direction, newPaneId);
		// Verify the split actually produced a new pane (guards against stale activePaneId)
		if (newRoot === tab.splitRoot || !allPanes(newRoot).includes(newPaneId)) {
			return undefined;
		}
		tab.splitRoot = newRoot;
		tab.activePaneId = newPaneId;
		return newPaneId;
	}

	/**
	 * Close a pane in the active tab. If it's the last pane, close the tab instead.
	 * Returns false if nothing was closed (last tab, last pane).
	 */
	closePane(paneId: string): boolean {
		const tab = this.activeTab;
		if (!tab) return false;
		if (paneCount(tab.splitRoot) <= 1) {
			return this.closeTab(tab.id) !== undefined;
		}
		const newRoot = removePane(tab.splitRoot, paneId);
		if (!newRoot) return false;
		tab.splitRoot = newRoot;
		if (tab.activePaneId === paneId) {
			tab.activePaneId = this.getFirstPaneId(newRoot);
		}
		return true;
	}

	/**
	 * Move focus to an adjacent pane in the given direction.
	 */
	focusDirection(direction: "up" | "down" | "left" | "right"): void {
		const tab = this.activeTab;
		if (!tab) return;
		const neighbor = adjacentPane(tab.splitRoot, tab.activePaneId, direction);
		if (neighbor) {
			tab.activePaneId = neighbor;
		}
	}

	// ── Getters ─────────────────────────────────────────────────────────────

	get activeTab(): Tab | undefined {
		return this.tabs[this.activeTabIndex];
	}

	get activePaneId(): string | undefined {
		return this.activeTab?.activePaneId;
	}

	get tabCount(): number {
		return this.tabs.length;
	}

	get activeIndex(): number {
		return this.activeTabIndex;
	}

	getAllTabs(): readonly Tab[] {
		return this.tabs;
	}

	setActivePaneId(paneId: string): void {
		const tab = this.activeTab;
		if (tab) tab.activePaneId = paneId;
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	private getFirstPaneId(node: SplitNode): string {
		if (node.type === "leaf") return node.paneId;
		return this.getFirstPaneId(node.a);
	}
}
