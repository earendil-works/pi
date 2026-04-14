/**
 * Tests for TabManager — tab and split-pane coordination.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { allPanes } from "@mariozechner/pi-tui";
import { TabManager } from "../src/modes/interactive/tab-manager.js";

describe("TabManager", () => {
	let tm: TabManager;

	beforeEach(() => {
		tm = new TabManager();
	});

	describe("createTab", () => {
		it("creates a tab with a single pane", () => {
			const { tab, paneId } = tm.createTab("Test");
			expect(tab.label).toBe("Test");
			expect(tab.splitRoot.type).toBe("leaf");
			expect(tab.activePaneId).toBe(paneId);
			expect(tm.tabCount).toBe(1);
			expect(tm.activeIndex).toBe(0);
		});

		it("auto-generates label if none provided", () => {
			const { tab } = tm.createTab();
			expect(tab.label).toBe("Tab 1");
		});

		it("switches to the new tab", () => {
			tm.createTab("First");
			tm.createTab("Second");
			expect(tm.activeIndex).toBe(1);
			expect(tm.activeTab?.label).toBe("Second");
		});

		it("assigns unique pane IDs per instance", () => {
			const { paneId: p1 } = tm.createTab();
			const { paneId: p2 } = tm.createTab();
			expect(p1).not.toBe(p2);
		});

		it("different TabManager instances have independent ID counters", () => {
			const tm2 = new TabManager();
			const { paneId: a } = tm.createTab();
			const { paneId: b } = tm2.createTab();
			// Both start from 1 independently
			expect(a).toMatch(/^pane-/);
			expect(b).toMatch(/^pane-/);
		});
	});

	describe("closeTab", () => {
		it("returns undefined when closing the last tab", () => {
			tm.createTab();
			expect(tm.closeTab(tm.activeTab!.id)).toBeUndefined();
			expect(tm.tabCount).toBe(1);
		});

		it("closes a tab and returns its pane IDs", () => {
			const { tab: first } = tm.createTab("First");
			tm.createTab("Second");
			const closed = tm.closeTab(first.id);
			expect(closed).toBeDefined();
			expect(closed!.length).toBeGreaterThan(0);
			expect(tm.tabCount).toBe(1);
		});

		it("adjusts activeTabIndex when closing before it", () => {
			tm.createTab("A");
			tm.createTab("B");
			tm.createTab("C");
			// Active is C (index 2)
			tm.switchTab(2);
			tm.closeTab(tm.getAllTabs()[0].id); // Close A
			expect(tm.activeTab?.label).toBe("C");
		});
	});

	describe("switchTab / nextTab / prevTab", () => {
		it("switches to a valid index", () => {
			tm.createTab("A");
			tm.createTab("B");
			tm.switchTab(0);
			expect(tm.activeTab?.label).toBe("A");
		});

		it("ignores invalid index", () => {
			tm.createTab("A");
			tm.switchTab(99);
			expect(tm.activeIndex).toBe(0);
		});

		it("nextTab wraps around", () => {
			tm.createTab("A");
			tm.createTab("B");
			tm.switchTab(1);
			tm.nextTab();
			expect(tm.activeIndex).toBe(0);
		});

		it("prevTab wraps around", () => {
			tm.createTab("A");
			tm.createTab("B");
			tm.switchTab(0);
			tm.prevTab();
			expect(tm.activeIndex).toBe(1);
		});
	});

	describe("splitCurrentPane", () => {
		it("splits and returns new pane ID", () => {
			tm.createTab();
			const newId = tm.splitCurrentPane("horizontal");
			expect(newId).toBeDefined();
			expect(tm.activeTab?.splitRoot.type).toBe("split");
			expect(tm.activeTab?.activePaneId).toBe(newId);
		});

		it("returns undefined with no active tab", () => {
			expect(tm.splitCurrentPane("horizontal")).toBeUndefined();
		});

		it("validates new pane appears in tree", () => {
			tm.createTab();
			const newId = tm.splitCurrentPane("vertical");
			expect(newId).toBeDefined();
			const panes = allPanes(tm.activeTab!.splitRoot);
			expect(panes).toContain(newId);
		});
	});

	describe("closePane", () => {
		it("closes a pane in a multi-pane tab", () => {
			const { paneId: original } = tm.createTab();
			const newId = tm.splitCurrentPane("horizontal")!;
			expect(tm.closePane(newId)).toBe(true);
			expect(tm.activeTab?.activePaneId).toBe(original);
		});

		it("closes the tab when last pane is closed", () => {
			tm.createTab("A");
			tm.createTab("B");
			const paneId = tm.activeTab!.activePaneId;
			// This is the only pane in tab B, so closing it closes the tab
			expect(tm.closePane(paneId)).toBe(true);
			expect(tm.tabCount).toBe(1);
		});

		it("returns false when nothing can be closed", () => {
			tm.createTab();
			// Only one tab with one pane — can't close
			expect(tm.closePane(tm.activeTab!.activePaneId)).toBe(false);
		});
	});

	describe("focusDirection", () => {
		it("moves focus to adjacent pane", () => {
			const { paneId: left } = tm.createTab();
			const right = tm.splitCurrentPane("horizontal")!;
			// Active is now 'right'
			expect(tm.activePaneId).toBe(right);
			tm.focusDirection("left");
			expect(tm.activePaneId).toBe(left);
		});

		it("does nothing when no neighbor exists", () => {
			const { paneId } = tm.createTab();
			tm.focusDirection("right");
			expect(tm.activePaneId).toBe(paneId);
		});
	});
});
