// The harness plugin's contract: the subagents as a kind of thing (`harness.subagents`, decision 101). Made only by its
// plugin, one thing in Pi; its one tick, Use, is a flag tick for the agents (decision 97): with it the agent starts,
// steers, lists and archives subagents. A workspace hides the thing, or withholds Use, where agents must not start
// agents (a child's robot, a session guests may send to).

import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** The subagents: no members of their own; the flag `use` gives the agent the subagent tools. */
export const SubagentsKind = defineThing("harness.subagents", {
	version: 1,
	makers: "plugin",
	stacking: "nearest",
	ticks: { use: { label: messages.message("tickUseSubagents"), for: "agents" } },
	defaultGrants: { agents: ["use"] },
});
