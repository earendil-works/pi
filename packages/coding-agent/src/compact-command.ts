import type { AutoHandoffMode, AutoHandoffSlashCommand } from "./auto-handoff.js";

export type CompactSlashCommand =
	| { kind: "compact"; goal: string; mode: "summary" | "inject" }
	| { kind: "auto"; command: AutoHandoffSlashCommand };

const COMPACT_PREFIX = "/compact";

function asAutoMode(value: string): AutoHandoffMode | null {
	if (value === "on" || value === "off") {
		return value;
	}
	return null;
}

export function parseCompactSlashCommand(rawText: string): CompactSlashCommand | null {
	if (!rawText.startsWith(COMPACT_PREFIX)) return null;

	const rest = rawText.slice(COMPACT_PREFIX.length).trim();
	if (!rest) return null;

	const lowered = rest.toLowerCase();
	if (lowered === "toggle") {
		return { kind: "auto", command: { type: "toggle" } };
	}
	if (lowered === "status") {
		return { kind: "auto", command: { type: "status" } };
	}
	const autoMode = asAutoMode(lowered);
	if (autoMode) {
		return { kind: "auto", command: { type: "set", mode: autoMode } };
	}

	const summaryPrefixes = ["--summary", "summary"];
	for (const prefix of summaryPrefixes) {
		if (rest === prefix) return null;
		if (rest.startsWith(`${prefix} `)) {
			const goal = rest.slice(prefix.length).trim();
			return goal ? { kind: "compact", mode: "summary", goal } : null;
		}
	}

	const injectPrefixes = ["--inject", "inject"];
	for (const prefix of injectPrefixes) {
		if (rest === prefix) return null;
		if (rest.startsWith(`${prefix} `)) {
			const goal = rest.slice(prefix.length).trim();
			return goal ? { kind: "compact", mode: "inject", goal } : null;
		}
	}

	return { kind: "compact", mode: "summary", goal: rest };
}
