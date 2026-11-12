// A subagent's state as the end of its sidebar row shows it, and its words: what it does while it works (one or two
// words), how its last run ended, or since when it is idle. No React: the row renders what these return.
import type { ToolActivity } from "@p2/app/v1/web";
import type { Work } from "../../status/contract.ts";
import { type Child, shortModelName } from "../../subagents/contract.ts";

/**
 * Where a subagent is: working (`work` says on what, once its worker reported it), its last run failed (Durable's
 * reason, and the model's error text when it has one) or was stopped, or idle since its newest message.
 */
export type SubagentState =
	| { readonly kind: "busy"; readonly work?: Work }
	| { readonly kind: "failed"; readonly reason: string; readonly detail?: string }
	| { readonly kind: "stopped"; readonly reason?: string }
	| { readonly kind: "idle"; readonly since?: number };

/** The tools' contributions by name (`ToolActivities`), for their briefs. */
export type Tools = ReadonlyMap<string, ToolActivity>;

/**
 * A subagent's state: busy while its conversation works; else how its last run ended. An abort and the tool-round
 * limit (a continue resumes it) are stops; a reset, or a run with nothing to answer, ended as an idle one does.
 */
export function subagentState(agent: Child, busy: boolean, work: Work | undefined): SubagentState {
	if (busy) return work ? { kind: "busy", work } : { kind: "busy" };
	const failure = agent.failure;
	if (failure === undefined || failure.reason === "reset" || failure.reason === "nothing_to_answer")
		return agent.updatedAt === undefined ? { kind: "idle" } : { kind: "idle", since: agent.updatedAt };
	if (failure.reason === "aborted") return { kind: "stopped" };
	if (failure.reason === "turn_limit") return { kind: "stopped", reason: "the tool round limit" };
	return failure.detail === undefined
		? { kind: "failed", reason: failure.reason }
		: { kind: "failed", reason: failure.reason, detail: failure.detail };
}

/** What a busy subagent does in one or two words: its first running tool's brief (and how many more run). */
export function stepWords(work: Work | undefined, tools: Tools): string {
	const step = work?.step;
	switch (step?.kind) {
		case "tools": {
			const [first, ...more] = step.names;
			// A tool without a brief (an MCP tool, say) has no words fit for the row; its tooltip names it.
			const words = tools.get(first)?.brief ?? "Using a tool";
			return more.length ? `${words} +${more.length}` : words;
		}
		case "thinking":
			return "Thinking";
		case "compacting":
			return "Compacting";
		default:
			return "Working";
	}
}

/**
 * A subagent row's tooltip: its model and thinking level, where it works (`location`: its own, else it follows the
 * session), and what its end says in full: the tools it runs by name, or why its last run failed or stopped. The row's
 * link covers its end, so this is the one tooltip a pointer sees there.
 */
export function subagentTitle(agent: Child, state: SubagentState, location: string | undefined): string {
	return [
		`${shortModelName(agent.model)} · ${agent.thinkingLevel}`,
		location === undefined ? "Follows the session" : `Works in ${location}`,
		...endInFull(state),
	].join("\n");
}

/** The tooltip's line for a row's end, when the end says less than there is. */
function endInFull(state: SubagentState): string[] {
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
