import { Editor } from "@kennyfrc/mu-tui";

/** Editor with app-specific key bindings and bash mode ("!" prefix executes shell commands). */
export class CustomEditor extends Editor {
	public onEscape?: () => void;
	public onCtrlC?: () => void;
	public onTab?: () => void;
	public onShiftTab?: () => void;
	public onCtrlP?: () => void;
	public onCtrlO?: () => void;
	public onOptionUp?: () => void;
	public onOptionDown?: () => void;
	public onHistoryUp?: () => void;
	public onHistoryDown?: () => void;

	private _bashMode = false;
	public onBashSubmit?: (command: string) => void;
	public onBashModeChange?: (enabled: boolean) => void;

	get bashMode(): boolean {
		return this._bashMode;
	}

	setBashMode(enabled: boolean): void {
		if (this._bashMode !== enabled) {
			this._bashMode = enabled;
			this.onBashModeChange?.(enabled);
		}
	}

	/**
	 * Intercepts keys before parent Editor. Autocomplete checks required for arrow/escape
	 * keys to allow parent's SelectList navigation when menu is open.
	 */
	handleInput(data: string): void {
		if (data === "!" && !this._bashMode && this.getText().trim() === "" && this.isAtFirstLine()) {
			this.setBashMode(true);
			return;
		}
		if (this._bashMode && (data === "\x7f" || data === "\x08") && this.getText().trim() === "") {
			this.setBashMode(false);
			return;
		}
		if (this._bashMode && data === "\r") {
			const command = this.getText().trim();
			if (command && this.onBashSubmit) {
				this.onBashSubmit(command);
				this.setBashMode(false);
				this.setText("");
			} else if (!command) {
				this.setBashMode(false);
			}
			return;
		}
		if (this._bashMode && data === "\x1b" && !this.isShowingAutocomplete()) {
			this.setBashMode(false);
			this.setText("");
			return;
		}

		// Use visual line methods for history navigation to handle wrapped text correctly
		if (data === "\x1b[A" && this.onHistoryUp && this.isAtFirstVisualLine() && !this.isShowingAutocomplete()) {
			this.onHistoryUp();
			return;
		}
		if (data === "\x1b[B" && this.onHistoryDown && this.isAtLastVisualLine() && !this.isShowingAutocomplete()) {
			this.onHistoryDown();
			return;
		}
		if (data === "\x0f" && this.onCtrlO) {
			this.onCtrlO();
			return;
		}
		if (data === "\x10" && this.onCtrlP) {
			this.onCtrlP();
			return;
		}
		if (data === "\x1b[1;3A" && this.onOptionUp) {
			this.onOptionUp();
			return;
		}
		if (data === "\x1b[1;3B" && this.onOptionDown) {
			this.onOptionDown();
			return;
		}
		// Intercept Tab for thinking toggle (only when not autocompleting)
		if (data === "\t" && this.onTab && !this.isShowingAutocomplete()) {
			this.onTab();
			return;
		}
		if (data === "\x1b[Z" && this.onShiftTab && !this.isShowingAutocomplete()) {
			this.onShiftTab();
			return;
		}
		if (data === "\x1b" && this.onEscape && !this.isShowingAutocomplete()) {
			this.onEscape();
			return;
		}
		if (data === "\x03" && this.onCtrlC) {
			this.onCtrlC();
			return;
		}

		super.handleInput(data);
	}
}
