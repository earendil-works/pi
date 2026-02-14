import type { Message } from "@kennyfrc/mu-ai";
import type { IndexedMessage } from "./read-thread-derivation-transcript.js";

const DEFAULT_ALWAYS_INCLUDE_LAST_N = 60;
const DEFAULT_HIT_WINDOW_RADIUS = 8;

const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"from",
	"that",
	"this",
	"these",
	"those",
	"what",
	"when",
	"where",
	"why",
	"how",
	"are",
	"was",
	"were",
	"please",
	"need",
	"thread",
	"messages",
	"message",
	"extract",
	"find",
	"show",
	"tell",
]);

function tokenizeGoal(goal: string): string[] {
	const tokens =
		goal
			.toLowerCase()
			.match(/[a-z0-9_/-]{2,}/g)
			?.filter((t) => {
				if (STOP_WORDS.has(t)) return false;
				if (t.length >= 3) return true;
				// Allow short identifier-like tokens (e.g. "ts", "m2", "id") when they contain digits or separators.
				return /[0-9]|[_/-]/.test(t);
			}) ?? [];

	return Array.from(new Set(tokens)).slice(0, 25);
}

function messageToSearchText(message: Message): string {
	if (message.role === "user") {
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join(" ");
	}

	if (message.role === "assistant") {
		const parts: string[] = [];
		for (const c of message.content) {
			if (c.type === "text") parts.push(c.text);
			else if (c.type === "thinking") parts.push(c.thinking);
			else if (c.type === "toolCall") {
				parts.push(c.name);
				try {
					parts.push(JSON.stringify(c.arguments));
				} catch {
					// ignore non-serializable args
				}
			}
		}
		return parts.join(" ");
	}

	// toolResult
	const toolText = message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join(" ");
	return `${message.toolName} ${toolText}`;
}

function buildRanges(hits: number[], len: number, radius: number): Array<{ start: number; end: number }> {
	const raw = hits.map((hit) => ({
		start: Math.max(0, hit - radius),
		end: Math.min(len - 1, hit + radius),
	}));

	raw.sort((a, b) => a.start - b.start);

	const merged: Array<{ start: number; end: number }> = [];
	for (const range of raw) {
		const last = merged[merged.length - 1];
		if (!last || range.start > last.end + 1) {
			merged.push({ ...range });
			continue;
		}
		last.end = Math.max(last.end, range.end);
	}
	return merged;
}

export function selectReadThreadChunks(input: {
	messages: IndexedMessage[];
	goal: string;
	maxSelectedMessages: number;
	alwaysIncludeLastN?: number;
	hitWindowRadius?: number;
}): { selected: IndexedMessage[]; keywords: string[] } {
	const alwaysIncludeLastN = input.alwaysIncludeLastN ?? DEFAULT_ALWAYS_INCLUDE_LAST_N;
	const hitWindowRadius = input.hitWindowRadius ?? DEFAULT_HIT_WINDOW_RADIUS;

	const len = input.messages.length;
	if (len === 0) return { selected: [], keywords: [] };

	const keywords = tokenizeGoal(input.goal);

	// Mandatory tail context.
	// If we fail to find any hits, keep a bigger recent window (still bounded).
	let mandatoryTailSize = alwaysIncludeLastN;
	const mandatory = new Set<number>();

	// Find hits (relative indices)
	const hits: number[] = [];
	if (keywords.length > 0) {
		for (let i = 0; i < len; i++) {
			const haystack = messageToSearchText(input.messages[i].message).toLowerCase();
			if (keywords.some((k) => haystack.includes(k))) hits.push(i);
		}
	}

	if (hits.length === 0) {
		mandatoryTailSize = Math.min(len, Math.min(input.maxSelectedMessages, Math.max(alwaysIncludeLastN, 200)));
	}

	const tailStart = Math.max(0, len - mandatoryTailSize);
	for (let i = tailStart; i < len; i++) mandatory.add(i);

	const ranges = buildRanges(hits, len, hitWindowRadius);

	// Build selection with a recent bias:
	// 1) start with mandatory tail indices
	// 2) add hit ranges from the end backwards until we hit the budget
	const chosen = new Set<number>(mandatory);

	if (chosen.size < input.maxSelectedMessages) {
		for (let r = ranges.length - 1; r >= 0; r--) {
			const range = ranges[r];
			for (let i = range.end; i >= range.start; i--) {
				if (chosen.size >= input.maxSelectedMessages) break;
				chosen.add(i);
			}
			if (chosen.size >= input.maxSelectedMessages) break;
		}
	}

	const indices = Array.from(chosen).sort((a, b) => a - b);

	// If even the mandatory tail exceeds the budget, keep only the last N.
	const capped = indices.slice(Math.max(0, indices.length - input.maxSelectedMessages));

	const selected = capped.map((i) => input.messages[i]);
	return { selected, keywords };
}
