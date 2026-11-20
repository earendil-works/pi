// What the sidebar's items and the command menu do to a session's agents from outside their chat: stop their runs
// (`RunControl`: the inputs a stop withdraws wait as their authors' drafts) and archive a subagent (`SubagentControl`).
// Each holds its object for the one call.
import { BACKGROUND_CONTEXT, type Host, withHeld } from "@p2/app/v1";
import { RunControl } from "../chat/contract.ts";
import { type Child, SubagentControl } from "../subagents/contract.ts";

/** Stops the runs of `conversations` of `session`; rejects with the first refusal (a viewer, the session moving). */
export async function stopRuns(host: Host, session: string, conversations: readonly number[]): Promise<void> {
	await Promise.all(
		conversations.map((conversation) =>
			withHeld(host.hold(RunControl, { session, conversation }, BACKGROUND_CONTEXT), "participant", (control) =>
				control.stop(BACKGROUND_CONTEXT),
			),
		),
	);
}

/** Archives subagent `conversation` of `session` (stopping its work first). */
export async function archiveSubagent(host: Host, session: string, conversation: number): Promise<void> {
	await withHeld(host.hold(SubagentControl, { session }, BACKGROUND_CONTEXT), "participant", (control) =>
		control.archive({ conversation, archived: true }, BACKGROUND_CONTEXT),
	);
}

/**
 * The conversations a session's Cancel stops: its busy ones but one-shot agents, which their script owns (stopping the
 * script's conversation stops them with it).
 */
export function stoppable(busy: readonly number[], subagents: readonly Child[]): number[] {
	const oneShots = new Set(subagents.flatMap((agent) => (agent.kind === "agent" ? [agent.conversationId] : [])));
	return busy.filter((conversation) => !oneShots.has(conversation));
}
