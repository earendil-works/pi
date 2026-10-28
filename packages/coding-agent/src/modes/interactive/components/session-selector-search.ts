import { fuzzyMatch } from "@earendil-works/pi-tui";
import type { SessionInfo } from "../../../core/session-manager.ts";

export type SortMode = "threaded" | "recent" | "relevance";

export type NameFilter = "all" | "named";

export interface ParsedSearchQuery {
	mode: "tokens" | "regex";
	tokens: { kind: "fuzzy" | "phrase"; value: string }[];
	regex: RegExp | null;
	/** If set, parsing failed and we should treat query as non-matching. */
	error?: string;
}

export interface MatchResult {
	matches: boolean;
	/** Lower is better; only meaningful when matches === true */
	score: number;
}

function normalizeWhitespaceLower(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Match tiers, best first. Each token is scored by the best field it matches; tiers dominate
 * fuzzy scores so an exact hit anywhere beats a scattered subsequence in a short field.
 */
const TIER_NAME = 0; // query text appears in the session name
const TIER_TEXT = 1; // query text appears in the session id, messages, or cwd
const TIER_FUZZY = 2; // query characters appear scattered in the session name or cwd
const TIER_WEIGHT = 1_000_000;

interface LowercaseCache {
	source: string;
	lower: string;
	normalized?: string;
}

/**
 * Lowercased message text per session. allMessagesText holds every user/assistant message and
 * can be megabytes, so lowercase it once instead of on every keystroke.
 */
const messageTextCache = new WeakMap<SessionInfo, LowercaseCache>();

function getMessageText(session: SessionInfo): LowercaseCache {
	let cached = messageTextCache.get(session);
	if (!cached || cached.source !== session.allMessagesText) {
		cached = { source: session.allMessagesText, lower: session.allMessagesText.toLowerCase() };
		messageTextCache.set(session, cached);
	}
	return cached;
}

function getNormalizedMessageText(session: SessionInfo): string {
	const cached = getMessageText(session);
	cached.normalized ??= cached.lower.replace(/\s+/g, " ").trim();
	return cached.normalized;
}

function tierScore(tier: number, score = 0): number {
	return tier * TIER_WEIGHT + score;
}

/** Exact (case-insensitive) text match. Messages and ids are only matched exactly: scattered matches in them are noise. */
function matchLiteralToken(session: SessionInfo, value: string): number | undefined {
	const name = session.name?.toLowerCase() ?? "";
	if (name.includes(value)) return tierScore(TIER_NAME, fuzzyMatch(value, name).score);
	if (session.id.toLowerCase().includes(value)) return tierScore(TIER_TEXT);
	if (getMessageText(session).lower.includes(value)) return tierScore(TIER_TEXT);
	if (session.cwd.toLowerCase().includes(value)) return tierScore(TIER_TEXT);
	return undefined;
}

function matchFuzzyToken(session: SessionInfo, value: string): number | undefined {
	const literal = matchLiteralToken(session, value.toLowerCase());
	if (literal !== undefined) return literal;

	let best: number | undefined;
	for (const field of [session.name ?? "", session.cwd]) {
		const m = fuzzyMatch(value, field);
		if (m.matches && (best === undefined || m.score < best)) best = m.score;
	}
	return best === undefined ? undefined : tierScore(TIER_FUZZY, best);
}

function matchPhraseToken(session: SessionInfo, phrase: string): number | undefined {
	const name = normalizeWhitespaceLower(session.name ?? "");
	if (name.includes(phrase)) return tierScore(TIER_NAME, fuzzyMatch(phrase, name).score);
	if (session.id.toLowerCase().includes(phrase)) return tierScore(TIER_TEXT);
	if (getNormalizedMessageText(session).includes(phrase)) return tierScore(TIER_TEXT);
	if (normalizeWhitespaceLower(session.cwd).includes(phrase)) return tierScore(TIER_TEXT);
	return undefined;
}

function matchRegex(session: SessionInfo, regex: RegExp): number | undefined {
	if (session.name && regex.test(session.name)) return tierScore(TIER_NAME);
	if (regex.test(session.id) || regex.test(session.allMessagesText) || regex.test(session.cwd)) {
		return tierScore(TIER_TEXT);
	}
	return undefined;
}

export function hasSessionName(session: SessionInfo): boolean {
	return Boolean(session.name?.trim());
}

function matchesNameFilter(session: SessionInfo, filter: NameFilter): boolean {
	if (filter === "all") return true;
	return hasSessionName(session);
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) {
		return { mode: "tokens", tokens: [], regex: null };
	}

	// Regex mode: re:<pattern>
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) {
			return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		}
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { mode: "regex", tokens: [], regex: null, error: msg };
		}
	}

	// Token mode with quote support.
	// Example: foo "node cve" bar
	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	let buf = "";
	let inQuote = false;
	let hadUnclosedQuote = false;

	const flush = (kind: "fuzzy" | "phrase"): void => {
		const v = buf.trim();
		buf = "";
		if (!v) return;
		tokens.push({ kind, value: v });
	};

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (ch === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
			continue;
		}

		if (!inQuote && /\s/.test(ch)) {
			flush("fuzzy");
			continue;
		}

		buf += ch;
	}

	if (inQuote) {
		hadUnclosedQuote = true;
	}

	// If quotes were unbalanced, fall back to plain whitespace tokenization.
	if (hadUnclosedQuote) {
		return {
			mode: "tokens",
			tokens: trimmed
				.split(/\s+/)
				.map((t) => t.trim())
				.filter((t) => t.length > 0)
				.map((t) => ({ kind: "fuzzy" as const, value: t })),
			regex: null,
		};
	}

	flush(inQuote ? "phrase" : "fuzzy");

	return { mode: "tokens", tokens, regex: null };
}

