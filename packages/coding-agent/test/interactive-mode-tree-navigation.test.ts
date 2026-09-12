import { Container } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { StatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import type { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const busyMessage = "Wait for the current compaction or tree navigation to finish before navigating the session tree.";

function createTreeUI() {
	const sessionManager = SessionManager.inMemory();
	const targetId = sessionManager.appendMessage(userMsg("first"));
	sessionManager.appendMessage(assistantMsg("reply"));
	let selector: TreeSelectorComponent | undefined;
	const onEscape = vi.fn();
	const ui = {
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		session: {
			isStreaming: false,
			isCompacting: false,
			abort: vi.fn(async () => {
				ui.session.isStreaming = false;
			}),
			abortBranchSummary: vi.fn(),
			navigateTree: vi.fn(async () => {
				if (ui.session.isCompacting) throw new Error(busyMessage);
				return { cancelled: false };
			}),
		},
		defaultEditor: { onEscape },
		editor: { getText: () => "", setText: vi.fn() },
		chatContainer: new Container(),
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		ui: { terminal: { rows: 24, setProgress: vi.fn() }, requestRender: vi.fn() },
		showSelector: (
			create: (done: () => void) => { component: TreeSelectorComponent; focus: TreeSelectorComponent },
		) => {
			selector = create(vi.fn()).component;
		},
		showExtensionSelector: vi.fn(async () => "No summary"),
		// Dispose newly created indicators so a failing regression cannot leak spinner timers.
		showStatusIndicator: vi.fn((indicator: StatusIndicator) => indicator.dispose()),
		clearStatusIndicator: vi.fn(),
		restoreQueuedMessagesToEditor: vi.fn(),
		renderInitialMessages: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		flushCompactionQueue: vi.fn(async () => {}),
	};
	const showTreeSelector = Reflect.get(InteractiveMode.prototype, "showTreeSelector") as (this: typeof ui) => void;
	showTreeSelector.call(ui);

	return {
		ui,
		onEscape,
		targetId,
		async select() {
			expect(selector).toBeDefined();
			await selector!.getTreeList().onSelect!(targetId);
		},
	};
}

describe("InteractiveMode tree navigation availability", () => {
	beforeEach(() => initTheme("dark"));

	// Regression for #9178 / PR #9179: rejection must not replace the active operation's UI.
	it.each(["Summarize", "No summary"])("preserves operation UI when choosing %s while busy", async (choice) => {
		const { ui, onEscape, select } = createTreeUI();
		const originalLeafId = ui.sessionManager.getLeafId();
		ui.showExtensionSelector.mockImplementation(async () => {
			// Compaction or another navigation can start while the dialog is open.
			ui.session.isCompacting = true;
			return choice;
		});

		await select();

		expect(ui.showError).toHaveBeenCalledWith(busyMessage);
		expect(ui.showStatusIndicator).not.toHaveBeenCalled();
		expect(ui.clearStatusIndicator).not.toHaveBeenCalled();
		expect(ui.defaultEditor.onEscape).toBe(onEscape);
		expect(ui.session.navigateTree).not.toHaveBeenCalled();
		expect(ui.session.abort).not.toHaveBeenCalled();
		expect(ui.sessionManager.getLeafId()).toBe(originalLeafId);
	});

	it("allows navigation when compaction finishes while the dialog is open", async () => {
		const { ui, targetId, select } = createTreeUI();
		ui.session.isCompacting = true;
		ui.showExtensionSelector.mockImplementation(async () => {
			ui.session.isCompacting = false;
			return "No summary";
		});

		await select();

		expect(ui.session.navigateTree).toHaveBeenCalledWith(targetId, {
			summarize: false,
			customInstructions: undefined,
		});
		expect(ui.showError).not.toHaveBeenCalled();
	});

	it("still aborts an active response before navigating", async () => {
		const { ui, select } = createTreeUI();
		ui.session.isStreaming = true;
		ui.session.navigateTree.mockImplementation(async () => {
			expect(ui.session.isStreaming).toBe(false);
			expect(ui.restoreQueuedMessagesToEditor).toHaveBeenCalledOnce();
			return { cancelled: false };
		});

		await select();

		expect(ui.session.abort).toHaveBeenCalledOnce();
		expect(ui.session.navigateTree).toHaveBeenCalledOnce();
		expect(ui.showError).not.toHaveBeenCalled();
	});

	it("rechecks availability after the response abort settles", async () => {
		const { ui, onEscape, select } = createTreeUI();
		ui.session.isStreaming = true;
		ui.showExtensionSelector.mockResolvedValue("Summarize");
		ui.session.abort.mockImplementation(async () => {
			ui.session.isStreaming = false;
			ui.session.isCompacting = true;
		});

		await select();

		expect(ui.session.abort).toHaveBeenCalledOnce();
		expect(ui.showError).toHaveBeenCalledWith(busyMessage);
		expect(ui.showStatusIndicator).not.toHaveBeenCalled();
		expect(ui.clearStatusIndicator).not.toHaveBeenCalled();
		expect(ui.defaultEditor.onEscape).toBe(onEscape);
		expect(ui.session.navigateTree).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode tree branch deletion", () => {
	function createDeleteUI() {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(userMsg("A"));
		const b = sessionManager.appendMessage(assistantMsg("B"));
		const d = sessionManager.appendMessage(userMsg("D"));
		sessionManager.branch(b);
		const e = sessionManager.appendMessage(userMsg("E"));
		sessionManager.appendMessage(assistantMsg("F"));
		sessionManager.branch(d);

		let selector: TreeSelectorComponent | undefined;
		const ui = {
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
			session: {
				isStreaming: false,
				isCompacting: false,
				syncMessagesFromSession: vi.fn(),
			},
			defaultEditor: { onEscape: vi.fn() },
			editor: { getText: () => "", setText: vi.fn() },
			chatContainer: new Container(),
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			ui: { terminal: { rows: 24, setProgress: vi.fn() }, requestRender: vi.fn() },
			showSelector: (
				create: (done: () => void) => { component: TreeSelectorComponent; focus: TreeSelectorComponent },
			) => {
				selector = create(vi.fn()).component;
			},
			renderInitialMessages: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};
		const showTreeSelector = Reflect.get(InteractiveMode.prototype, "showTreeSelector") as (this: typeof ui) => void;
		showTreeSelector.call(ui);
		expect(selector).toBeDefined();
		return { ui, selector: selector!, ids: { b, d, e } };
	}

	it("prunes the branch, syncs messages, refreshes the selector, and shows a status", () => {
		const { ui, selector, ids } = createDeleteUI();

		selector.onDeleteBranch!(ids.e);

		expect(ui.sessionManager.getEntry(ids.e)).toBeUndefined();
		expect(ui.session.syncMessagesFromSession).toHaveBeenCalledOnce();
		expect(ui.showStatus).toHaveBeenCalledWith("Deleted branch (2 entries)");
		expect(ui.showError).not.toHaveBeenCalled();
		// No compaction window changed, so the chat is not re-rendered.
		expect(ui.renderInitialMessages).not.toHaveBeenCalled();
		// Selector stays mounted with the pruned tree and reselects the parent.
		expect(selector.getTreeList().getSelectedNode()?.entry.id).toBe(ids.b);
		expect(ui.ui.requestRender).toHaveBeenCalled();
	});

	it("re-renders the chat when the prune reports contextChanged", () => {
		const { ui, selector } = createDeleteUI();
		// Build an on-path compaction whose firstKept points at a label that will be dropped.
		const mgr = ui.sessionManager;
		const leaf = mgr.getLeafId()!;
		mgr.branch(mgr.getEntries()[0].id);
		const x = mgr.appendMessage(userMsg("X"));
		mgr.branch(leaf);
		const label = mgr.appendLabelChange(x, "mark");
		mgr.appendMessage(userMsg("B2"));
		mgr.appendCompaction("summary", label, 1000);
		mgr.appendMessage(userMsg("tail"));

		selector.onDeleteBranch!(x);

		expect(ui.session.syncMessagesFromSession).toHaveBeenCalledOnce();
		expect(ui.renderInitialMessages).toHaveBeenCalledOnce();
		expect(ui.showStatus).toHaveBeenCalledWith(expect.stringContaining("Deleted branch"));
	});

	it.each(["streaming", "compacting"] as const)("blocks the prune while %s", (kind) => {
		const { ui, selector, ids } = createDeleteUI();
		if (kind === "streaming") ui.session.isStreaming = true;
		else ui.session.isCompacting = true;

		selector.onDeleteBranch!(ids.e);

		expect(ui.sessionManager.getEntry(ids.e)).toBeDefined();
		expect(ui.session.syncMessagesFromSession).not.toHaveBeenCalled();
		expect(ui.renderInitialMessages).not.toHaveBeenCalled();
		expect(ui.showStatus).toHaveBeenCalledWith("Wait for the current response to finish before deleting a branch");
		expect(ui.showError).not.toHaveBeenCalled();
	});

	it("surfaces the active-path message from onDeleteBlocked", () => {
		const { ui, selector } = createDeleteUI();

		selector.onDeleteBlocked!("Cannot delete the branch you are currently on");

		expect(ui.showStatus).toHaveBeenCalledWith("Cannot delete the branch you are currently on");
	});

	it("shows an error when pruning an active-path entry", () => {
		const { ui, selector, ids } = createDeleteUI();

		selector.onDeleteBranch!(ids.d);

		expect(ui.showError).toHaveBeenCalledWith("Cannot delete the branch you are currently on");
		expect(ui.session.syncMessagesFromSession).not.toHaveBeenCalled();
	});
});
