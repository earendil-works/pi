// Ranking for `@` completion, after pi-tui's autocomplete (`scoreEntry` over fd's substring matches, then depth,
// length and name). p2 has no fd query, so entries that match only fuzzily (pi-tui fuzzy.ts) rank below every
// substring match instead of being dropped. Pure; shared by the worker index and tests.
import { fuzzyMatch } from "@earendil-works/pi-tui";
import type { FileItem } from "@p2/app/v1";

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** pi's `scoreEntry`: exact name 100, name prefix 80, name substring 50, path substring 30; directories +10. */
export function scoreEntry(path: string, query: string, dir: boolean): number {
	const name = basename(path).toLowerCase();
	const lower = query.toLowerCase();
	let score = 0;
	if (name === lower) score = 100;
	else if (name.startsWith(lower)) score = 80;
	else if (name.includes(lower)) score = 50;
	else if (path.toLowerCase().includes(lower)) score = 30;
	else {
		// p2: a fuzzy match (characters in order) of the name, else of the path, below every substring match.
		const fuzzy = fuzzyMatch(lower, name).matches ? fuzzyMatch(lower, name) : fuzzyMatch(lower, path);
		if (fuzzy.matches) score = Math.max(1, Math.min(20, 20 - fuzzy.score / 10));
	}
	if (dir && score > 0) score += 10;
	return score;
}

export function rankFiles(
	entries: readonly FileItem[],
	query: string,
	options: { limit?: number; kind?: "any" | "file" | "dir" } = {},
): FileItem[] {
	const kind = options.kind ?? "any";
	const text = query.replace(/^\.\//, "");
	const scored: { item: FileItem; score: number; depth: number }[] = [];
	for (const item of entries) {
		if (kind === "file" ? item.dir : kind === "dir" ? !item.dir : false) continue;
		const score = text ? scoreEntry(item.path, text, item.dir) : 1;
		if (score > 0) scored.push({ item, score, depth: item.path.split("/").length });
	}
	scored.sort(
		(a, b) =>
			b.score - a.score ||
			a.depth - b.depth ||
			a.item.path.length - b.item.path.length ||
			a.item.path.localeCompare(b.item.path),
	);
	return scored.slice(0, options.limit ?? 20).map(({ item }) => item);
}

/** Files plus the directories their paths imply, sorted. */
export function withDirectories(files: readonly string[]): FileItem[] {
	const dirs = new Set<string>();
	for (const file of files)
		for (let index = file.indexOf("/"); index !== -1; index = file.indexOf("/", index + 1))
			dirs.add(file.slice(0, index));
	return [...[...dirs].map((path) => ({ path, dir: true })), ...files.map((path) => ({ path, dir: false }))];
}