/**
 * Each field is matched separately, so a token never matches across field boundaries.
 * Different tokens may match different fields.
 */
export function matchSession(session: SessionInfo, parsed: ParsedSearchQuery): MatchResult {
	if (parsed.mode === "regex") {
		if (!parsed.regex) {
			return { matches: false, score: 0 };
		}
		const score = matchRegex(session, parsed.regex);
		return score === undefined ? { matches: false, score: 0 } : { matches: true, score };
	}

	let totalScore = 0;

	for (const token of parsed.tokens) {
		let score: number | undefined;
		if (token.kind === "phrase") {
			const phrase = normalizeWhitespaceLower(token.value);
			if (!phrase) continue;
			score = matchPhraseToken(session, phrase);
		} else {
			score = matchFuzzyToken(session, token.value);
		}
		if (score === undefined) return { matches: false, score: 0 };
		totalScore += score;
	}

	return { matches: true, score: totalScore };
}

export function filterAndSortSessions(
	sessions: SessionInfo[],
	query: string,
	sortMode: SortMode,
	nameFilter: NameFilter = "all",
): SessionInfo[] {
	const nameFiltered =
		nameFilter === "all" ? sessions : sessions.filter((session) => matchesNameFilter(session, nameFilter));
	const trimmed = query.trim();
	if (!trimmed) return nameFiltered;

	const parsed = parseSearchQuery(query);
	if (parsed.error) return [];

	// Recent mode: filter only, keep incoming order.
	if (sortMode === "recent") {
		const filtered: SessionInfo[] = [];
		for (const s of nameFiltered) {
			const res = matchSession(s, parsed);
			if (res.matches) filtered.push(s);
		}
		return filtered;
	}

	// Relevance mode: sort by score, tie-break by modified desc.
	const scored: { session: SessionInfo; score: number }[] = [];
	for (const s of nameFiltered) {
		const res = matchSession(s, parsed);
		if (!res.matches) continue;
		scored.push({ session: s, score: res.score });
	}

	scored.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		return b.session.modified.getTime() - a.session.modified.getTime();
	});

	return scored.map((r) => r.session);
}
