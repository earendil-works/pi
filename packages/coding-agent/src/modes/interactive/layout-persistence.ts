/**
 * Layout persistence — save/restore tab and pane layout across sessions.
 *
 * Serializes the TabManager's tab structure (split trees + pane metadata)
 * to a JSON file. Instance-scoped debounce timer avoids both module-level
 * singleton issues and thrashing on rapid layout changes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SplitNode } from "@mariozechner/pi-tui";
import type { Tab } from "./tab-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SerializedTab {
	id: string;
	label: string;
	splitRoot: SplitNode;
	activePaneId: string;
}

export interface SerializedLayout {
	version: 1;
	activeTabIndex: number;
	tabs: SerializedTab[];
}

// ---------------------------------------------------------------------------
// LayoutPersistence
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 2000;

export class LayoutPersistence {
	private readonly agentDir: string;
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	private getLayoutPath(): string {
		return path.join(this.agentDir, "layout.json");
	}

	/**
	 * Save layout to disk (debounced 2s).
	 */
	save(tabs: readonly Tab[], activeTabIndex: number): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);

		this.debounceTimer = setTimeout(() => {
			const layout: SerializedLayout = {
				version: 1,
				activeTabIndex,
				tabs: tabs.map((t) => ({
					id: t.id,
					label: t.label,
					splitRoot: t.splitRoot,
					activePaneId: t.activePaneId,
				})),
			};

			try {
				const layoutPath = this.getLayoutPath();
				fs.mkdirSync(path.dirname(layoutPath), { recursive: true });
				fs.writeFileSync(layoutPath, JSON.stringify(layout, null, 2), "utf-8");
			} catch {
				// Non-fatal — layout persistence is best-effort
			}
		}, DEBOUNCE_MS);
	}

	/**
	 * Restore layout from disk.
	 * Returns undefined if no saved layout exists or it's corrupt.
	 */
	restore(): SerializedLayout | undefined {
		try {
			const layoutPath = this.getLayoutPath();
			if (!fs.existsSync(layoutPath)) return undefined;
			const raw = fs.readFileSync(layoutPath, "utf-8");
			const parsed = JSON.parse(raw) as SerializedLayout;
			if (parsed.version !== 1 || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0) {
				return undefined;
			}
			return parsed;
		} catch {
			return undefined;
		}
	}

	/**
	 * Cancel any pending debounced write and clean up.
	 */
	dispose(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
	}
}
