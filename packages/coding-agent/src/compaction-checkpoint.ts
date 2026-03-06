import { formatParentThreadReference } from "./tools/handoff.js";

const COMPACTION_ACTIVE_CONTEXT_LINE = "Use this compacted checkpoint as the active context for continuing the task.";
const HANDOFF_ACTIVE_CONTEXT_LINE =
	"You have been handed context from a previous session. The files above contain the relevant code. Begin working on the goal.";

export function buildCompactionCheckpointText(args: {
	formattedMessage: string;
	parentThreadId: string | null;
}): string {
	const summary = args.formattedMessage
		.replace(/^# Handoff:/m, "# Compact checkpoint:")
		.replace(HANDOFF_ACTIVE_CONTEXT_LINE, COMPACTION_ACTIVE_CONTEXT_LINE);

	const withContinuationInstruction = summary.includes(COMPACTION_ACTIVE_CONTEXT_LINE)
		? summary
		: `${summary}\n\n${COMPACTION_ACTIVE_CONTEXT_LINE}`;

	if (!args.parentThreadId || withContinuationInstruction.includes("**Parent Thread:**")) {
		return withContinuationInstruction;
	}

	return `${formatParentThreadReference(args.parentThreadId)}${withContinuationInstruction}`;
}

export function buildCompactionContinuationPrompt(args: {
	goal: string;
	parentThreadId: string | null;
	keyFiles?: string[];
}): string {
	const lines = [
		"Continue the task from the compacted checkpoint.",
		`Goal: ${args.goal.trim()}`,
		"Use the checkpoint summary's Done / In Progress / Next Steps sections to decide the next concrete action.",
	];

	if (args.keyFiles && args.keyFiles.length > 0) {
		lines.push("Key files:");
		for (const file of args.keyFiles) {
			lines.push(`- ${file}`);
		}
	}

	if (args.parentThreadId) {
		lines.push(`Parent thread ID: ${args.parentThreadId}`);
		lines.push("Use `read_thread` if you need more detail from the parent thread.");
	}

	return lines.join("\n");
}
