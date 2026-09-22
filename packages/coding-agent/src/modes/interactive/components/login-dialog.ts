import type { AuthInfoLink, OAuthDeviceCodeInfo } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	TruncatedText,
	type TUI,
} from "@earendil-works/pi-tui";
import { copyToClipboard } from "../../../utils/clipboard.ts";
import { openBrowser } from "../../../utils/open-browser.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

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
	private deviceCodeAction?: { info: OAuthDeviceCodeInfo; hint: Container };
	private deviceCodeHint?: Container;
	private onComplete: (success: boolean, message?: string) => void;

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
		onComplete: (success: boolean, message?: string) => void,
		providerNameOverride?: string,
		titleOverride?: string,
	) {
		super();
		this.tui = tui;
		this.onComplete = onComplete;

		const providerName = providerNameOverride || providerId;
		const title = titleOverride ?? `Login to ${providerName}`;

		// Top border
		this.addChild(new DynamicBorder());

		// Title
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		// Dynamic content area
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// Input (always present, used when needed)
		this.input = new Input();
		this.input.onSubmit = () => {
			if (this.inputResolver) {
				const value = this.input.getValue();
				this.replaceInputWithSubmittedText(value);
				this.inputResolver(value);
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

	private replaceInputWithSubmittedText(value: string): void {
		this.contentContainer.children = this.contentContainer.children.map((child) =>
			child === this.input ? new Text(`> ${value}`, 0, 0) : child,
		);
	}

	private clearDeviceCodeAction(): void {
		if (this.deviceCodeHint) {
			this.contentContainer.removeChild(this.deviceCodeHint);
		}
		this.deviceCodeHint = undefined;
		this.deviceCodeAction = undefined;
	}

	private cancel(): void {
		this.clearDeviceCodeAction();
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
		this.clearDeviceCodeAction();
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		const linkedUrl = `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hyperlink = `\x1b]8;;${url}\x07${clickHint}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));

		if (instructions) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("warning", instructions), 1, 0));
		}

		openBrowser(url);
		this.tui.requestRender();
	}

	/**
	 * Called by onDeviceCode callback - show URL and user code.
	 */
	showDeviceCode(info: OAuthDeviceCodeInfo): void {
		info = {
			...info,
			openBrowserOnConfirm: info.openBrowserOnConfirm ?? true,
			copyCodeOnConfirm: info.copyCodeOnConfirm ?? true,
		};
		this.clearDeviceCodeAction();
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		const linkedUrl = `\x1b]8;;${info.verificationUri}\x07${info.verificationUri}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hyperlink = `\x1b]8;;${info.verificationUri}\x07${clickHint}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("warning", `Enter code: ${info.userCode}`), 1, 0));

		if (!this.signal.aborted && (info.openBrowserOnConfirm || info.copyCodeOnConfirm)) {
			const actionLabel = info.openBrowserOnConfirm
				? info.copyCodeOnConfirm
					? "to open browser and copy code"
					: "to open browser"
				: "to copy code";
			// Reuse this single row for progress/result text, including in narrow terminals.
			const hint = new Container();
			hint.addChild(new TruncatedText(`(${keyHint("tui.select.confirm", actionLabel)})`, 1, 0));
			this.contentContainer.addChild(hint);
			this.deviceCodeHint = hint;
			this.deviceCodeAction = { info, hint };
		}
		this.tui.requestRender();
	}

	private setDeviceCodeStatus(hint: Container, message: string): void {
		if (this.signal.aborted || !this.focused || !this.contentContainer.children.includes(hint)) return;
		hint.children = [new TruncatedText(theme.fg("dim", message), 1, 0)];
		this.tui.requestRender();
	}

	private activateDeviceCode(info: OAuthDeviceCodeInfo, hint: Container): void {
		this.setDeviceCodeStatus(hint, info.copyCodeOnConfirm ? "Copying code..." : "Browser open requested");
		if (info.copyCodeOnConfirm) {
			// Do not delay polling or browser opening while clipboard tools are running.
			void copyToClipboard(info.userCode)
				.then(() => this.setDeviceCodeStatus(hint, "Code copied to clipboard"))
				.catch(() => this.setDeviceCodeStatus(hint, "Copy code manually"));
		}
		if (info.openBrowserOnConfirm) {
			try {
				// The shared launcher also opens files; device-code login must only open web URLs.
				const url = new URL(info.verificationUri);
				if (url.protocol === "https:" || url.protocol === "http:") openBrowser(url.href);
			} catch {
				// Invalid URLs or launcher failures must not interrupt login.
			}
		}
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string): Promise<string> {
		this.clearDeviceCodeAction();
		this.input.setValue("");
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
		this.clearDeviceCodeAction();
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

	/** Show informational text before another login step. */
	showDetails(lines: string[]): void {
		this.clearDeviceCodeAction();
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		for (const line of lines) {
			this.contentContainer.addChild(new Text(line, 1, 0));
		}
		this.tui.requestRender();
	}

	/** Show provider-owned information and links without starting an auth callback flow. */
	showInfo(message: string, links: readonly AuthInfoLink[] = [], showCloseHint = false): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		for (const link of links) {
			const text = link.label ? `${link.label}: ${link.url}` : link.url;
			const hyperlink = `\x1b]8;;${link.url}\x07${text}\x1b]8;;\x07`;
			this.contentContainer.addChild(new Text(theme.fg("accent", hyperlink), 1, 0));
		}
		if (showCloseHint) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to close")})`, 1, 0));
		}
		this.tui.requestRender();
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

		if (
			this.deviceCodeAction &&
			!this.inputResolver &&
			!this.signal.aborted &&
			this.focused &&
			kb.matches(data, "tui.select.confirm")
		) {
			const action = this.deviceCodeAction;
			// Consume once so a repeated Enter cannot launch multiple browsers or clipboard writes.
			this.deviceCodeAction = undefined;
			this.activateDeviceCode(action.info, action.hint);
			this.tui.requestRender();
			return;
		}

		// Pass to input
		this.input.handleInput(data);
	}
}
