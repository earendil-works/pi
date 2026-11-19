/**
 * TUI session selector for --resume flag
 */

import { setKeybindings } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";
import { flushStdout } from "../utils/flush-stdout.ts";
import { createStartupTui, startStartupTui } from "./startup-ui.ts";

type SessionsLoader = (onProgress?: SessionListProgress, signal?: AbortSignal) => Promise<SessionInfo[]>;

/** Show TUI session selector and return selected session path or null if cancelled */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	settingsManager: SettingsManager,
): Promise<string | null> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;
		// Callers may exit right after; flush the TUI's terminal mode resets first (#12133).
		const stopUi = (): Promise<void> => {
			ui.stop();
			return flushStdout();
		};

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(path: string) => {
				if (!resolved) {
					resolved = true;
					void stopUi().then(() => resolve(path));
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					void stopUi().then(() => resolve(null));
				}
			},
			() => {
				void stopUi().then(() => process.exit(0));
			},
			() => ui.requestRender(),
			{ showRenameHint: false, keybindings },
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		startStartupTui(ui, settingsManager);
	});
}
