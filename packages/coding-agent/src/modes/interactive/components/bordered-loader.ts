import { CancellableLoader, Container, Loader, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import type { Theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

/** Loader wrapped with borders for extension UI */
export class BorderedLoader extends Container {
	private loader: CancellableLoader | Loader;
	private cancellable: boolean;
	private signalController?: AbortController;

	constructor(tui: TUI, theme: Theme, message: string, options?: { cancellable?: boolean }) {
		super();
		this.cancellable = options?.cancellable ?? true;
		const borderColor = (s: string) => theme.fg("border", s);
		this.addChild(new DynamicBorder(borderColor));
		if (this.cancellable) {
			this.loader = new CancellableLoader(
				tui,
				(s) => theme.fg("accent", s),
				(s) => theme.fg("muted", s),
				message,
			);
		} else {
			this.signalController = new AbortController();
			this.loader = new Loader(
				tui,
				(s) => theme.fg("accent", s),
				(s) => theme.fg("muted", s),
				message,
			);
		}
		this.addChild(this.loader);
		if (this.cancellable) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(keyHint("tui.select.cancel", "cancel"), 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(borderColor));
	}

	get signal(): AbortSignal {
		if (this.cancellable) {
			return (this.loader as CancellableLoader).signal;
		}
		return this.signalController?.signal ?? new AbortController().signal;
	}

	set onAbort(fn: (() => void) | undefined) {
		if (this.cancellable) {
			(this.loader as CancellableLoader).onAbort = fn;
		}
	}

	handleInput(data: string): void {
		if (this.cancellable) {
			(this.loader as CancellableLoader).handleInput(data);
		}
	}

	dispose(): void {
		if ("dispose" in this.loader && typeof this.loader.dispose === "function") {
			this.loader.dispose();
		} else if ("stop" in this.loader && typeof this.loader.stop === "function") {
			this.loader.stop();
		}
	}
}
