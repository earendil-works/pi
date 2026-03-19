import type { Api, AssistantMessage, Model, ServiceUsageLimits, ServiceUsageLimitWindow } from "@kennyfrc/mu-ai";

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

function clampPercentRemaining(usedPercent: number): number {
	return Math.max(0, Math.min(100, 100 - usedPercent));
}

function formatUsageWindowLabel(windowMinutes: number | undefined): string {
	if (windowMinutes === undefined) return "quota";
	if (windowMinutes === 60) return "1h";
	if (windowMinutes > 0 && windowMinutes < 24 * 60 && windowMinutes % 60 === 0) {
		return `${windowMinutes / 60}h`;
	}
	if (windowMinutes === 24 * 60) return "daily";
	if (windowMinutes === 7 * 24 * 60) return "weekly";
	if (windowMinutes > 0 && windowMinutes % (24 * 60) === 0) {
		return `${windowMinutes / (24 * 60)}d`;
	}
	return `${windowMinutes}m`;
}

function mapWindow(window: ServiceUsageLimitWindow | undefined): UsageLimitWindow | undefined {
	if (!window) return undefined;
	return {
		label: formatUsageWindowLabel(window.windowMinutes),
		percentRemaining: clampPercentRemaining(window.usedPercent),
		resetsAt: window.resetsAt !== undefined ? new Date(window.resetsAt * 1000).toISOString() : undefined,
	};
}

export function usageLimitsToSnapshot(
	usageLimits: ServiceUsageLimits | undefined,
	capturedAt: number = Date.now(),
): UsageLimitsSnapshot | null {
	if (!usageLimits) return null;
	const primary = mapWindow(usageLimits.primary);
	const secondary = mapWindow(usageLimits.secondary);
	if (!primary && !secondary) return null;
	return {
		capturedAt,
		primary,
		secondary,
	};
}

export function assistantMessageUsageSnapshot(message: AssistantMessage | undefined): UsageLimitsSnapshot | null {
	if (!message) return null;
	return usageLimitsToSnapshot(message.usageLimits, message.timestamp);
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

export function getEffectiveUsageFooterMode(options: {
	savedMode: UsageFooterMode;
	hasExplicitPreference: boolean;
	model: Model<Api> | null | undefined;
	usageLimits: UsageLimitsSnapshot | null;
}): UsageFooterMode {
	const { savedMode, hasExplicitPreference, model, usageLimits } = options;
	if (savedMode === "visible") return "visible";
	if (hasExplicitPreference) return savedMode;
	if (model?.provider === "anthropic" && usageLimits) return "visible";
	return savedMode;
}

export function supportsUsageCommand(model: Model<any> | null | undefined): boolean {
	if (!model) return false;
	const normalized = model.id.includes("/") ? (model.id.split("/").pop() ?? model.id) : model.id;
	return normalized.toLowerCase().startsWith("gpt");
}
