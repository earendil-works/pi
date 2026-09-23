import { existsSync, globSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";

function normalizePattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return normalized.split(sep).join("/");
}

function isOverride(entry: string): boolean {
	return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");
}

function getMatchCandidates(entryPath: string, root: string): { glob: string[]; exact: string[] } {
	const relativePath = relative(root, entryPath).split(sep).join("/");
	const absolutePath = entryPath.split(sep).join("/");
	return {
		glob: [relativePath, basename(entryPath), absolutePath],
		exact: [relativePath, absolutePath],
	};
}

/** Resolve an extension manifest declaration to its selected existing paths. */
export function resolveExtensionManifestEntries(root: string, entries: string[]): string[] {
	const exclusions = entries.filter((entry) => entry.startsWith("!")).map((entry) => normalizePattern(entry.slice(1)));
	const forceIncludes = entries
		.filter((entry) => entry.startsWith("+"))
		.map((entry) => normalizePattern(entry.slice(1)));
	const forceExcludes = entries
		.filter((entry) => entry.startsWith("-"))
		.map((entry) => normalizePattern(entry.slice(1)));
	const discovered = entries
		.filter((entry) => !isOverride(entry))
		.flatMap((entry) => {
			if (!entry.includes("*") && !entry.includes("?")) return [resolve(root, entry)];
			return globSync(entry, { cwd: root })
				.map((match) => resolve(root, match))
				.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		})
		.filter(existsSync);
	const selected = new Set(
		discovered.filter((entry) => {
			const candidates = getMatchCandidates(entry, root).glob;
			return !exclusions.some((pattern) => candidates.some((candidate) => minimatch(candidate, pattern)));
		}),
	);

	for (const entry of discovered) {
		const candidates = getMatchCandidates(entry, root).exact;
		if (forceIncludes.some((pattern) => candidates.includes(pattern))) selected.add(entry);
	}
	for (const entry of selected) {
		const candidates = getMatchCandidates(entry, root).exact;
		if (forceExcludes.some((pattern) => candidates.includes(pattern))) selected.delete(entry);
	}

	return discovered.filter((entry) => selected.has(entry));
}
