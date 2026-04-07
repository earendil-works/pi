/**
 * Auto-handoff mode
 *
 * Auto-handoff is the behavior where the TUI automatically starts a fresh
 * session and submits a generated handoff draft when context usage gets high.
 *
 * This module centralizes:
 * - the persisted user preference shape
 * - parsing of user-triggered /autohandoff commands
 *
 * Auto-compaction is ON by default for ALL models.
 * Users can disable it with /autohandoff off.
 */

import type { Api, Model } from "@kennyfrc/mu-ai";

export type AutoHandoffMode = "on" | "off";

export const DEFAULT_AUTO_HANDOFF_MODE: AutoHandoffMode = "on";

/** One-way nudge threshold (ratio) for encouraging handoff. */
export const HANDOFF_NUDGE_THRESHOLD = 0.8;
export const AUTO_HANDOFF_STANDARD_THRESHOLD = 0.9;

export const AUTO_HANDOFF_EMERGENCY_THRESHOLD = 0.95;

/**
 * Context window cap for auto-compaction threshold calculation.
 * Models with context windows larger than this are treated as having this
 * effective context window for threshold purposes.
 */
export const AUTO_COMPACTION_CONTEXT_WINDOW_CAP = 256000;

/**
 * Determines if auto-compaction should be active.
 * Auto-compaction is ON by default. Only returns false if user explicitly disabled it.
 */
export function shouldAutoCompactForModel(params: { autoHandoffMode: AutoHandoffMode }): boolean {
	return params.autoHandoffMode !== "off";
}

/**
 * Returns the effective context window for auto-compaction threshold calculation.
 * Caps at AUTO_COMPACTION_CONTEXT_WINDOW_CAP (256k) for models with larger context windows.
 */
export function getAutoCompactionContextWindow(model: Pick<Model<Api>, "contextWindow"> | null | undefined): number {
	if (!model) return 0;
	return Math.min(model.contextWindow, AUTO_COMPACTION_CONTEXT_WINDOW_CAP);
}

export function isAutoHandoffMode(value: unknown): value is AutoHandoffMode {
	return value === "on" || value === "off";
}

export type AutoHandoffSlashCommand = { type: "set"; mode: AutoHandoffMode } | { type: "toggle" } | { type: "status" };

/**
 * Parse a user-entered /autohandoff command.
 *
 * Supported:
 * - /autohandoff on
 * - /autohandoff off
 * - /autohandoff toggle
 * - /autohandoff            (toggle)
 * - /autohandoff status
 */
export function parseAutoHandoffSlashCommand(text: string): AutoHandoffSlashCommand | null {
	const trimmed = text.trim();

	const match = /^\/autohandoff(?:\s+(on|off|toggle|status))?\s*$/i.exec(trimmed);
	if (!match) return null;

	const arg = match[1]?.toLowerCase();
	if (!arg) return { type: "toggle" };

	if (arg === "toggle") {
		return { type: "toggle" };
	}

	if (arg === "status") {
		return { type: "status" };
	}

	if (arg === "on" || arg === "off") {
		return { type: "set", mode: arg };
	}

	return null;
}

export function applyAutoHandoffCommand(
	currentMode: AutoHandoffMode,
	command: AutoHandoffSlashCommand,
): AutoHandoffMode {
	switch (command.type) {
		case "set":
			return command.mode;
		case "toggle":
			return currentMode === "on" ? "off" : "on";
		case "status":
			return currentMode;
	}
}

type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export function shouldTriggerEmergencyAutoHandoff(params: {
	autoHandoffMode: AutoHandoffMode;
	ratio: number;
	isAutoHandoffInProgress: boolean;
	hasModel: boolean;
	stopReason: StopReason;
}): boolean {
	if (params.autoHandoffMode !== "on") return false;
	if (params.isAutoHandoffInProgress) return false;
	if (!params.hasModel) return false;
	if (params.stopReason !== "toolUse") return false;

	return params.ratio >= AUTO_HANDOFF_EMERGENCY_THRESHOLD;
}

export function shouldTriggerStandardAutoHandoff(params: {
	autoHandoffMode: AutoHandoffMode;
	ratio: number;
	isAutoHandoffInProgress: boolean;
	hasModel: boolean;
}): boolean {
	if (params.autoHandoffMode !== "on") return false;
	if (params.isAutoHandoffInProgress) return false;
	if (!params.hasModel) return false;

	return params.ratio >= AUTO_HANDOFF_STANDARD_THRESHOLD;
}

export function shouldEnableHandoffNudge(params: {
	autoHandoffMode: AutoHandoffMode;
	ratio: number;
	currentFlag: boolean;
}): boolean {
	if (params.autoHandoffMode !== "on") return false;
	if (params.currentFlag) return true;
	return params.ratio >= HANDOFF_NUDGE_THRESHOLD;
}
