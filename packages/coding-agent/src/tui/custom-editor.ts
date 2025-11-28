import { Editor } from "@mariozechner/pi-tui";

/**
 * Custom editor that handles Escape and Ctrl+C keys for coding-agent
 */
export class CustomEditor extends Editor {
	public onEscape?: () => void;
	public onCtrlC?: () => void;
	public onShiftTab?: () => void;
	public onCtrlP?: () => void;
	public onCtrlO?: () => void;
	public onOptionUp?: () => void;
	public onOptionDown?: () => void;

	handleInput(data: string): void {
		// Intercept Ctrl+O for tool output expansion
		if (data === "\x0f" && this.onCtrlO) {
			this.onCtrlO();
			return;
		}

		// Intercept Ctrl+P for model cycling
		if (data === "\x10" && this.onCtrlP) {
			this.onCtrlP();
			return;
		}

		// Intercept Option/Alt+Up for queue navigation
		if (data === "\x1b[1;3A" && this.onOptionUp) {
			this.onOptionUp();
			return;
		}

		// Intercept Option/Alt+Down for queue navigation
		if (data === "\x1b[1;3B" && this.onOptionDown) {
			this.onOptionDown();
			return;
		}

		// Intercept Shift+Tab for thinking level cycling
		if (data === "\x1b[Z" && this.onShiftTab) {
			this.onShiftTab();
			return;
		}

		// Intercept Escape key - but only if autocomplete is NOT active
		// (let parent handle escape for autocomplete cancellation)
		if (data === "\x1b" && this.onEscape && !this.isShowingAutocomplete()) {
			this.onEscape();
			return;
		}

		// Intercept Ctrl+C
		if (data === "\x03" && this.onCtrlC) {
			this.onCtrlC();
			return;
		}

		// Pass to parent for normal handling
		super.handleInput(data);
	}
}
