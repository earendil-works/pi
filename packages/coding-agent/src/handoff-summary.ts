export const HANDOFF_SUMMARY_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export interface HandoffSummaryUserTextInput {
	goal: string;
	conversation: string;
	readFiles: string[];
	modifiedFiles: string[];
}

export function buildHandoffSummaryUserText(input: HandoffSummaryUserTextInput): string {
	const readFilesText = input.readFiles.length > 0 ? input.readFiles.join("\n") : "";
	const modifiedFilesText = input.modifiedFiles.length > 0 ? input.modifiedFiles.join("\n") : "";

	return [
		"<goal>",
		input.goal.trim(),
		"</goal>",
		"",
		"<conversation>",
		input.conversation.trim(),
		"</conversation>",
		"",
		"<read-files>",
		readFilesText,
		"</read-files>",
		"",
		"<modified-files>",
		modifiedFilesText,
		"</modified-files>",
	].join("\n");
}

export interface HandoffFileTrackingTagsInput {
	readFiles: string[];
	modifiedFiles: string[];
}

export function formatHandoffFileTrackingTags(input: HandoffFileTrackingTagsInput): string {
	const readFilesText = input.readFiles.length > 0 ? input.readFiles.join("\n") : "";
	const modifiedFilesText = input.modifiedFiles.length > 0 ? input.modifiedFiles.join("\n") : "";

	return [
		"<read-files>",
		readFilesText,
		"</read-files>",
		"",
		"<modified-files>",
		modifiedFilesText,
		"</modified-files>",
	].join("\n");
}

const REQUIRED_HEADINGS = [
	"## Goal",
	"## Constraints & Preferences",
	"## Progress",
	"### Done",
	"### In Progress",
	"### Blocked",
	"## Key Decisions",
	"## Next Steps",
	"## Critical Context",
] as const;

function stripOptionalSections(modelText: string): string {
	const candidates = ["\n## Guide Questions", "\n## Guide questions"];
	for (const marker of candidates) {
		const idx = modelText.indexOf(marker);
		if (idx >= 0) return modelText.slice(0, idx).trimEnd();
	}
	return modelText.trim();
}

function hasRequiredFormat(modelText: string): boolean {
	return REQUIRED_HEADINGS.every((h) => modelText.includes(h));
}

function buildFallbackSummary(goal: string, modelText: string): string {
	const body = modelText.trim();
	const criticalContextLines = body.length > 0 ? ["- Unstructured model output:", "", body] : ["- (none)"];

	return [
		"## Goal",
		goal.trim(),
		"",
		"## Constraints & Preferences",
		"- Preserve parent thread context and use `read_thread` when needed.",
		"",
		"## Progress",
		"### Done",
		"- (none)",
		"",
		"### In Progress",
		"- [ ] Recover the exact current state from the parent thread before continuing.",
		"",
		"### Blocked",
		"- Missing structured summary output; inspect the parent thread for exact status.",
		"",
		"## Key Decisions",
		"- **Preserve parent-thread continuity**: Use `read_thread` before making assumptions.",
		"",
		"## Next Steps",
		"1. Use `read_thread` on the parent session to recover missing details.",
		"2. Verify current modified/read files before making changes.",
		"",
		"## Critical Context",
		...criticalContextLines,
	].join("\n");
}

export interface HandoffDraftFromModelTextInput {
	goal: string;
	modelText: string;
	readFiles: string[];
	modifiedFiles: string[];
}

export function buildHandoffDraftFromModelText(input: HandoffDraftFromModelTextInput): string {
	const cleaned = stripOptionalSections(input.modelText);
	const summary = hasRequiredFormat(cleaned) ? cleaned.trim() : buildFallbackSummary(input.goal, cleaned);

	const tags = formatHandoffFileTrackingTags({ readFiles: input.readFiles, modifiedFiles: input.modifiedFiles });

	return [summary, "", tags].join("\n");
}
