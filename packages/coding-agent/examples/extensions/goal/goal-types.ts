/**
 * Goal Extension — Core Types
 *
 * Defines the status enum, state shape, snapshot format, and event types
 * for the GoalMode state machine and persistence layer.
 */

/** Possible states a goal can be in. */
export type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "complete"   // transient — emitted then immediately cleared
	| "undefined";

/** User-facing definition of a goal. */
export interface GoalDefinition {
	title: string;
	description?: string;
}

/** Internal runtime state of the goal machine. */
export interface GoalState {
	status: GoalStatus;
	goal: GoalDefinition | null;
	statusReason?: string;
	timestamp: number;
}

/** Serializable snapshot used for persistence. */
export interface GoalSnapshot {
	status: GoalStatus;
	goal: GoalDefinition | null;
	statusReason?: string;
	timestamp: number;
	history: GoalEvent[];
}

/** Lifecycle event emitted on every state transition. */
export interface GoalEvent {
	type: "created" | "paused" | "resumed" | "blocked" | "completed" | "cancelled" | "normalized";
	timestamp: number;
	reason?: string;
	previousStatus: GoalStatus;
	currentStatus: GoalStatus;
}

/** Options for createGoal(). */
export interface CreateGoalOptions {
	/** If true, replace any existing unfinished goal. Default false. */
	replace?: boolean;
}
