/**
 * Auto-handoff mode
 *
 * Auto-handoff is the behavior where the TUI automatically starts a fresh
 * session and submits a generated handoff draft when context usage gets high.
 *
 * This module centralizes:
 * - the persisted user preference shape
 * - parsing of user-triggered /autohandoff commands
 */

import type { Api, Model } from "@kennyfrc/mu-ai";

export type AutoHandoffMode = "on" | "off";

export const DEFAULT_AUTO_HANDOFF_MODE: AutoHandoffMode = "off";

/** One-way nudge threshold (ratio) for encouraging handoff. */
export const HANDOFF_NUDGE_THRESHOLD = 0.8;
export const AUTO_HANDOFF_STANDARD_THRESHOLD = 0.9;

export const AUTO_HANDOFF_EMERGENCY_THRESHOLD = 0.95;
export const TARGETED_AUTO_COMPACTION_CONTEXT_WINDOW = 256000;

function normalizeModelId(modelId: string): string {
	return modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
}

export function isTargetedAutoCompactionModel(model: Pick<Model<Api>, "provider" | "id"> | null | undefined): boolean {
	if (!model) return false;
	const normalized = normalizeModelId(model.id).toLowerCase();
	if (model.provider === "anthropic") {
		return normalized === "claude-sonnet-4-6" || normalized === "claude-opus-4-6";
	}

	return model.provider === "openai" && normalized.startsWith("gpt-");
}

export function shouldAutoCompactForModel(params: {
	autoHandoffMode: AutoHandoffMode;
	model: Pick<Model<Api>, "provider" | "id"> | null | undefined;
}): boolean {
	if (params.autoHandoffMode === "on") return true;
	return isTargetedAutoCompactionModel(params.model);
}

export function getAutoCompactionContextWindow(
	model: Pick<Model<Api>, "provider" | "id" | "contextWindow"> | null | undefined,
): number {
	if (!model) return 0;
	if (!isTargetedAutoCompactionModel(model)) return model.contextWindow;
	return Math.min(model.contextWindow, TARGETED_AUTO_COMPACTION_CONTEXT_WINDOW);
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
