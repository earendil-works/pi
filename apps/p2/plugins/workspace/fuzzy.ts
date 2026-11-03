// VS Code's Quick Open (Ctrl/Cmd+P) file matching and ranking, ported from
// src/vs/base/common/fuzzyScorer.ts and the parts of filters.ts and comparers.ts it uses
// (MIT License, Copyright (c) Microsoft Corporation). A file is scored by its name (the label)
// and, when the name alone does not match or the query contains `/`, by its whole relative path
// (description = folder). Non-contiguous matches are allowed, as in Quick Open; a quoted query
// piece must match contiguously, and space-separated pieces must all match.

export type FuzzyMatch = { start: number; end: number };
type FileScore = { score: number; labelMatch?: FuzzyMatch[]; descriptionMatch?: FuzzyMatch[] };
type QueryPiece = {
	/** The query with `\` as `/`. */
	pathNormalized: string;
	/** Without whitespace, `*`, `…`, quotes and a trailing `#`. */
	normalized: string;
	normalizedLowercase: string;
	/** Wrapped in quotes: a substring match, not fuzzy. */
	expectContiguousMatch: boolean;
};
type FileQuery = QueryPiece & { values?: QueryPiece[]; containsPathSeparator: boolean };

const NO_MATCH = 0;
const PATH_IDENTITY_SCORE = 1 << 18;
const LABEL_PREFIX_SCORE_THRESHOLD = 1 << 17;
const LABEL_SCORE_THRESHOLD = 1 << 16;
const NO_ITEM_SCORE: FileScore = { score: 0 };

function scoreFuzzy(
	target: string,
	query: string,
	queryLower: string,
	allowNonContiguous: boolean,
): [number, number[]] {
	const targetLength = target.length;
	const queryLength = query.length;
	if (!target || !query || targetLength < queryLength) return [NO_MATCH, []];
	const targetLower = target.toLowerCase();
	// Matrix of query × target: each cell keeps the best score so far and the length of the consecutive match ending there.
	const scores: number[] = [];
	const matches: number[] = [];
	for (let queryIndex = 0; queryIndex < queryLength; queryIndex++) {
		const queryIndexOffset = queryIndex * targetLength;
		const queryIndexPreviousOffset = queryIndexOffset - targetLength;
		const queryIndexGtNull = queryIndex > 0;
		const queryChar = query[queryIndex] ?? "";
		const queryLowerChar = queryLower[queryIndex] ?? "";
		for (let targetIndex = 0; targetIndex < targetLength; targetIndex++) {
			const targetIndexGtNull = targetIndex > 0;
			const currentIndex = queryIndexOffset + targetIndex;
			const leftIndex = currentIndex - 1;
			const diagIndex = queryIndexPreviousOffset + targetIndex - 1;
			const leftScore = targetIndexGtNull ? (scores[leftIndex] ?? 0) : 0;
			const diagScore = queryIndexGtNull && targetIndexGtNull ? (scores[diagIndex] ?? 0) : 0;
			const sequenceLength = queryIndexGtNull && targetIndexGtNull ? (matches[diagIndex] ?? 0) : 0;
			// After the first query character, only score where the previous one matched: the query matches in order.
			const score =
				!diagScore && queryIndexGtNull
					? 0
					: charScore(queryChar, queryLowerChar, target, targetLower, targetIndex, sequenceLength);
			if (
				score &&
				diagScore + score >= leftScore &&
				(allowNonContiguous || queryIndexGtNull || targetLower.startsWith(queryLower, targetIndex))
			) {
				matches[currentIndex] = sequenceLength + 1;
				scores[currentIndex] = diagScore + score;
			} else {
				matches[currentIndex] = NO_MATCH;
				scores[currentIndex] = leftScore;
			}
		}
	}
	// Positions, walking back from the bottom right.
	const positions: number[] = [];
	let queryIndex = queryLength - 1;
	let targetIndex = targetLength - 1;
	while (queryIndex >= 0 && targetIndex >= 0) {
		if (matches[queryIndex * targetLength + targetIndex] === NO_MATCH) targetIndex--;
		else {
			positions.push(targetIndex);
			queryIndex--;
			targetIndex--;
		}
	}
	return [scores[queryLength * targetLength - 1] ?? 0, positions.reverse()];
}

function charScore(
	queryChar: string,
	queryLowerChar: string,
	target: string,
	targetLower: string,
	targetIndex: number,
	sequenceLength: number,
): number {
	const targetLowerChar = targetLower[targetIndex];
	const equal =
		queryLowerChar === targetLowerChar ||
		((queryLowerChar === "/" || queryLowerChar === "\\") && (targetLowerChar === "/" || targetLowerChar === "\\"));
	if (!equal) return 0;
	let score = 1;
	// Consecutive matches: up to 3 get the full bonus, the rest half.
	if (sequenceLength > 0) score += Math.min(sequenceLength, 3) * 6 + Math.max(0, sequenceLength - 3) * 3;
	if (queryChar === target[targetIndex]) score += 1;
	if (targetIndex === 0) score += 8;
	else {
		const separator = separatorScore(target.charCodeAt(targetIndex - 1));
		if (separator) score += separator;
		// Camel case inside a word, unless inside a consecutive run (HTTP in HTTP gets no boost).
		else if (isUpper(target.charCodeAt(targetIndex)) && sequenceLength === 0) score += 2;
	}
	return score;
}

