import type { OAuthPrompt } from "@mariozechner/pi-ai";
import { getOAuthProviders } from "@mariozechner/pi-ai/oauth";
import { Container, type Focusable, getEditorKeybindings, Input, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import { exec } from "child_process";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export class LoginDialogComponent extends Container implements Focusable {
	private contentContainer: Container;
	private infoContainer: Container;
	private promptContainer: Container;
	private input: Input;
	private tui: TUI;
	private abortController = new AbortController();
	private inputResolver?: (value: string) => void;
	private inputRejecter?: (error: Error) => void;
	private choiceOptions: string[] | undefined;
	private choiceIndex = 0;
	private choiceList: Container | undefined;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		tui: TUI,
		providerId: string,
		private onComplete: (success: boolean, message?: string) => void,
	) {
		super();
		this.tui = tui;

		const providerInfo = getOAuthProviders().find((p) => p.id === providerId);
		const providerName = providerInfo?.name || providerId;

		// Top border
		this.addChild(new DynamicBorder());

		// Title
		this.addChild(new Text(theme.fg("warning", `Login to ${providerName}`), 1, 0));

		// Dynamic content area
		this.contentContainer = new Container();
		this.infoContainer = new Container();
		this.promptContainer = new Container();
		this.contentContainer.addChild(this.infoContainer);
		this.contentContainer.addChild(this.promptContainer);
		this.addChild(this.contentContainer);

		// Input (always present, used when needed)
		this.input = new Input();
		this.input.onSubmit = () => {
			if (this.inputResolver) {
				this.resolvePrompt(this.input.getValue());
			}
		};
		this.input.onEscape = () => {
			this.cancel();
		};

		// Bottom border
		this.addChild(new DynamicBorder());
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	private cancel(): void {
		this.abortController.abort();
		if (this.inputRejecter) {
			this.inputRejecter(new Error("Login cancelled"));
			this.inputResolver = undefined;
			this.inputRejecter = undefined;
		}
		this.choiceOptions = undefined;
		this.choiceList = undefined;
		this.onComplete(false, "Login cancelled");
	}

	private clearPrompt(): void {
		this.promptContainer.clear();
		this.choiceOptions = undefined;
		this.choiceIndex = 0;
		this.choiceList = undefined;
		this.input.setValue("");
	}

	private resolvePrompt(value: string): void {
		if (!this.inputResolver) {
			return;
		}
		const resolve = this.inputResolver;
		this.inputResolver = undefined;
		this.inputRejecter = undefined;
		this.clearPrompt();
		resolve(value);
	}

	private updateChoiceList(): void {
		if (!this.choiceList || !this.choiceOptions) {
			return;
		}

		this.choiceList.clear();
		for (let i = 0; i < this.choiceOptions.length; i++) {
			const isSelected = i === this.choiceIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const text = isSelected
				? theme.fg("accent", this.choiceOptions[i] ?? "")
				: theme.fg("text", this.choiceOptions[i] ?? "");
			this.choiceList.addChild(new Text(`${prefix}${text}`, 1, 0));
		}
	}

	/**
	 * Called by onAuth callback - show URL and optional instructions
	 */
	showAuth(url: string, instructions?: string): void {
		this.infoContainer.clear();
		this.clearPrompt();
		this.infoContainer.addChild(new Spacer(1));
		this.infoContainer.addChild(new Text(theme.fg("accent", url), 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hyperlink = `\x1b]8;;${url}\x07${clickHint}\x1b]8;;\x07`;
		this.infoContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));

		if (instructions) {
			this.infoContainer.addChild(new Spacer(1));
			this.infoContainer.addChild(new Text(theme.fg("warning", instructions), 1, 0));
		}

		// Try to open browser
		const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
		exec(`${openCmd} "${url}"`);

		this.tui.requestRender();
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string): Promise<string> {
		this.clearPrompt();
		this.promptContainer.addChild(new Spacer(1));
		this.promptContainer.addChild(new Text(theme.fg("dim", prompt), 1, 0));
		this.promptContainer.addChild(this.input);
		this.promptContainer.addChild(
			new Text(`(${keyHint("selectCancel", "to cancel,")} ${keyHint("selectConfirm", "to submit")})`, 1, 0),
		);
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input
	 */
	showPrompt(prompt: OAuthPrompt): Promise<string> {
		this.clearPrompt();
		this.promptContainer.addChild(new Spacer(1));
		this.promptContainer.addChild(new Text(theme.fg("text", prompt.message), 1, 0));
		if (prompt.placeholder) {
			this.promptContainer.addChild(new Text(theme.fg("dim", `e.g., ${prompt.placeholder}`), 1, 0));
		}

		if (prompt.choices && prompt.choices.length > 0) {
			this.choiceOptions = prompt.choices;
			this.choiceIndex = 0;
			this.choiceList = new Container();
			this.promptContainer.addChild(new Spacer(1));
			this.promptContainer.addChild(this.choiceList);
			this.updateChoiceList();
			this.promptContainer.addChild(
				new Text(
					`${rawKeyHint("↑↓", "navigate")} ${keyHint("selectConfirm", "to select,")} ${keyHint("selectCancel", "to cancel")}`,
					1,
					0,
				),
			);
		} else {
			this.promptContainer.addChild(this.input);
			this.promptContainer.addChild(
				new Text(`(${keyHint("selectCancel", "to cancel,")} ${keyHint("selectConfirm", "to submit")})`, 1, 0),
			);
		}
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	showWaiting(message: string): void {
		this.clearPrompt();
		this.promptContainer.addChild(new Spacer(1));
		this.promptContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.promptContainer.addChild(new Text(`(${keyHint("selectCancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		this.clearPrompt();
		this.promptContainer.addChild(new Spacer(1));
		this.promptContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const kb = getEditorKeybindings();

		if (kb.matches(data, "selectCancel")) {
			this.cancel();
			return;
		}

		if (this.choiceOptions && this.choiceOptions.length > 0) {
			if (kb.matches(data, "selectUp") || data === "k") {
				this.choiceIndex = Math.max(0, this.choiceIndex - 1);
				this.updateChoiceList();
				this.tui.requestRender();
				return;
			}
			if (kb.matches(data, "selectDown") || data === "j") {
				this.choiceIndex = Math.min(this.choiceOptions.length - 1, this.choiceIndex + 1);
				this.updateChoiceList();
				this.tui.requestRender();
				return;
			}
			if (kb.matches(data, "selectConfirm") || data === "\n") {
				const selected = this.choiceOptions[this.choiceIndex];
				if (selected) {
					this.resolvePrompt(selected);
				}
				return;
			}
		}

		// Pass to input
		this.input.handleInput(data);
	}
}
