// The machine kind, `environments.local`: this device's machine, made in Pi by this plugin at the server's first start
// (SSH machines come as their own kind, made by people). One flag tick, Work here, for agents: an agent's tools run on
// a machine only with it. People are let in with no tick (`@open`), which is what Files and Terminals ask: "this
// machine is available to this person here". Its own file: other plugins name the kind by `MACHINE_KIND` only, since a
// plugin may not bundle the things plugin's kind code from another plugin's file.

import { obj, oneOf, type Static, str } from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { MACHINE_KIND } from "./contract.ts";
import { messages } from "./messages.ts";

/** What a machine is: its name (its thing's) and whether its host answers (this device's always does). */
export const MachineInfo = obj({ name: str(), status: oneOf("ready", "unreachable") });

/** What a machine is (see `MachineInfo`). */
export type MachineInfo = Static<typeof MachineInfo>;

/**
 * This device's machine (`environments.local`): one per Pi, made by this plugin; it may be linked in many workspaces,
 * and every machine reaching a workspace can be worked on (the kind's defaults, `many` and `all`). Work here, a flag
 * tick for agents, lets a session's agent run its tools there. A new link lets everyone here in with no tick and gives
 * the agents Work here; withholding `@open` from a group keeps it out of the machine's files and terminals.
 */
export const MachineKind = defineThing(MACHINE_KIND, {
	version: 1,
	makers: "plugin",
	state: { info: MachineInfo },
	ticks: { work: { label: messages.message("tickWork"), for: "agents" } },
	defaultGrants: { everyone: [], agents: ["work"] },
});

/** One machine held in a workspace: `MachineKind`'s contract. */
export const Machine = MachineKind.contract;
