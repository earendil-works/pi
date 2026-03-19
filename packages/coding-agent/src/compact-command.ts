export type CompactSlashCommand = { kind: "compact"; goal: string };

const COMPACT_PREFIX = "/compact";

export function parseCompactSlashCommand(rawText: string): CompactSlashCommand | null {
	if (!rawText.startsWith(COMPACT_PREFIX)) return null;

	const rest = rawText.slice(COMPACT_PREFIX.length).trim();
	if (!rest) return null;

	const summaryPrefixes = ["--summary", "summary"];
	for (const prefix of summaryPrefixes) {
		if (rest === prefix) return null;
		if (rest.startsWith(`${prefix} `)) {
			const goal = rest.slice(prefix.length).trim();
			return goal ? { kind: "compact", goal } : null;
		}
	}

	return null;
}
