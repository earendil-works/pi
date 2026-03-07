import { formatParentThreadReference } from "./tools/handoff.js";

const COMPACTION_ACTIVE_CONTEXT_LINE = "Use this compacted checkpoint as the active context for continuing the task.";
const HANDOFF_ACTIVE_CONTEXT_LINE =
	"You have been handed context from a previous session. The files above contain the relevant code. Begin working on the goal.";

function buildFallbackSummary(args: { goal: string; parentThreadId: string | null; keyFiles?: string[] }): string {
	const criticalContextLines = [
		"- Native compacted history was preserved and should be reused for the next turn.",
		...(args.keyFiles && args.keyFiles.length > 0
			? args.keyFiles.map((file) => `- Key file: ${file}`)
			: ["- Key files were not provided in this compaction result."]),
	];

	return [
		"## Goal",
		args.goal.trim(),
		"",
		"## Constraints & Preferences",
		"- Preserve parent thread context and use `read_thread` when needed.",
		"- Reuse the native compacted window as-is for the next model turn when available.",
		"",
		"## Progress",
		"### Done",
		"- Native compaction completed and replacement history was stored for reuse.",
		"- A structured Mu checkpoint was appended so continuation remains readable across models.",
		"",
		"### In Progress",
		"- [ ] Review the compacted checkpoint and continue from the next concrete action.",
		"",
		"### Blocked",
		"- (none)",
		"",
		"## Key Decisions",
		"- Combine native compacted history with a structured Mu summary so compaction remains useful for any model.",
		"",
		"## Next Steps",
		"1. Use the compacted history as the active context for the next turn.",
		args.parentThreadId
			? "2. Use `read_thread` if you need more detail from the parent thread."
			: "2. Continue from the compacted checkpoint and inspect the most relevant files if needed.",
		"",
		"## Critical Context",
		...criticalContextLines,
	].join("\n");
}

export function buildCompactionCheckpointText(args: {
	formattedMessage: string;
	goal: string;
	parentThreadId: string | null;
	keyFiles?: string[];
}): string {
	const summary = (
		args.formattedMessage.trim().length > 0
			? args.formattedMessage
			: buildFallbackSummary({
					goal: args.goal,
					parentThreadId: args.parentThreadId,
					keyFiles: args.keyFiles,
				})
	)
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
	formattedMessage: string;
	goal: string;
	parentThreadId: string | null;
	keyFiles?: string[];
}): string {
	const checkpointSummary = buildCompactionCheckpointText({
		formattedMessage: args.formattedMessage,
		goal: args.goal,
		parentThreadId: args.parentThreadId,
		keyFiles: args.keyFiles,
	});

	const lines = [
		"Continue the task from the compacted checkpoint.",
		`Goal: ${args.goal.trim()}`,
		"Use the checkpoint summary's Done / In Progress / Next Steps sections to decide the next concrete action.",
		"",
		"Checkpoint summary:",
		checkpointSummary,
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
