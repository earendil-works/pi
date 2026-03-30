import { Editor } from "@kennyfrc/mu-tui";

/** Editor with app-specific key bindings and bash mode ("!" prefix executes shell commands). */
export class CustomEditor extends Editor {
	public onEscape?: () => void;
	public onCtrlC?: () => void;
	public onCtrlT?: () => void;
	public onTab?: () => void;
	public onShiftTab?: () => void;
	public onCtrlP?: () => void;
	public onCtrlO?: () => void;
	public onOptionUp?: () => void;
	public onOptionDown?: () => void;
	public onHistoryUp?: () => boolean;
	public onHistoryDown?: () => boolean;

	private _bashMode = false;
	private historyNavActive = false;
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
		if (this.onCtrlT && data !== "\x14" && data.includes("\x14")) {
			const parts = data.split("\x14");
			for (let i = 0; i < parts.length; i++) {
				const part = parts[i] ?? "";
				if (part) this.handleInput(part);
				if (i < parts.length - 1) this.onCtrlT();
			}
			return;
		}

		// Ctrl+O can arrive in different encodings depending on terminal protocol.
		// Handle both the ASCII control character (\x0f) and Kitty CSI-u (ESC [ 111 ; 5 u).
		// Also handle the case where terminals batch multiple events into a single chunk.
		if (this.onCtrlO) {
			const kittyCtrlO = "\x1b[111;5u";
			if (data !== "\x0f" && data.includes("\x0f")) {
				const parts = data.split("\x0f");
				for (let i = 0; i < parts.length; i++) {
					const part = parts[i] ?? "";
					if (part) this.handleInput(part);
					if (i < parts.length - 1) this.onCtrlO();
				}
				return;
			}
			if (data !== kittyCtrlO && data.includes(kittyCtrlO)) {
				const parts = data.split(kittyCtrlO);
				for (let i = 0; i < parts.length; i++) {
					const part = parts[i] ?? "";
					if (part) this.handleInput(part);
					if (i < parts.length - 1) this.onCtrlO();
				}
				return;
			}
		}

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

		// History navigation mode: UP/DOWN navigate history entries regardless of cursor position
		// Non-UP/DOWN keys exit history mode before being processed normally
		if (this.historyNavActive) {
			// In history mode, UP/DOWN always navigate (ignore cursor position)
			if (data === "\x1b[A" && this.onHistoryUp) {
				const navigated = this.onHistoryUp();
				// Stay in history mode only if navigation succeeded
				this.historyNavActive = navigated;
				return;
			}
			if (data === "\x1b[B" && this.onHistoryDown) {
				const navigated = this.onHistoryDown();
				// Stay in history mode only if navigation succeeded
				// Exiting at bottom (returning to draft) also exits history mode
				this.historyNavActive = navigated;
				return;
			}
			// Any non-arrow key exits history mode first, then processes normally
			this.historyNavActive = false;
		} else {
			// Not in history mode: check boundaries to enter history mode
			// Block history nav when: autocomplete open, bash mode active
			const canEnterHistoryNav = !this.isShowingAutocomplete() && !this._bashMode;

			if (data === "\x1b[A" && this.onHistoryUp && canEnterHistoryNav && this.isAtFirstVisualLine()) {
				const navigated = this.onHistoryUp();
				if (navigated) {
					this.historyNavActive = true;
				}
				return;
			}
			if (data === "\x1b[B" && this.onHistoryDown && canEnterHistoryNav && this.isAtLastVisualLine()) {
				const navigated = this.onHistoryDown();
				if (navigated) {
					this.historyNavActive = true;
				}
				return;
			}
		}
		if ((data === "\x0f" || data === "\x1b[111;5u") && this.onCtrlO) {
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
		if (data === "\x14" && this.onCtrlT) {
			this.onCtrlT();
			return;
		}

		super.handleInput(data);
	}
}