function isUpper(code: number): boolean {
	return code >= 65 && code <= 90;
}

function separatorScore(code: number): number {
	switch (String.fromCharCode(code)) {
		case "/":
		case "\\":
			return 5;
		case "_":
		case "-":
		case ".":
		case " ":
		case "'":
		case '"':
		case ":":
			return 4;
		default:
			return 0;
	}
}

function normalizeQuery(original: string): QueryPiece {
	const pathNormalized = original.replace(/\\/g, "/");
	const normalized = pathNormalized.replace(/[*\u2026\s"]/g, "").replace(/(?<=.)#$/, "");
	return {
		pathNormalized,
		normalized,
		normalizedLowercase: normalized.toLowerCase(),
		expectContiguousMatch: original.startsWith('"') && original.endsWith('"'),
	};
}

function prepareFileQuery(original: string): FileQuery {
	const query = normalizeQuery(original);
	const pieces = original.split(" ");
	const values = pieces.length > 1 ? pieces.map(normalizeQuery).filter((piece) => piece.normalized) : [];
	return {
		...query,
		...(values.length ? { values } : {}),
		containsPathSeparator: query.pathNormalized.includes("/"),
	};
}

function split(path: string): { label: string; description?: string } {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? { label: path } : { label: path.slice(slash + 1), description: path.slice(0, slash) };
}

/** How well a relative file path matches; a score of 0 is no match. */
function scoreFile(path: string, query: FileQuery): FileScore {
	const { label, description } = split(path);
	if (!label || !query.normalized) return NO_ITEM_SCORE;
	const preferLabelMatches = !query.containsPathSeparator;
	if (query.pathNormalized === path)
		return {
			score: PATH_IDENTITY_SCORE,
			labelMatch: [{ start: 0, end: label.length }],
			...(description ? { descriptionMatch: [{ start: 0, end: description.length }] } : {}),
		};
	if (!query.values || query.values.length < 2) return scorePiece(label, description, query, preferLabelMatches);
	let score = 0;
	const labelMatch: FuzzyMatch[] = [];
	const descriptionMatch: FuzzyMatch[] = [];
	for (const piece of query.values) {
		const result = scorePiece(label, description, piece, preferLabelMatches);
		if (result.score === NO_MATCH) return NO_ITEM_SCORE;
		score += result.score;
		labelMatch.push(...(result.labelMatch ?? []));
		descriptionMatch.push(...(result.descriptionMatch ?? []));
	}
	return { score, labelMatch: normalizeMatches(labelMatch), descriptionMatch: normalizeMatches(descriptionMatch) };
}

function scorePiece(
	label: string,
	description: string | undefined,
	query: QueryPiece,
	preferLabelMatches: boolean,
): FileScore {
	if (preferLabelMatches || !description) {
		const [labelScore, labelPositions] = scoreFuzzy(
			label,
			query.normalized,
			query.normalizedLowercase,
			!query.expectContiguousMatch,
		);
		if (labelScore) {
			// A name starting with the query ranks above other name matches, shorter names first.
			const prefix = label.toLowerCase().startsWith(query.normalizedLowercase);
			const base = prefix
				? LABEL_PREFIX_SCORE_THRESHOLD + Math.round((query.normalized.length / label.length) * 100)
				: LABEL_SCORE_THRESHOLD;
			return {
				score: base + labelScore,
				labelMatch: prefix ? [{ start: 0, end: query.normalized.length }] : createMatches(labelPositions),
			};
		}
	}
	if (description) {
		const prefixLength = description.length + 1;
		const [score, positions] = scoreFuzzy(
			`${description}/${label}`,
			query.normalized,
			query.normalizedLowercase,
			!query.expectContiguousMatch,
		);
		if (score) {
			const labelMatch: FuzzyMatch[] = [];
			const descriptionMatch: FuzzyMatch[] = [];
			for (const match of createMatches(positions)) {
				if (match.start < prefixLength && match.end > prefixLength) {
					labelMatch.push({ start: 0, end: match.end - prefixLength });
					descriptionMatch.push({ start: match.start, end: prefixLength });
				} else if (match.start >= prefixLength)
					labelMatch.push({ start: match.start - prefixLength, end: match.end - prefixLength });
				else descriptionMatch.push(match);
			}
			return { score, labelMatch, descriptionMatch };
		}
	}
	return NO_ITEM_SCORE;
}

function createMatches(offsets: number[]): FuzzyMatch[] {
	const result: FuzzyMatch[] = [];
	let last: FuzzyMatch | undefined;
	for (const position of offsets) {
		if (last && last.end === position) last.end += 1;
		else {
			last = { start: position, end: position + 1 };
			result.push(last);
		}
	}
	return result;
}

function normalizeMatches(matches: FuzzyMatch[]): FuzzyMatch[] {
	const normalized: FuzzyMatch[] = [];
	let current: FuzzyMatch | undefined;
	for (const match of matches.toSorted((a, b) => a.start - b.start)) {
		if (!current || current.end < match.start) {
			current = { ...match };
			normalized.push(current);
		} else current.end = Math.max(current.end, match.end);
	}
	return normalized;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Quick Open's order of two scored matches: best first. */
function compareFiles(
	a: { path: string; score: FileScore },
	b: { path: string; score: FileScore },
	query: FileQuery,
): number {
	const scoreA = a.score.score;
	const scoreB = b.score.score;
	if ((scoreA === PATH_IDENTITY_SCORE || scoreB === PATH_IDENTITY_SCORE) && scoreA !== scoreB)
		return scoreA === PATH_IDENTITY_SCORE ? -1 : 1;
	const itemA = split(a.path);
	const itemB = split(b.path);
	// Name matches rank above path matches.
	if (scoreA > LABEL_SCORE_THRESHOLD || scoreB > LABEL_SCORE_THRESHOLD) {
		if (scoreA !== scoreB) return scoreA > scoreB ? -1 : 1;
		if (scoreA < LABEL_PREFIX_SCORE_THRESHOLD && scoreB < LABEL_PREFIX_SCORE_THRESHOLD) {
			const byLength = compareByMatchLength(a.score.labelMatch, b.score.labelMatch);
			if (byLength) return byLength;
		}
		if (itemA.label.length !== itemB.label.length) return itemA.label.length - itemB.label.length;
	}
	if (scoreA !== scoreB) return scoreA > scoreB ? -1 : 1;
	const labelA = Boolean(a.score.labelMatch?.length);
	const labelB = Boolean(b.score.labelMatch?.length);
	if (labelA !== labelB) return labelA ? -1 : 1;
	const distanceA = matchDistance(itemA.description, a.score);
	const distanceB = matchDistance(itemB.description, b.score);
	if (distanceA && distanceB && distanceA !== distanceB) return distanceB > distanceA ? -1 : 1;
	// Equal: shorter first, then by name, folder and path.
	const lengthA = itemA.label.length + (itemA.description?.length ?? 0);
	const lengthB = itemB.label.length + (itemB.description?.length ?? 0);
	if (lengthA !== lengthB) return lengthA - lengthB;
	if (a.path.length !== b.path.length) return a.path.length - b.path.length;
	if (itemA.label !== itemB.label) return compareAnything(itemA.label, itemB.label, query.normalized);
	if (itemA.description && itemB.description && itemA.description !== itemB.description)
		return compareAnything(itemA.description, itemB.description, query.normalized);
	return a.path === b.path ? 0 : compareAnything(a.path, b.path, query.normalized);
}

function matchDistance(description: string | undefined, score: FileScore): number {
	const labelMatch = score.labelMatch ?? [];
	const descriptionMatch = score.descriptionMatch ?? [];
	const start = descriptionMatch[0]?.start ?? labelMatch[0]?.start ?? -1;
	let end = -1;
	const lastLabel = labelMatch.at(-1);
	if (lastLabel) end = lastLabel.end + (descriptionMatch.length && description ? description.length : 0);
	else end = descriptionMatch.at(-1)?.end ?? -1;
	return end - start;
}

function compareByMatchLength(a: FuzzyMatch[] | undefined, b: FuzzyMatch[] | undefined): number {
	if (!a?.length && !b?.length) return 0;
	if (!b?.length) return -1;
	if (!a?.length) return 1;
	const lengthA = (a.at(-1)?.end ?? 0) - (a[0]?.start ?? 0);
	const lengthB = (b.at(-1)?.end ?? 0) - (b[0]?.start ?? 0);
	return lengthA === lengthB ? 0 : lengthB < lengthA ? 1 : -1;
}

function compareAnything(one: string, other: string, lookFor: string): number {
	const a = one.toLowerCase();
	const b = other.toLowerCase();
	const prefixA = a.startsWith(lookFor);
	const prefixB = b.startsWith(lookFor);
	if (prefixA !== prefixB) return prefixA ? -1 : 1;
	if (prefixA && a.length !== b.length) return a.length - b.length;
	const suffixA = a.endsWith(lookFor);
	const suffixB = b.endsWith(lookFor);
	if (suffixA !== suffixB) return suffixA ? -1 : 1;
	// Numeric collation makes foo1 equal foo01: disambiguate.
	return collator.compare(a, b) || (a === b ? 0 : a < b ? -1 : 1);
}

/** The best `limit` matches of `paths`, in Quick Open order. */
export function rankFiles(paths: readonly string[], text: string, limit: number): { path: string; score: FileScore }[] {
	const query = prepareFileQuery(text);
	if (!query.normalized) return [];
	const scored: { path: string; score: FileScore }[] = [];
	for (const path of paths) {
		const score = scoreFile(path, query);
		if (score.score) scored.push({ path, score });
	}
	return scored.sort((a, b) => compareFiles(a, b, query)).slice(0, limit);
}
