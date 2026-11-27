// The session's subagents (the subagents' part, `subagents.ts`, starts and drives them; `reporter.ts` delivers their
// messages): the document listing them by name (`Subagents`, the session's, so every top-level conversation sees the
// same names), the task owning each one's conversation (`Anchor`), and what a subagent gets from the agent when it is
// configured: the agent's tools it may be given now, and its thinking level clamped to its model.

import {
	type Agent,
	type ConversationId,
	clampThinkingLevel,
	defineDoc,
	defineTask,
	type EntryId,
	type Models,
	type ModelThinkingLevel,
} from "@earendil-works/p3/v1/worker";
import type { HarnessTool } from "../things/contract.worker.ts";
import type { ModelRef } from "./agent-parts.ts";

/** The subagents' tool: a `main` tool, so the agent's (its top-level conversations'), never a subagent's. */
export const SUBAGENT_TOOL = "subagent";

/**
 * A subagent: its conversation; the answers already reported (several messages may end in one answer); the model
 * (`provider/modelId`) and thinking level it was given (the level as asked: it is clamped to the model when applied);
 * the tools it was given by name (none: every tool the agent may give it); its generation, which every stop and archive
 * bumps (a message sent before is not delivered after); and whether it is archived (hidden from `status`, still usable).
 */
export type Subagent = {
	readonly conversationId: ConversationId;
	readonly reported: EntryId[];
	model: string;
	thinkingLevel: ModelThinkingLevel;
	tools?: string[];
	generation: number;
	archived?: true;
};

/** The session's subagents by name. */
export const Subagents = defineDoc<{ agents: Record<string, Subagent> }>({
	checkpointWhen: () => false,
	kind: "harness.subagents",
	version: 1,
	// The session's: a top-level branch sees the same subagents; each message's answer goes to the conversation that sent it.
	scope: "session",
	initial: () => ({ agents: {} }),
});

/**
 * What owns a subagent's conversation: a background task that ends at once. A subagent outlives the agent's turns; a
 * background task is a boundary, so the agent's stop and idle waits do not reach it.
 */
export const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "harness.subagent-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
	},
	abort: (_anchor, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/**
 * The tools the agent `own` may give a subagent: those offered to its model now (so never one it does not have, also
 * when its own tools are a selection), minus the `main` ones. `HarnessTool`: every tool the harness installs is a
 * kind's, and keeps its scope.
 */
export function givable(own: Agent): HarnessTool[] {
	const tools: readonly HarnessTool[] = own.tools;
	return tools.filter((tool) => tool.scope === undefined);
}

/**
 * The tools a subagent gets from the agent `own` now: the ones it was given by name that the agent may still give, in
 * that order, or all the agent may give; enabled and offered exactly (a deferred one the agent loaded too).
 */
export function toolsOf(agent: Pick<Subagent, "tools">, own: Agent) {
	const all = givable(own);
	const names = agent.tools;
	const tools = names === undefined ? all : names.flatMap((name) => all.find((tool) => tool.name === name) ?? []);
	return { tools, modelTools: tools };
}

/** A model's reference as the document records it (`provider/modelId`; the model id may hold more slashes). */
export function modelText(ref: ModelRef): string {
	return `${ref.provider}/${ref.modelId}`;
}

/** The reference `text` names, if it has the form `provider/modelId`. */
export function modelRef(text: string): ModelRef | undefined {
	const slash = text.indexOf("/");
	return slash > 0 ? { provider: text.slice(0, slash), modelId: text.slice(slash + 1) } : undefined;
}

/** The model and thinking level a subagent runs with: its level clamped to its model (a model gone: as asked). */
export function levelOf(agent: Pick<Subagent, "model" | "thinkingLevel">, models: Models) {
	const ref = modelRef(agent.model);
	const model = ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId);
	const thinkingLevel = model === undefined ? agent.thinkingLevel : clampThinkingLevel(model, agent.thinkingLevel);
	return { model: ref, thinkingLevel };
}
