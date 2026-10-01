/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import { Container, getKeybindings, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

/** An option label animated while it is selected. Requires `tui` to schedule frames. */
export interface ExtensionSelectorAnimatedOption {
	option: string;
	/** Renders the selected label; `elapsedMs` counts from when the option was selected. */
	render: (elapsedMs: number) => string;
}

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
	description?: string;
	/** Text shown above the title, separated by a blank line. */
	intro?: string;
	animatedOption?: ExtensionSelectorAnimatedOption;
}

const ANIMATION_FRAME_MS = 50;

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;
	private tui: TUI | undefined;
	private animatedOption: ExtensionSelectorAnimatedOption | undefined;
	private animationText: Text | undefined;
	private animationTimer: ReturnType<typeof setInterval> | undefined;
	private animationStart = 0;
	private lastRender = 0;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.baseTitle = title;
		this.tui = opts?.tui;
		this.animatedOption = opts?.tui ? opts.animatedOption : undefined;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		if (opts?.intro) {
			this.addChild(new Text(theme.fg("text", opts.intro), 1, 0));
			this.addChild(new Spacer(1));
		}

		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		this.addChild(this.titleText);
		if (opts?.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("text", opts.description), 1, 0));
		}
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	override render(width: number): string[] {
		this.lastRender = performance.now();
		return super.render(width);
	}

	private updateList(): void {
		this.listContainer.clear();
		this.animationText = undefined;
		for (let i = 0; i < this.options.length; i++) {
			const isSelected = i === this.selectedIndex;
			const option = this.options[i] as string;
			if (isSelected && this.animatedOption?.option === option) {
				this.animationText = new Text(this.animatedLine(0), 1, 0);
				this.listContainer.addChild(this.animationText);
				continue;
			}
			const text = isSelected
				? theme.fg("accent", "→ ") + theme.fg("accent", option)
				: `  ${theme.fg("text", option)}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
		if (this.animationText) this.startAnimation();
		else this.stopAnimation();
	}

	private animatedLine(elapsedMs: number): string {
		return theme.fg("accent", "→ ") + (this.animatedOption?.render(elapsedMs) ?? "");
	}

	private startAnimation(): void {
		if (this.animationTimer) return;
		this.animationStart = performance.now();
		this.lastRender = this.animationStart;
		this.animationTimer = setInterval(() => {
			// Stop when no longer rendered, e.g. when the selector was replaced without being disposed.
			if (!this.animationText || performance.now() - this.lastRender > 1000) {
				this.stopAnimation();
				return;
			}
			this.animationText.setText(this.animatedLine(performance.now() - this.animationStart));
			this.tui?.requestRender();
		}, ANIMATION_FRAME_MS);
		this.animationTimer.unref?.();
	}

	private stopAnimation(): void {
		if (!this.animationTimer) return;
		clearInterval(this.animationTimer);
		this.animationTimer = undefined;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) {
				this.stopAnimation();
				this.onSelectCallback(selected);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.stopAnimation();
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
		this.stopAnimation();
	}
}
