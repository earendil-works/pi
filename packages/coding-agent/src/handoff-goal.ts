import { basename } from "node:path";
import type { Message } from "@kennyfrc/mu-ai";

export const GENERIC_HANDOFF_GOAL = "Continue the current task";

function cleanupGoalText(goal: string): string {
	let cleaned = goal.trim();
	if (!cleaned) return "";

	// Prefer first line only.
	const firstLine = cleaned.split(/\r?\n/)[0];
	cleaned = firstLine.trim();

	// Strip wrapping quotes.
	if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
		cleaned = cleaned.slice(1, -1).trim();
	}

	// Strip trailing punctuation.
	cleaned = cleaned.replace(/[\s.!?]+$/g, "").trim();

	return cleaned;
}

function isGenericGoal(goal: string): boolean {
	const cleaned = cleanupGoalText(goal);
	if (!cleaned) return true;
	const normalized = cleaned.toLowerCase();
	return normalized === GENERIC_HANDOFF_GOAL.toLowerCase();
}

function stripUserMessageTimePrefix(text: string): string {
	return text.replace(/^(?:<user_message_time>[\s\S]*?<\/user_message_time>(?:\n\n|\n)?)+/, "");
}

function extractLastUserText(messages: Message[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "user") continue;

		const content = msg.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((c) => c.type === "text")
						.map((c) => c.text)
						.join("");

		const cleaned = stripUserMessageTimePrefix(text).trim();
		if (cleaned) return cleaned;
	}

	return null;
}

function truncateWords(text: string, maxWords: number): string {
	const words = text.split(/\s+/).filter((w) => w.length > 0);
	if (words.length <= maxWords) return text;
	return words.slice(0, maxWords).join(" ");
}

function looksLikeImperativeGoal(text: string): boolean {
	const firstWord = text.split(/\s+/)[0]?.toLowerCase() ?? "";
	const normalized = firstWord.replace(/[^a-z]/g, "");
	if (!normalized) return false;

	const verbs = new Set<string>([
		"add",
		"address",
		"audit",
		"build",
		"create",
		"debug",
		"document",
		"ensure",
		"fix",
		"implement",
		"investigate",
		"make",
		"prevent",
		"refactor",
		"remove",
		"resolve",
		"test",
		"update",
	]);

	return verbs.has(normalized);
}

function deriveGoalFromMessages(messages: Message[]): string {
	const lastUserText = extractLastUserText(messages);
	if (!lastUserText) return "Address the next step based on the conversation";

	// Prefer the first non-empty line.
	const firstLine = lastUserText
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find((l) => l.length > 0);

	const line = firstLine ?? lastUserText;
	const compact = line.replace(/\s+/g, " ").trim();
	const truncated = truncateWords(compact, 12);

	if (looksLikeImperativeGoal(truncated)) {
		return truncated;
	}

	return truncateWords(`Address ${truncated}`, 12);
}

const SLICE_SUFFIX_PATTERN = /^(.+?):(\d+)(?:-(\d*))?$/;

function stripSliceSuffix(input: string): string {
	const match = input.match(SLICE_SUFFIX_PATTERN);
	if (!match) return input;
	return match[1] ?? input;
}

export function normalizeAutoHandoffGoal(params: { modelGoal: string; messages: Message[] }): string {
	const cleaned = cleanupGoalText(params.modelGoal);
	if (!isGenericGoal(cleaned)) return cleaned;

	const fallback = deriveGoalFromMessages(params.messages);
	return isGenericGoal(fallback) ? "Address the next step based on the conversation" : fallback;
}

export function normalizeHandoffGoalFromFiles(params: { goal: string; files: string[] }): string {
	const cleaned = cleanupGoalText(params.goal);
	if (!isGenericGoal(cleaned)) return cleaned;

	const first = params.files[0];
	const filePath = first ? stripSliceSuffix(first) : "";
	const fileName = filePath ? basename(filePath) : "files";
	return `Continue work in ${fileName}`;
}
