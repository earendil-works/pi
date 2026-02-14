export const HANDOFF_SUMMARY_SYSTEM_PROMPT = [
	"You are generating a handoff summary that will be pasted as the first message in a NEW coding-agent session.",
	"",
	"Rules:",
	"- Output ONLY markdown.",
	"- Use EXACTLY these headings, in this order, with no other headings:",
	"  - ## Goal",
	"  - ## What's Done",
	"  - ## What's Not Yet Done",
	"  - ## Learnings / Insights so Far",
	"  - ## Next Steps",
	"- Keep it concise, concrete, and actionable.",
	"- Prefer short bullet lists under each heading.",
	"- Do not include code fences unless absolutely necessary.",
	"",
	"You will receive a payload that includes:",
	"- <goal>...</goal>",
	"- <conversation>...</conversation>",
	"- <read-files>...</read-files>",
	"- <modified-files>...</modified-files>",
].join("\n");

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

function buildDefaultGuideQuestions(): string[] {
	return [
		"What was the last explicit user request right before handoff?",
		"What exact errors / stack traces / failing test outputs occurred most recently?",
		"Which files were modified and why (and are there any uncommitted changes)?",
		"What is the current blocker (if any), and what has already been tried?",
		"Are there any relevant decisions/constraints that must be preserved in the next session?",
	];
}

export function formatHandoffGuideQuestions(questions: string[]): string {
	const lines = questions.map((q) => `- ${q}`);
	return ["## Guide Questions (use `read_thread` if needed)", ...lines].join("\n");
}

const REQUIRED_HEADINGS = [
	"## Goal",
	"## What's Done",
	"## What's Not Yet Done",
	"## Learnings / Insights so Far",
	"## Next Steps",
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
	const learningsLines = body.length > 0 ? ["- Unstructured model output:", "", body] : ["- (none)"];

	return [
		"## Goal",
		goal.trim(),
		"",
		"## What's Done",
		"- (unknown; review the parent thread)",
		"",
		"## What's Not Yet Done",
		"- (unknown; review the parent thread)",
		"",
		"## Learnings / Insights so Far",
		...learningsLines,
		"",
		"## Next Steps",
		"- Use `read_thread` on the parent session to recover missing details and proceed.",
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
	const guide = formatHandoffGuideQuestions(buildDefaultGuideQuestions());

	return [summary, "", tags, "", guide].join("\n");
}
