/**
 * The `/login` menu with the animated "Sign in with Radius" option. Internal to the interactive mode.
 */

import { Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { ExtensionSelectorComponent } from "./extension-selector.ts";
import { radiusShimmer, startBrandAnimation } from "./provider-brand.ts";

/** The "Sign in with Radius" option: `label` is the full option, starting with the animated `text`. */
type RadiusOption = { label: string; text: string };

/**
 * Swaps the line `ExtensionSelectorComponent` draws for the selected Radius option with the animated one. When the
 * selector's row style changes or the label wraps, the line no longer matches and the option renders normally.
 */
class RadiusLoginMenuComponent extends ExtensionSelectorComponent {
	private readonly radiusOption: RadiusOption;
	private readonly animationStart = performance.now();
	private readonly stopAnimationTimer: () => void;
	private animating = false;

	constructor(
		tui: TUI,
		title: string,
		options: string[],
		radiusOption: RadiusOption,
		onSelect: (option: string) => void,
		onCancel: () => void,
	) {
		super(
			title,
			options,
			(option) => {
				this.stopAnimation();
				onSelect(option);
			},
			() => {
				this.stopAnimation();
				onCancel();
			},
		);
		this.radiusOption = radiusOption;
		this.stopAnimationTimer = startBrandAnimation(tui, () => this.animating);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		const { label, text } = this.radiusOption;
		const selectedLine = new Text(theme.fg("accent", "→ ") + theme.fg("accent", label), 1, 0).render(width)[0];
		const index = selectedLine === undefined ? -1 : lines.indexOf(selectedLine);
		this.animating = index >= 0;
		if (this.animating) {
			const shimmer = radiusShimmer(text, performance.now() - this.animationStart);
			const animatedLine = theme.fg("accent", "→ ") + shimmer + label.slice(text.length);
			lines[index] = new Text(animatedLine, 1, 0).render(width)[0] ?? "";
		}
		return lines;
	}

	private stopAnimation(): void {
		this.stopAnimationTimer();
		this.animating = false;
	}

	override dispose(): void {
		this.stopAnimation();
		super.dispose();
	}
}

/** Top-level `/login` selector whose Radius option shimmers in the Radius logo colors while it is selected. */
export function createLoginMenuSelector(
	tui: TUI,
	title: string,
	options: string[],
	radiusOption: RadiusOption,
	onSelect: (option: string) => void,
	onCancel: () => void,
): ExtensionSelectorComponent {
	return new RadiusLoginMenuComponent(tui, title, options, radiusOption, onSelect, onCancel);
}
