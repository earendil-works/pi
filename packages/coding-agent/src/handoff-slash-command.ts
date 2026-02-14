export type HandoffSlashCommand = { mode: "summary" | "inject"; goal: string };

const HANDOFF_PREFIX = "/handoff";

export function parseHandoffSlashCommand(rawText: string): HandoffSlashCommand | null {
	if (!rawText.startsWith(HANDOFF_PREFIX)) return null;

	const rest = rawText.slice(HANDOFF_PREFIX.length).trim();
	if (!rest) return null;

	const injectPrefixes = ["--inject", "inject"];
	for (const prefix of injectPrefixes) {
		if (rest === prefix) return null;
		if (rest.startsWith(`${prefix} `)) {
			const goal = rest.slice(prefix.length).trim();
			return goal ? { mode: "inject", goal } : null;
		}
	}

	return { mode: "summary", goal: rest };
}
