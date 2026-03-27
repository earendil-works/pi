import { getOAuthProviders } from "@mariozechner/pi-ai/oauth";
import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Spacer,
	Text,
	type TUI,
} from "@mariozechner/pi-tui";
import { exec } from "child_process";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

const loginSelectListTheme: SelectListTheme = {
	selectedPrefix: (text) => theme.fg("accent", text),
	selectedText: (text) => theme.fg("accent", text),
	description: (text) => theme.fg("dim", text),
	scrollInfo: (text) => theme.fg("dim", text),
	noMatch: (text) => theme.fg("dim", text),
};

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export class LoginDialogComponent extends Container implements Focusable {
	private contentContainer: Container;
	private input: Input;
	private tui: TUI;
	private abortController = new AbortController();
	private inputResolver?: (value: string) => void;
	private inputRejecter?: (error: Error) => void;
	private selectList?: SelectList;

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
		this.addChild(this.contentContainer);

		// Input (always present, used when needed)
		this.input = new Input();
		this.input.onSubmit = () => {
			if (this.inputResolver) {
				this.inputResolver(this.input.getValue());
				this.inputResolver = undefined;
				this.inputRejecter = undefined;
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
		this.onComplete(false, "Login cancelled");
	}

	/**
	 * Called by onAuth callback - show URL and optional instructions
	 */
	showAuth(url: string, instructions?: string): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("accent", url), 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hyperlink = `\x1b]8;;${url}\x07${clickHint}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));

		if (instructions) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("warning", instructions), 1, 0));
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
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", prompt), 1, 0));
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input
	 * Note: Does NOT clear content, appends to existing (preserves URL from showAuth)
	 */
	showPrompt(message: string, placeholder?: string): Promise<string> {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		if (placeholder) {
			this.contentContainer.addChild(new Text(theme.fg("dim", `e.g., ${placeholder}`), 1, 0));
		}
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(
			new Text(
				`(${keyHint("tui.select.cancel", "to cancel,")} ${keyHint("tui.select.confirm", "to submit")})`,
				1,
				0,
			),
		);

		this.input.setValue("");
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * Show options for arrow-key navigation selection (e.g., headless vs browser auth)
	 */
	showOptions<T extends string>(
		message: string,
		options: { label: string; value: T; description?: string }[],
	): Promise<T> {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));

		// Create SelectList for arrow navigation
		const items: SelectItem[] = options.map((opt) => ({
			value: opt.value,
			label: opt.label,
			description: opt.description,
		}));

		this.selectList = new SelectList(items, 5, loginSelectListTheme);

		// Add a simple rendering wrapper for SelectList
		this.contentContainer.addChild({
			render: (width: number) => this.selectList!.render(width),
			invalidate: () => {},
		});
		this.contentContainer.addChild(
			new Text(
				`(${keyHint("tui.select.up", "↑↓ navigate,")} ${keyHint("tui.select.confirm", "select")}, ${keyHint("tui.select.cancel", "cancel")})`,
				1,
				0,
			),
		);

		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.selectList!.onSelect = (item) => {
				resolve(item.value as T);
			};
			this.selectList!.onCancel = () => {
				reject(new Error("Login cancelled"));
			};
		});
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	showWaiting(message: string): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		if (this.selectList) {
			this.selectList.handleInput(data);
		} else {
			this.input.handleInput(data);
		}
	}
}
