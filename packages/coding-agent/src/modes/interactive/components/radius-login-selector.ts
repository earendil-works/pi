import { Container, getKeybindings, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";
import { radiusShimmer } from "./radius-shimmer.ts";

const ANIMATION_FRAME_MS = 50;

type RadiusLoginSelectorOptions = {
	intro?: string;
	shimmer?: {
		option: string;
		text: string;
		suffix: string;
	};
};

/** Selector for the Radius login flow, including its intro and animated sign-in option. */
export class RadiusLoginSelectorComponent extends Container {
	private readonly tui: TUI;
	private readonly options: string[];
	private readonly onSelect: (option: string) => void;
	private readonly onCancel: () => void;
	private readonly shimmer: RadiusLoginSelectorOptions["shimmer"];
	private readonly listContainer = new Container();
	private selectedIndex = 0;
	private animationText: Text | undefined;
	private animationTimer: ReturnType<typeof setInterval> | undefined;
	private animationStart = 0;

	constructor(
		tui: TUI,
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		selectorOptions: RadiusLoginSelectorOptions = {},
	) {
		super();
		this.tui = tui;
		this.options = options;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.shimmer = selectorOptions.shimmer;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		if (selectorOptions.intro) {
			this.addChild(new Text(theme.fg("text", selectorOptions.intro), 1, 0));
			this.addChild(new Spacer(1));
		}
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));
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

	private updateList(): void {
		this.listContainer.clear();
		this.animationText = undefined;
		for (let i = 0; i < this.options.length; i++) {
			const option = this.options[i] as string;
			if (i === this.selectedIndex && this.shimmer?.option === option) {
				this.animationText = new Text(this.animatedLine(0), 1, 0);
				this.listContainer.addChild(this.animationText);
				continue;
			}
			const text =
				i === this.selectedIndex
					? theme.fg("accent", "→ ") + theme.fg("accent", option)
					: `  ${theme.fg("text", option)}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
		if (this.animationText) this.startAnimation();
		else this.stopAnimation();
	}

	private animatedLine(elapsedMs: number): string {
		if (!this.shimmer) return "";
		return theme.fg("accent", "→ ") + radiusShimmer(this.shimmer.text, elapsedMs) + this.shimmer.suffix;
	}

	private startAnimation(): void {
		if (this.animationTimer) return;
		this.animationStart = performance.now();
		this.animationTimer = setInterval(() => {
			this.animationText?.setText(this.animatedLine(performance.now() - this.animationStart));
			this.tui.requestRender();
		}, ANIMATION_FRAME_MS);
		this.animationTimer.unref?.();
	}

	private stopAnimation(): void {
		if (!this.animationTimer) return;
		clearInterval(this.animationTimer);
		this.animationTimer = undefined;
	}

	handleInput(keyData: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (keybindings.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (keybindings.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) {
				this.stopAnimation();
				this.onSelect(selected);
			}
		} else if (keybindings.matches(keyData, "tui.select.cancel")) {
			this.stopAnimation();
			this.onCancel();
		}
	}

	dispose(): void {
		this.stopAnimation();
	}
}
