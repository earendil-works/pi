import type { CapturedOutputStream, Terminal } from "@earendil-works/pi-tui";
import { ProcessTerminal, type TUI, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { copyToClipboard } from "../../utils/clipboard.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { keyDisplayText } from "./components/keybinding-hints.ts";
import { theme } from "./theme/theme.ts";

export interface InteractiveTuiOptions {
	readonly tuiMode: "regular" | "fullscreen";
	readonly showHardwareCursor: boolean;
	readonly logDirectory: string;
	readonly terminal?: Terminal;
	readonly onRightClickPaste?: () => void;
	readonly fullscreenCopyOnSelect?: boolean;
	/** See ProcessTerminalOptions.onCapturedOutput; ignored when a terminal is passed in. */
	readonly onCapturedOutput?: (text: string, stream: CapturedOutputStream) => void;
}

/** Composition root shared by coding-agent presentations. */
export function createInteractiveTui(options: InteractiveTuiOptions & { readonly tuiMode: "fullscreen" }): TuiAltScreen;
export function createInteractiveTui(options: InteractiveTuiOptions & { readonly tuiMode: "regular" }): TuiMainScreen;
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen;
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen {
	const terminal = options.terminal ?? new ProcessTerminal({ onCapturedOutput: options.onCapturedOutput });
	if (options.tuiMode === "fullscreen") {
		const styleSearchMatch = (text: string) => theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
		return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
			searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
			searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(styleSearchMatch(text))),
			searchNavigationButtonStyle: (text, hovered) => (hovered ? theme.underline(text) : text),
			scrollToEndIndicator: () => {
				const shortcut = keyDisplayText("tui.altScreen.bottom");
				const label = ` ↓ Jump to latest message${shortcut ? ` · ${shortcut}` : ""} `;
				return theme.bg("selectedBg", theme.fg("text", label));
			},
			openUrl: openBrowser,
			onRightClickPaste: options.onRightClickPaste,
			copyOnSelect: options.fullscreenCopyOnSelect,
			copySelection: async (text) => {
				try {
					await copyToClipboard(text);
					return true;
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
			},
		});
	}
	return new TuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);
}

/** Stable reference for components while InteractiveMode replaces the active renderer. */
export function createInteractiveTuiReference(getTui: () => TUI): TUI {
	return new Proxy({} as TUI, {
		get: (_target, property) => {
			const tui = getTui();
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			let methodTui = tui;
			let method = value;
			return (...args: unknown[]) => {
				const currentTui = getTui();
				if (currentTui !== methodTui) {
					const currentMethod = Reflect.get(currentTui, property, currentTui);
					if (typeof currentMethod !== "function") {
						throw new TypeError(`TUI property ${String(property)} is not callable`);
					}
					methodTui = currentTui;
					method = currentMethod;
				}
				return Reflect.apply(method, methodTui, args);
			};
		},
		set: (_target, property, value) => {
			const tui = getTui();
			return Reflect.set(tui, property, value, tui);
		},
		has: (_target, property) => Reflect.has(getTui(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
	});
}
