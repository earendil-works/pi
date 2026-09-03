import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai/compat";
import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText, rawKeyHint } from "./keybinding-hints.ts";

/** Shared selector for choosing whether and how to run a one-off summarization. */
export class SummarizationSelectorComponent<TChoice extends string> extends Container {
	private selectedIndex = 0;
	private readonly listContainer = new Container();
	private readonly titleText: Text;
	private readonly summaryConfigText: Text;
	private readonly navigationHelpText: Text;
	private readonly modelHelpText: Text;
	private readonly title: string;
	private readonly choices: readonly TChoice[];
	private model: Model<string> | undefined;
	private thinkingLevel: ThinkingLevel;
	private readonly onSelect: (choice: TChoice) => void;
	private readonly onSelectModel: () => void;
	private readonly onCycleModel: (
		direction: "forward" | "backward",
	) => { model: Model<string>; thinkingLevel: ThinkingLevel } | undefined;
	private readonly onThinkingLevelChange: (level: ThinkingLevel) => void;
	private readonly onSave: (model: Model<string>, thinkingLevel: ThinkingLevel) => void;
	private readonly onCancel: () => void;

	constructor(options: {
		title: string;
		choices: readonly TChoice[];
		model: Model<string> | undefined;
		thinkingLevel: ThinkingLevel;
		onSelect: (choice: TChoice) => void;
		onSelectModel: () => void;
		onCycleModel: (
			direction: "forward" | "backward",
		) => { model: Model<string>; thinkingLevel: ThinkingLevel } | undefined;
		onThinkingLevelChange: (level: ThinkingLevel) => void;
		onSave: (model: Model<string>, thinkingLevel: ThinkingLevel) => void;
		onCancel: () => void;
	}) {
		super();
		this.title = options.title;
		this.choices = options.choices;
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel;
		this.onSelect = options.onSelect;
		this.onSelectModel = options.onSelectModel;
		this.onCycleModel = options.onCycleModel;
		this.onThinkingLevelChange = options.onThinkingLevelChange;
		this.onSave = options.onSave;
		this.onCancel = options.onCancel;

		const borderColor = (text: string) => theme.getThinkingBorderColor(this.thinkingLevel)(text);
		this.addChild(new DynamicBorder(borderColor));
		this.addChild(new Spacer(1));
		this.titleText = new Text(this.getTitle(), 1, 0);
		this.addChild(this.titleText);
		this.summaryConfigText = new Text(this.getSummaryConfigLabel(), 1, 0);
		this.addChild(this.summaryConfigText);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.navigationHelpText = new Text(this.getNavigationHelpText(), 1, 0);
		this.addChild(this.navigationHelpText);
		this.modelHelpText = new Text(this.getModelHelpText(), 1, 0);
		this.addChild(this.modelHelpText);
		this.addChild(new DynamicBorder(borderColor));
		this.updateList();
	}

	private getTitle(): string {
		return theme.fg("accent", theme.bold(this.title));
	}

	private getSummaryConfigLabel(): string {
		const modelLabel = this.model ? `${this.model.provider}/${this.model.id}` : "no-model";
		const thinkingLabel = this.thinkingLevel === "off" ? "thinking off" : this.thinkingLevel;
		return (
			theme.fg("dim", "Using: ") +
			theme.fg("text", `${modelLabel} • `) +
			theme.getThinkingBorderColor(this.thinkingLevel)(thinkingLabel)
		);
	}

	private getNavigationHelpText(): string {
		return (
			rawKeyHint("↑↓", "navigate") +
			"  " +
			keyHint("tui.select.confirm", "select") +
			"  " +
			keyHint("tui.select.cancel", "cancel")
		);
	}

	private getModelHelpText(): string {
		return (
			keyHint("app.model.select", "model") +
			"  " +
			rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "cycle") +
			"  " +
			keyHint("app.thinking.cycle", "thinking") +
			"  " +
			keyHint("app.models.save", "save to settings")
		);
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.choices.length; i++) {
			const choice = this.choices[i]!;
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

	private cycleModel(direction: "forward" | "backward"): void {
		const next = this.onCycleModel(direction);
		if (!next) return;
		this.model = next.model;
		this.thinkingLevel = next.thinkingLevel;
		this.summaryConfigText.setText(this.getSummaryConfigLabel());
	}

	override invalidate(): void {
		super.invalidate();
		this.titleText.setText(this.getTitle());
		this.summaryConfigText.setText(this.getSummaryConfigLabel());
		this.navigationHelpText.setText(this.getNavigationHelpText());
		this.modelHelpText.setText(this.getModelHelpText());
		this.updateList();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.model.select")) {
			this.onSelectModel();
		} else if (kb.matches(keyData, "app.model.cycleForward")) {
			this.cycleModel("forward");
		} else if (kb.matches(keyData, "app.model.cycleBackward")) {
			this.cycleModel("backward");
		} else if (kb.matches(keyData, "app.thinking.cycle")) {
			this.cycleThinkingLevel();
		} else if (kb.matches(keyData, "app.models.save")) {
			if (this.model) this.onSave(this.model, this.thinkingLevel);
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.choices.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.onSelect(this.choices[this.selectedIndex]!);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		}
	}
}
