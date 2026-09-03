import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { SummarizationSelectorComponent } from "./summarization-selector.ts";

export type CompactionChoice = "Compact" | "Compact with custom prompt" | "Cancel";

const COMPACTION_CHOICES: CompactionChoice[] = ["Compact", "Compact with custom prompt", "Cancel"];

/** Selector for configuring and starting manual compaction. */
export class CompactionSelectorComponent extends SummarizationSelectorComponent<CompactionChoice> {
	constructor(
		model: Model<string> | undefined,
		thinkingLevel: ThinkingLevel,
		onSelect: (choice: CompactionChoice) => void,
		onSelectModel: () => void,
		onCycleModel: (
			direction: "forward" | "backward",
		) => { model: Model<string>; thinkingLevel: ThinkingLevel } | undefined,
		onThinkingLevelChange: (level: ThinkingLevel) => void,
		onSave: (model: Model<string>, thinkingLevel: ThinkingLevel) => void,
		onCancel: () => void,
	) {
		super({
			title: "Compact context?",
			choices: COMPACTION_CHOICES,
			model,
			thinkingLevel,
			onSelect,
			onSelectModel,
			onCycleModel,
			onThinkingLevelChange,
			onSave,
			onCancel,
		});
	}
}
