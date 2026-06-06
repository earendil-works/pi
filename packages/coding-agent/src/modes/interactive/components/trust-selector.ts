import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import type { ProjectTrustDecision } from "../../../core/trust-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

interface TrustOption {
	label: string;
	trusted: boolean;
}

export interface TrustSelectorOptions {
	cwd: string;
	savedDecision: ProjectTrustDecision;
	projectTrusted: boolean;
	onSelect: (trusted: boolean) => void;
	onCancel: () => void;
}

const TRUST_OPTIONS: TrustOption[] = [
	{ label: "Trust", trusted: true },
	{ label: "Do not trust", trusted: false },
];

function formatDecision(decision: ProjectTrustDecision): string {
	if (decision === true) {
		return "trusted";
	}
	if (decision === false) {
		return "untrusted";
	}
	return "none";
}

export class TrustSelectorComponent extends Container {
	private selectedIndex: number;
	private readonly listContainer: Container;
	private readonly savedDecision: ProjectTrustDecision;
	private readonly onSelectCallback: (trusted: boolean) => void;
	private readonly onCancelCallback: () => void;

	constructor(options: TrustSelectorOptions) {
		super();

		this.savedDecision = options.savedDecision;
		this.selectedIndex = Math.max(
			0,
			TRUST_OPTIONS.findIndex((option) => option.trusted === options.savedDecision),
		);
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Project trust")), 1, 0));
		this.addChild(new Text(theme.fg("muted", options.cwd), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", `Saved decision: ${formatDecision(options.savedDecision)}`), 1, 0));
		this.addChild(
			new Text(theme.fg("muted", `Current session: ${options.projectTrusted ? "trusted" : "untrusted"}`), 1, 0),
		);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "save") +
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
		for (let i = 0; i < TRUST_OPTIONS.length; i++) {
			const option = TRUST_OPTIONS[i];
			if (!option) {
				continue;
			}

			const isSelected = i === this.selectedIndex;
			const isCurrent = option.trusted === this.savedDecision;
			const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const label = isSelected ? theme.fg("accent", option.label) : theme.fg("text", option.label);
			this.listContainer.addChild(new Text(`${prefix}${label}${checkmark}`, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(TRUST_OPTIONS.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = TRUST_OPTIONS[this.selectedIndex];
			if (selected) {
				this.onSelectCallback(selected.trusted);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}
}
