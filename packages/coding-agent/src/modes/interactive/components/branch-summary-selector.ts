import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai/compat";
import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText, rawKeyHint } from "./keybinding-hints.ts";

export type BranchSummaryChoice = "No summary" | "Summarize" | "Summarize with custom prompt";

const SUMMARY_CHOICES: BranchSummaryChoice[] = ["No summary", "Summarize", "Summarize with custom prompt"];

/** Selector for choosing whether and how to summarize the branch being left. */
export class BranchSummarySelectorComponent extends Container {
	private selectedIndex = 0;
	private readonly listContainer = new Container();
	private readonly titleText: Text;
	private readonly summaryConfigText: Text;
	private readonly helpText: Text;
	private readonly model: Model<string> | undefined;
	private thinkingLevel: ThinkingLevel;
	private readonly onSelect: (choice: BranchSummaryChoice) => void;
	private readonly onSelectModel: () => void;
	private readonly onCycleModel: (direction: "forward" | "backward") => void;
	private readonly onThinkingLevelChange: (level: ThinkingLevel) => void;
	private readonly onCancel: () => void;

	constructor(
		model: Model<string> | undefined,
		thinkingLevel: ThinkingLevel,
		onSelect: (choice: BranchSummaryChoice) => void,
		onSelectModel: () => void,
		onCycleModel: (direction: "forward" | "backward") => void,
		onThinkingLevelChange: (level: ThinkingLevel) => void,
		onCancel: () => void,
	) {
		super();
		this.model = model;
		this.thinkingLevel = thinkingLevel;
		this.onSelect = onSelect;
		this.onSelectModel = onSelectModel;
		this.onCycleModel = onCycleModel;
		this.onThinkingLevelChange = onThinkingLevelChange;
		this.onCancel = onCancel;

		const borderColor = (text: string) => theme.getThinkingBorderColor(this.thinkingLevel)(text);
		this.addChild(new DynamicBorder(borderColor));
		this.addChild(new Spacer(1));
		this.titleText = new Text(this.getTitle(), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.helpText = new Text(this.getHelpText(), 1, 0);
		this.addChild(this.helpText);
		this.summaryConfigText = new Text(this.getSummaryConfigLabel(), 1, 0);
		this.addChild(this.summaryConfigText);
		this.addChild(new DynamicBorder(borderColor));
		this.updateList();
	}

	private getTitle(): string {
		return theme.fg("accent", theme.bold("Summarize branch?"));
	}

	private getSummaryConfigLabel(): string {
		const modelLabel = this.model ? `(${this.model.provider}) ${this.model.id}` : "no-model";
		const thinkingLabel = this.thinkingLevel === "off" ? "thinking off" : this.thinkingLevel;
		return (
			theme.fg("dim", "summarize with: ") +
			theme.fg("muted", `${modelLabel} • `) +
			theme.getThinkingBorderColor(this.thinkingLevel)(thinkingLabel)
		);
	}

	private getHelpText(): string {
		return (
			rawKeyHint("↑↓", "navigate") +
			"  " +
			keyHint("tui.select.confirm", "select") +
			"  " +
			keyHint("app.model.select", "model") +
			"  " +
			rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "cycle") +
			"  " +
			keyHint("app.thinking.cycle", "thinking") +
			"  " +
			keyHint("tui.select.cancel", "cancel")
		);
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < SUMMARY_CHOICES.length; i++) {
			const choice = SUMMARY_CHOICES[i];
			const text =
				i === this.selectedIndex
					? theme.fg("accent", "→ ") + theme.fg("accent", choice)
					: `  ${theme.fg("text", choice)}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
	}

	private cycleThinkingLevel(): void {
		if (!this.model) return;
		const levels = getSupportedThinkingLevels(this.model) as ThinkingLevel[];
		if (levels.length === 0) return;
		const currentIndex = levels.indexOf(this.thinkingLevel);
		this.thinkingLevel = levels[(currentIndex + 1) % levels.length]!;
		this.summaryConfigText.setText(this.getSummaryConfigLabel());
		this.onThinkingLevelChange(this.thinkingLevel);
	}

	override invalidate(): void {
		super.invalidate();
		this.titleText.setText(this.getTitle());
		this.summaryConfigText.setText(this.getSummaryConfigLabel());
		this.helpText.setText(this.getHelpText());
		this.updateList();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.model.select")) {
			this.onSelectModel();
		} else if (kb.matches(keyData, "app.model.cycleForward")) {
			this.onCycleModel("forward");
		} else if (kb.matches(keyData, "app.model.cycleBackward")) {
			this.onCycleModel("backward");
		} else if (kb.matches(keyData, "app.thinking.cycle")) {
			this.cycleThinkingLevel();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(SUMMARY_CHOICES.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.onSelect(SUMMARY_CHOICES[this.selectedIndex]!);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		}
	}
}
