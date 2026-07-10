/**
 * GoalMode — State Machine
 *
 * Pure in-memory state machine for goal lifecycle management.
 * No pi runtime dependency — testable in isolation.
 *
 * States:  active → paused → active
 *          active → blocked → active (via resume)
 *          any*   → complete → undefined (transient, emits then clears)
 *          any*   → undefined (via cancel)
 *   *any non-undefined state
 */

import type {
	CreateGoalOptions,
	GoalDefinition,
	GoalEvent,
	GoalSnapshot,
	GoalState,
	GoalStatus,
} from "./goal-types.ts";

export type GoalEventListener = (event: GoalEvent) => void;

export class GoalMode {
	private state: GoalState;
	private history: GoalEvent[] = [];
	private listeners: GoalEventListener[] = [];
	private onTransition: GoalEventListener | undefined;

	constructor(initialState?: GoalState, onTransition?: GoalEventListener) {
		if (initialState) {
			this.state = { ...initialState };
		} else {
			this.state = {
				status: "undefined",
				goal: null,
				timestamp: Date.now(),
			};
		}
		this.onTransition = onTransition;
	}

	// --- Public accessors ----------------------------------------------

	getStatus(): GoalStatus {
		return this.state.status;
	}

	getGoal(): GoalDefinition | null {
		return this.state.goal;
	}

	getState(): Readonly<GoalState> {
		return { ...this.state };
	}

	getSnapshot(): GoalSnapshot {
		return {
			status: this.state.status,
			goal: this.state.goal,
			statusReason: this.state.statusReason,
			timestamp: this.state.timestamp,
			history: [...this.history],
		};
	}

	onEvent(listener: GoalEventListener): void {
		this.listeners.push(listener);
	}

	// --- State transitions ---------------------------------------------

	/**
	 * Create a new goal. Transitions to active.
	 * If a goal already exists, replace:true overwrites it; otherwise throws.
	 */
	createGoal(definition: GoalDefinition, options?: CreateGoalOptions): GoalEvent {
		if (this.state.status !== "undefined" && !options?.replace) {
			throw new Error(
				`Cannot create goal: a goal is already ${this.state.status}`,
			);
		}

		const previousStatus = this.state.status;
		this.state = {
			status: "active",
			goal: { ...definition },
			timestamp: Date.now(),
		};
		const event = this.emit("created", { previousStatus });
		return event;
	}

	/**
	 * Pause the current active goal.
	 */
	pauseGoal(reason?: string): GoalEvent {
		if (this.state.status === "undefined") {
			throw new Error("Cannot pause: no active goal");
		}
		if (this.state.status === "paused") {
			throw new Error("Goal is already paused");
		}
		if (this.state.status === "blocked") {
			throw new Error("Cannot pause a blocked goal — unblock first");
		}

		const previousStatus = this.state.status;
		this.state = {
			...this.state,
			status: "paused",
			statusReason: reason,
			timestamp: Date.now(),
		};
		return this.emit("paused", { previousStatus, reason });
	}

	/**
	 * Resume a paused or blocked goal.
	 */
	resumeGoal(reason?: string): GoalEvent {
		if (this.state.status === "undefined") {
			throw new Error("Cannot resume: no goal to resume");
		}
		if (this.state.status === "active") {
			throw new Error("Goal is already active");
		}
		// Allow resume from paused or blocked

		const previousStatus = this.state.status;
		this.state = {
			...this.state,
			status: "active",
			statusReason: reason,
			timestamp: Date.now(),
		};
		return this.emit("resumed", { previousStatus, reason });
	}

	/**
	 * Mark the goal as blocked by an external dependency.
	 */
	markBlocked(reason: string): GoalEvent {
		if (this.state.status === "undefined") {
			throw new Error("Cannot block: no goal to block");
		}
		if (this.state.status === "blocked") {
			throw new Error("Goal is already blocked");
		}

		const previousStatus = this.state.status;
		this.state = {
			...this.state,
			status: "blocked",
			statusReason: reason,
			timestamp: Date.now(),
		};
		return this.emit("blocked", { previousStatus, reason });
	}

	/**
	 * Mark the goal as complete.
	 * Transient: emits a "completed" event, then immediately clears to undefined.
	 * clearInternal() runs before emit(), so re-entrant calls are caught by the
	 * status guard ("Cannot complete: no goal to complete").
	 */
	markComplete(reason?: string): GoalEvent {
		if (this.state.status === "undefined") {
			throw new Error("Cannot complete: no goal to complete");
		}

		const previousStatus = this.state.status;
		// Clear first, then emit — so listeners (persist) see the post-transition state.
		// Matches cancelGoal's pattern: clearInternal → emit.
		this.clearInternal();
		return this.emit("completed", { previousStatus, reason });
	}

	/**
	 * Cancel the current goal from any non-undefined state.
	 *
	 * Safety: when cancelling from "active", the method internally
	 * transitions to "paused" first (emitting a "paused" event) before
	 * clearing to undefined (emitting "cancelled").  This guarantees
	 * that callers — including index.ts command handlers — don't have
	 * to perform the two-step dance themselves.
	 */
	cancelGoal(reason?: string): GoalEvent {
		if (this.state.status === "undefined") {
			throw new Error("Cannot cancel: no goal to cancel");
		}

		// Safety: active → paused → cancelled
		if (this.state.status === "active") {
			const pauseReason = reason ?? "Paused before cancel";
			this.state = {
				...this.state,
				status: "paused",
				statusReason: pauseReason,
				timestamp: Date.now(),
			};
			this.emit("paused", { previousStatus: "active", reason: pauseReason });
		}

		const previousStatus = this.state.status;
		this.clearInternal();
		return this.emit("cancelled", { previousStatus, reason });
	}

	/**
	 * After session resume, downgrade active → paused so the agent doesn't
	 * start working on a goal without explicit user confirmation.
	 */
	normalizeAfterReplay(): GoalEvent | null {
		if (this.state.status === "active") {
			const previousStatus = this.state.status;
			this.state = {
				...this.state,
				status: "paused",
				statusReason: "Paused after agent resume",
				timestamp: Date.now(),
			};
			return this.emit("normalized", { previousStatus });
		}
		// paused, blocked, undefined — no change needed
		return null;
	}

	/**
	 * Reconstruct a GoalMode from a persisted snapshot.
	 */
	static fromSnapshot(snapshot: GoalSnapshot, onTransition?: GoalEventListener): GoalMode {
		const mode = new GoalMode(undefined, onTransition);
		// Directly restore state and history from the snapshot
		mode.state = {
			status: snapshot.status,
			goal: snapshot.goal,
			statusReason: snapshot.statusReason,
			timestamp: snapshot.timestamp,
		};
		mode.history = [...snapshot.history];
		return mode;
	}

	// --- Internal helpers ----------------------------------------------

	private clearInternal(): void {
		this.state = {
			status: "undefined",
			goal: null,
			timestamp: Date.now(),
		};
	}

	private emit(
		type: GoalEvent["type"],
		opts: { previousStatus: GoalStatus; reason?: string },
	): GoalEvent {
		const event: GoalEvent = {
			type,
			timestamp: Date.now(),
			reason: opts.reason,
			previousStatus: opts.previousStatus,
			currentStatus: this.state.status,
		};
		this.history.push(event);
		for (const listener of this.listeners) {
			listener(event);
		}
		this.onTransition?.(event);
		return event;
	}
}
