import type { Model } from "@kennyfrc/mu-ai";

export type UsageFooterMode = "hidden" | "visible";

export interface UsageLimitWindow {
	label: string;
	percentRemaining: number;
	resetsAt?: string;
}

export interface UsageLimitsSnapshot {
	capturedAt: number;
	primary?: UsageLimitWindow;
	secondary?: UsageLimitWindow;
}

export type UsageSlashCommand = { type: "set"; mode: UsageFooterMode } | { type: "toggle" } | { type: "status" };

export function parseUsageSlashCommand(text: string): UsageSlashCommand | null {
	const trimmed = text.trim();
	const match = /^\/usage(?:\s+(on|off|toggle|status))?\s*$/i.exec(trimmed);
	if (!match) return null;

	const arg = match[1]?.toLowerCase();
	if (!arg || arg === "toggle") return { type: "toggle" };
	if (arg === "status") return { type: "status" };
	if (arg === "on") return { type: "set", mode: "visible" };
	if (arg === "off") return { type: "set", mode: "hidden" };
	return null;
}

export function applyUsageCommand(current: UsageFooterMode, command: UsageSlashCommand): UsageFooterMode {
	switch (command.type) {
		case "set":
			return command.mode;
		case "toggle":
			return current === "visible" ? "hidden" : "visible";
		case "status":
			return current;
	}
}

export function supportsUsageCommand(model: Model<any> | null | undefined): boolean {
	if (!model) return false;
	const normalized = model.id.includes("/") ? (model.id.split("/").pop() ?? model.id) : model.id;
	return normalized.toLowerCase().startsWith("gpt");
}
