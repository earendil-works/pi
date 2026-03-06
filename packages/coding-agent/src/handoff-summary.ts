export const HANDOFF_SUMMARY_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.

Output EXACTLY these sections in this order:

## Goal
<one short paragraph>

## Constraints & Preferences
- <bullet list of concrete constraints/preferences from the conversation>

## Progress
### Done
- <completed work only; include verification/results that already happened>

### In Progress
- <work that is actively underway but not finished, or - (none)>

### Blocked
- <actual blocker only, or - (none)>

## Key Decisions
- <important decision + brief why>

## Next Steps
1. <next concrete action>

## Critical Context
- <important facts, evidence, file paths, outputs, or caveats needed to continue>

Rules:
- Summarize what actually happened in the conversation; do not invent missing work.
- Put completed tests/checks/results in Done, not In Progress.
- Use Blocked only for real blockers. If nothing is blocked, write '- (none)'.
- Keep it concrete and compact.
- Preserve exact file paths, commands, versions, thread IDs, and notable outputs when they matter.`;

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

interface MarkdownSection {
	title: string;
	body: string;
}

function splitMarkdownSections(text: string): MarkdownSection[] {
	const lines = text.split("\n");
	const sections: MarkdownSection[] = [];
	let currentTitle: string | null = null;
	let currentBody: string[] = [];

	for (const line of lines) {
		const match = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
		if (match) {
			if (currentTitle) {
				sections.push({ title: currentTitle, body: currentBody.join("\n").trim() });
			}
			currentTitle = match[2].trim();
			currentBody = [];
			continue;
		}

		if (currentTitle) {
			currentBody.push(line);
		}
	}

	if (currentTitle) {
		sections.push({ title: currentTitle, body: currentBody.join("\n").trim() });
	}

	return sections;
}

function normalizeSectionTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function getSectionBody(sections: MarkdownSection[], ...aliases: string[]): string | null {
	const normalizedAliases = aliases.map((alias) => normalizeSectionTitle(alias));
	const found = sections.find((section) => normalizedAliases.includes(normalizeSectionTitle(section.title)));
	if (!found) return null;
	return found.body.trim() || null;
}

function toBulletLines(body: string | null): string[] {
	if (!body) return [];

	const lines = body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	const bullets = lines
		.map((line) => {
			if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
				return line.replace(/^\d+\.\s+/, "- ");
			}
			return `- ${line}`;
		})
		.filter((line, index, all) => all.indexOf(line) === index);

	return bullets;
}

function buildAlternativeFormatSummary(goal: string, modelText: string): string | null {
	const sections = splitMarkdownSections(modelText);
	if (sections.length === 0) return null;

	const altGoal = getSectionBody(sections, "Goal");
	const whatWasDone = getSectionBody(sections, "What was done", "What Was Done");
	const evidence = getSectionBody(sections, "Evidence");
	const outcome = getSectionBody(sections, "Outcome");
	const suggestedFollowUp = getSectionBody(sections, "Suggested follow-up", "Suggested follow-up optional");

	if (!whatWasDone && !evidence && !outcome) {
		return null;
	}

	const done = [...toBulletLines(whatWasDone), ...toBulletLines(outcome)].filter(
		(line, index, all) => all.indexOf(line) === index,
	);

	const nextSteps = toBulletLines(suggestedFollowUp);
	const inProgress = nextSteps.length > 0 ? nextSteps.map((line) => line.replace(/^-\s+/, "- [ ] ")) : ["- (none)"];
	const blocked = ["- (none)"];
	const keyDecisions = outcome
		? toBulletLines(outcome)
		: ["- Preserve the current validated state unless the user asks for deeper follow-up work."];
	const criticalContext = toBulletLines(evidence);

	return [
		"## Goal",
		(altGoal ?? goal).trim(),
		"",
		"## Constraints & Preferences",
		"- Preserve parent thread context and use `read_thread` when needed.",
		"",
		"## Progress",
		"### Done",
		...(done.length > 0 ? done : ["- (none)"]),
		"",
		"### In Progress",
		...inProgress,
		"",
		"### Blocked",
		...blocked,
		"",
		"## Key Decisions",
		...keyDecisions,
		"",
		"## Next Steps",
		...(nextSteps.length > 0
			? nextSteps.map((line, index) => `${index + 1}. ${line.replace(/^-\s+/, "")}`)
			: ["1. Continue with the next user-requested action."]),
		"",
		"## Critical Context",
		...(criticalContext.length > 0 ? criticalContext : ["- (none)"]),
	].join("\n");
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
	const summary = hasRequiredFormat(cleaned)
		? cleaned.trim()
		: (buildAlternativeFormatSummary(input.goal, cleaned) ?? buildFallbackSummary(input.goal, cleaned));

	const tags = formatHandoffFileTrackingTags({ readFiles: input.readFiles, modifiedFiles: input.modifiedFiles });

	return [summary, "", tags].join("\n");
}
