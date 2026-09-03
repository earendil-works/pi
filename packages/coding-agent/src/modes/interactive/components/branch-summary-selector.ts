import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { SummarizationSelectorComponent } from "./summarization-selector.ts";

export type BranchSummaryChoice = "No summary" | "Summarize" | "Summarize with custom prompt";

const SUMMARY_CHOICES: BranchSummaryChoice[] = ["No summary", "Summarize", "Summarize with custom prompt"];

/** Selector for choosing whether and how to summarize the branch being left. */
export class BranchSummarySelectorComponent extends SummarizationSelectorComponent<BranchSummaryChoice> {
	constructor(
		model: Model<string> | undefined,
		thinkingLevel: ThinkingLevel,
		onSelect: (choice: BranchSummaryChoice) => void,
		onSelectModel: () => void,
		onCycleModel: (
			direction: "forward" | "backward",
		) => { model: Model<string>; thinkingLevel: ThinkingLevel } | undefined,
		onThinkingLevelChange: (level: ThinkingLevel) => void,
		onSave: (model: Model<string>, thinkingLevel: ThinkingLevel) => void,
		onCancel: () => void,
	) {
		super({
			title: "Summarize branch?",
			choices: SUMMARY_CHOICES,
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
