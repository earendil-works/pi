export type MorphCompactionMode = "on" | "off" | "auto";

export const DEFAULT_MORPH_COMPACTION_MODE: MorphCompactionMode = "auto";

export function isMorphCompactionMode(value: unknown): value is MorphCompactionMode {
	return value === "on" || value === "off" || value === "auto";
}

export type MorphCompactionSlashCommand =
	| { type: "set"; mode: MorphCompactionMode }
	| { type: "toggle" }
	| { type: "status" };

export function parseMorphCompactionSlashCommand(text: string): MorphCompactionSlashCommand | null {
	const trimmed = text.trim();
	const match = /^\/morph-compaction\s+(on|off|auto|toggle|status)\s*$/i.exec(trimmed);
	if (!match) return null;

	const arg = match[1]?.toLowerCase();
	if (arg === "toggle") {
		return { type: "toggle" };
	}

	if (arg === "status") {
		return { type: "status" };
	}

	if (arg === "on" || arg === "off" || arg === "auto") {
		return { type: "set", mode: arg };
	}

	return null;
}

export function applyMorphCompactionCommand(
	currentMode: MorphCompactionMode,
	command: MorphCompactionSlashCommand,
): MorphCompactionMode {
	switch (command.type) {
		case "set":
			return command.mode;
		case "toggle":
			if (currentMode === "auto") return "off";
			if (currentMode === "off") return "on";
			return "auto";
		case "status":
			return currentMode;
	}
}
