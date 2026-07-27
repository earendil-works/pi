/**
 * TUI loadout selector for `pi loadout` command
 */

import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../core/settings-manager.ts";
import {
	LoadoutSelectorComponent,
	type ScopedResolvedPaths,
} from "../modes/interactive/components/loadout-selector.ts";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.ts";

export interface LoadoutSelectorOptions {
	resolvedPaths: ScopedResolvedPaths;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
	writeScope: "global" | "project";
	projectModeAvailable: boolean;
}

/** Show TUI loadout selector and return when closed */
export async function selectLoadout(options: LoadoutSelectorOptions): Promise<void> {
	// Initialize theme before showing TUI
	initTheme(options.settingsManager.getTheme(), true);

	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal(), undefined, options.agentDir);
		let resolved = false;

		const selector = new LoadoutSelectorComponent(
			options.resolvedPaths,
			options.settingsManager,
			options.cwd,
			options.agentDir,
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					stopThemeWatcher();
					resolve();
				}
			},
			() => {
				ui.stop();
				stopThemeWatcher();
				process.exit(0);
			},
			() => ui.requestRender(),
			ui.terminal.rows,
			options.writeScope,
			options.projectModeAvailable,
		);

		ui.addChild(selector);
		ui.setFocus(selector.getResourceList());
		ui.start();
	});
}
