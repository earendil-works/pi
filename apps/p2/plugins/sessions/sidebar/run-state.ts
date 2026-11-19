// A conversation's run as its sidebar item shows it: working (and on what, for the tooltip), how its last run ended
// (failed, stopped) or idle; and the words of its tooltip. A session's item and its subagents' share it. No React: the
// rows render what these return.
import type { RunFailure, Work } from "../../status/contract.ts";
import { type Child, shortModelName } from "../../subagents/contract.ts";

/**
 * Where a conversation's run is: working (`work` says on what, once its worker reported it), its last run failed
 * (Durable's reason, and the model's error text when it has one) or was stopped, or idle.
 */
export type RunState =
	| { readonly kind: "busy"; readonly work?: Work }
	| { readonly kind: "failed"; readonly reason: string; readonly detail?: string }
	| { readonly kind: "stopped"; readonly reason?: string }
	| { readonly kind: "idle" };

/**
 * A conversation's run: busy while it works; else how its last run ended (`failure`, Durable's `runFailure`). An abort
 * and the tool-round limit (a continue resumes it) are stops; a reset, or a run with nothing to answer, ended as an
 * idle one does.
 */
export function runState(failure: RunFailure | undefined, busy: boolean, work: Work | undefined): RunState {
	if (busy) return work ? { kind: "busy", work } : { kind: "busy" };
	if (failure === undefined || failure.reason === "reset" || failure.reason === "nothing_to_answer")
		return { kind: "idle" };
	if (failure.reason === "aborted") return { kind: "stopped" };
	if (failure.reason === "turn_limit") return { kind: "stopped", reason: "the tool round limit" };
	return failure.detail === undefined
		? { kind: "failed", reason: failure.reason }
		: { kind: "failed", reason: failure.reason, detail: failure.detail };
}

/**
 * A subagent item's tooltip: its model and thinking level, where it works (`location`: its own, else it follows the
 * session), and what its status says in full: the tools it runs by name, or why its last run failed or stopped.
 */
export function subagentTitle(agent: Child, state: RunState, location: string | undefined): string {
	return [
		`${shortModelName(agent.model)} · ${agent.thinkingLevel}`,
		location === undefined ? "Follows the session" : `Works in ${location}`,
		...stateInFull(state),
	].join("\n");
}

/** The tooltip's line for a run's state, when its mark says less than there is. */
function stateInFull(state: RunState): string[] {
	switch (state.kind) {
		case "busy":
			return state.work?.step.kind === "tools" ? [`Running ${state.work.step.names.join(", ")}`] : [];
		case "failed":
			return [`Failed: ${state.detail ?? failureWords(state.reason)}`];
		case "stopped":
			return state.reason ? [`Stopped at ${state.reason}`] : [];
		case "idle":
			return [];
	}
}

/** What a failed run's reason means for the owner (Durable's run failure reasons). */
export function failureWords(reason: string): string {
	return FAILURES[reason] ?? "Its run failed";
}

const FAILURES: Readonly<Record<string, string>> = {
	model_error: "The model's response failed",
	no_model: "Its model is not available",
	faulted: "Its run hit an error",
	orphaned: "Its run can no longer continue here",
	interrupted: "It was cut off while answering",
	restart_limit: "It was cut off too often",
};
