import { Container, SelectList, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
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
	private readonly shimmer: RadiusLoginSelectorOptions["shimmer"];
	private readonly selectList: SelectList;
	private selectedOption: string | undefined;
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
		this.shimmer = selectorOptions.shimmer;
		this.selectedOption = options[0];

		const listTheme = getSelectListTheme();
		const items = options.map((option) => ({ value: option, label: option }));
		this.selectList = new SelectList(items, Math.max(1, items.length), {
			...listTheme,
			selectedText: (line) =>
				this.selectedOption === this.shimmer?.option
					? this.animatedLine(performance.now() - this.animationStart)
					: listTheme.selectedText(line),
		});
		this.selectList.onSelectionChange = (item) => this.selectOption(item.value);
		this.selectList.onSelect = (item) => {
			this.stopAnimation();
			onSelect(item.value);
		};
		this.selectList.onCancel = () => {
			this.stopAnimation();
			onCancel();
		};

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		if (selectorOptions.intro) {
			this.addChild(new Text(theme.fg("text", selectorOptions.intro), 1, 0));
			this.addChild(new Spacer(1));
		}
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.selectList);
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
		if (this.selectedOption === this.shimmer?.option) this.startAnimation();
	}

	private selectOption(option: string): void {
		this.selectedOption = option;
		if (option === this.shimmer?.option) this.startAnimation();
		else this.stopAnimation();
	}

	private animatedLine(elapsedMs: number): string {
		if (!this.shimmer) return "";
		return theme.fg("accent", "→ ") + radiusShimmer(this.shimmer.text, elapsedMs) + this.shimmer.suffix;
	}

	private startAnimation(): void {
		if (this.animationTimer) return;
		this.animationStart = performance.now();
		this.animationTimer = setInterval(() => this.tui.requestRender(), ANIMATION_FRAME_MS);
		this.animationTimer.unref?.();
	}

	private stopAnimation(): void {
		if (!this.animationTimer) return;
		clearInterval(this.animationTimer);
		this.animationTimer = undefined;
	}

	handleInput(keyData: string): void {
		this.selectList.handleInput(keyData);
	}

	dispose(): void {
		this.stopAnimation();
	}
}
