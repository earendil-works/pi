import type { Model } from "@kennyfrc/mu-ai";

export type FastModeSlashCommand = { type: "set"; enabled: boolean } | { type: "toggle" } | { type: "status" };

export function parseFastModeSlashCommand(text: string): FastModeSlashCommand | null {
	const trimmed = text.trim();
	const match = /^\/fast(?:\s+(on|off|toggle|status))?\s*$/i.exec(trimmed);
	if (!match) return null;

	const arg = match[1]?.toLowerCase();
	if (!arg || arg === "toggle") return { type: "toggle" };
	if (arg === "status") return { type: "status" };
	if (arg === "on") return { type: "set", enabled: true };
	if (arg === "off") return { type: "set", enabled: false };
	return null;
}

export function applyFastModeCommand(current: boolean, command: FastModeSlashCommand): boolean {
	switch (command.type) {
		case "set":
			return command.enabled;
		case "toggle":
			return !current;
		case "status":
			return current;
	}
}

export function supportsFastMode(model: Model<any> | null | undefined): boolean {
	if (!model) return false;
	const normalized = model.id.includes("/") ? (model.id.split("/").pop() ?? model.id) : model.id;
	return normalized.toLowerCase().startsWith("gpt");
}
