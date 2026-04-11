/**
 * TUI session selector for --resume flag
 */

import { ProcessTerminal, setKeybindings, TUI } from "@tculpepp/spi-tui";
import { KeybindingsManager } from "../core/keybindings.js";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.js";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.js";

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/** Show TUI session selector and return selected session path or null if cancelled */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
): Promise<string | null> {
	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal());
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(path: string) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(path);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				ui.stop();
				process.exit(0);
			},
			() => ui.requestRender(),
			{ showRenameHint: false, keybindings },
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		ui.start();
	});
}
