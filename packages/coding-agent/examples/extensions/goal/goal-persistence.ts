/**
 * Goal Persistence — Save / Load GoalMode snapshots
 *
 * Uses pi session custom entries for durable storage.
 * Load logic is pure and testable in isolation:
 *   - scan entries for the last goal_state
 *   - call GoalMode.fromSnapshot() + normalizeAfterReplay()
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalSnapshot } from "./goal-types.ts";
import { GoalMode, type GoalEventListener } from "./goal-mode.ts";

/** Custom entry type used for goal state persistence. */
export const GOAL_STATE_CUSTOM_TYPE = "goal_state";

// --- Pure helpers (testable without pi runtime) ----------------------

/** Type shape of a session entry we care about. */
export interface SessionEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/**
 * Find the last goal_state entry in the list.
 * Returns undefined if none found.
 */
export function findLastGoalStateEntry(
	entries: readonly SessionEntry[],
): GoalSnapshot | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			entry.type === "custom" &&
			entry.customType === GOAL_STATE_CUSTOM_TYPE
		) {
			return entry.data as GoalSnapshot;
		}
	}
	return undefined;
}

/**
 * Rebuild a GoalMode from a snapshot and apply normalizeAfterReplay.
 */
export function rebuildFromSnapshot(snapshot: GoalSnapshot, onTransition?: GoalEventListener): GoalMode {
	const mode = GoalMode.fromSnapshot(snapshot, onTransition);
	mode.normalizeAfterReplay();
	return mode;
}

/**
 * Scan entries, find the last goal_state, rebuild GoalMode with replay normalization.
 * Returns null if no saved state found.
 */
export function loadGoalStateFromEntries(
	entries: readonly SessionEntry[],
	onTransition?: GoalEventListener,
): GoalMode | null {
	const snapshot = findLastGoalStateEntry(entries);
	if (!snapshot) return null;
	return rebuildFromSnapshot(snapshot, onTransition);
}

// --- Pi runtime helpers (require ExtensionAPI) -----------------------

/**
 * Persist the current goal state as a custom session entry.
 */
export function saveGoalState(pi: ExtensionAPI, mode: GoalMode): void {
	pi.appendEntry(GOAL_STATE_CUSTOM_TYPE, mode.getSnapshot());
}

/**
 * Load goal state from the current session via ExtensionContext.
 * Returns null if no saved state, or a rebuilt GoalMode with replay normalization.
 */
export function loadGoalState(ctx: ExtensionContext, onTransition?: GoalEventListener): GoalMode | null {
	const entries = ctx.sessionManager.getEntries() as SessionEntry[];
	return loadGoalStateFromEntries(entries, onTransition);
}
