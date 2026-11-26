// The tools plugin's contract: the coding tools (read, write, edit, bash on the machine the agent works on) as a kind
// of thing (`tools.coding`). Made only by its plugin, one thing in Pi; its four ticks are flag ticks for the agents
// (decision 97): people use the tools through the agent, which acts with its own grants. A workspace hides the tools,
// or withholds a tick (Bash in a shared session), where the agents should not have them.

import { defineThing } from "../things/kind.ts";
import { messages } from "./messages.ts";

/** The coding tools: no members of their own; each tick is a flag the agent's harness part reads. */
export const CodingToolsKind = defineThing("tools.coding", {
	version: 1,
	makers: "plugin",
	stacking: "nearest",
	ticks: {
		read: { label: messages.message("tickRead"), for: "agents" },
		write: { label: messages.message("tickWrite"), for: "agents" },
		edit: { label: messages.message("tickEdit"), for: "agents" },
		bash: { label: messages.message("tickBash"), for: "agents" },
	},
	defaultGrants: { agents: ["read", "write", "edit", "bash"] },
});

/** The coding tools held in a workspace: `CodingToolsKind`'s contract. */
export const CodingTools = CodingToolsKind.contract;
