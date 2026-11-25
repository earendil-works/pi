import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../../config.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";
import { piLogoLines, piWordmark, supportsPiLogo } from "./pi-logo.ts";

export interface FirstTimeSetupResult {
	shareAnalytics: boolean;
}

export interface FirstTimeSetupOptions {
	onSubmit: (result: FirstTimeSetupResult) => void;
	onCancel: () => void;
}

/** The question the dialog asks. */
export const FIRST_TIME_SETUP_QUESTION = "Opt-in to anonymous usage data sharing?";

const ANALYTICS_OPTIONS: Array<{ value: boolean; label: string }> = [
	{ value: true, label: "Share anonymous usage data" },
	{ value: false, label: "Don't share" },
];

/** First-time setup dialog: analytics opt-in. */
export class FirstTimeSetupComponent extends Container {
	private analyticsIndex = 0;
	private readonly options: FirstTimeSetupOptions;

	constructor(options: FirstTimeSetupOptions) {
		super();
		this.options = options;
		this.update();
	}

	/** Rebuild on theme changes, e.g. when the system theme receives the terminal's colors. */
	override invalidate(): void {
		this.update();
		super.invalidate();
	}

	private update(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		const logo = supportsPiLogo() ? piLogoLines().join("\n") : piWordmark();
		this.addChild(new Text(logo, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("accent", theme.bold(`Welcome to ${APP_NAME}, the minimal coding agent.`)), 1, 0),
		);
		this.addChild(new Spacer(1));

		this.addChild(new Text(theme.fg("text", FIRST_TIME_SETUP_QUESTION), 1, 0));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"Opting in stores a tracking identifier in settings.json and enables anonymous\nusage analytics. This helps us to better debug, reproduce, and resolve issues\nand bugs within Pi. You can observe what is shared using /privacy and make\nchanges anytime in settings.json.",
				),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addOptionList(
			ANALYTICS_OPTIONS.map((option) => option.label),
			this.analyticsIndex,
		);

		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "finish") +
					"  " +
					keyHint("tui.select.cancel", "skip setup"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private addOptionList(labels: string[], selectedIndex: number): void {
		for (let i = 0; i < labels.length; i++) {
			const isSelected = i === selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const label = isSelected ? theme.fg("accent", labels[i]) : theme.fg("text", labels[i]);
			this.addChild(new Text(`${prefix}${label}`, 1, 0));
		}
	}

	private moveSelection(delta: number): void {
		this.analyticsIndex = Math.max(0, Math.min(ANALYTICS_OPTIONS.length - 1, this.analyticsIndex + delta));
		this.update();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.moveSelection(-1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.moveSelection(1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.options.onSubmit({
				shareAnalytics: ANALYTICS_OPTIONS[this.analyticsIndex].value,
			});
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.options.onCancel();
		}
	}
}
