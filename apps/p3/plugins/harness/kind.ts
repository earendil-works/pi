// The subagents kind (`harness.subagents`, decision 101). Made only by its plugin, one thing in Pi; the nearest link
// decides. Its one tick, Use, is a flag tick for the agents (decision 97): with it the agent's main conversation has
// the `subagent` tool (`subagents.ts`). A new link gives the agents Use; no guests. A workspace hides the thing, or
// withholds Use, where agents must not start agents (a child's robot, a session guests may send to).

import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** The subagents: no members of their own; the flag `use` gives the agent the `subagent` tool. */
export const SubagentsKind = defineThing("harness.subagents", {
	version: 1,
	makers: "plugin",
	stacking: "nearest",
	ticks: { use: { label: messages.message("tickUse"), for: "agents" } },
	defaultGrants: { agents: ["use"] },
});
