// The machine kind, `environments.machine`: one family kind for every machine (decision 117), whatever its type (this
// device, made in Pi by this plugin at the server's first start; SSH later), so its tick, defaults, view and harness
// part are written once. One flag tick, Work here, for agents: an agent's tools run on a machine only with it. People
// are let in with no tick (`@open`), which is what Files and Terminals ask: "this machine is available to this person
// here". Its own file: other plugins name the kind by `MACHINE_KIND` only, since a plugin may not bundle the things
// plugin's kind code from another plugin's file.

import { obj, oneOf, type Static, str, unknown } from "@earendil-works/p3/v1";
import { defineThing } from "../things/kind.ts";
import { MACHINE_KIND } from "./contract.ts";
import { messages } from "./messages.ts";

/** What a new machine is made of: its type (a `MachineTypes` entry's name) and that type's settings. */
export const MachineInput = obj({ type: str(), settings: unknown() });

/** What a new machine is made of (see `MachineInput`). */
export type MachineInput = Static<typeof MachineInput>;

/**
 * What a machine is: its name (its thing's), its type, and whether it can be used (`unavailable`: its type is not
 * installed; it comes back when the type does).
 */
export const MachineInfo = obj({ name: str(), type: str(), status: oneOf("ready", "unavailable") });

/** What a machine is (see `MachineInfo`). */
export type MachineInfo = Static<typeof MachineInfo>;

/**
 * A machine (`environments.machine`): made by this plugin (this device's, its one thing; machines people make come
 * with the SSH type), stored with its type and settings (the create hook checks them); it may be linked in many
 * workspaces, and every machine reaching a workspace can be worked on (the kind's defaults, `many` and `all`). Work
 * here, a flag tick for agents, lets a session's agent run its tools there. A new link lets everyone here in with no
 * tick and gives the agents Work here; withholding `@open` from a group keeps it out of the machine's files and
 * terminals.
 */
export const MachineKind = defineThing(MACHINE_KIND, {
	version: 1,
	makers: "plugin",
	// The store checks the input's shape; the create hook checks the settings against the type's schema.
	create: { input: MachineInput },
	state: { info: MachineInfo },
	ticks: { work: { label: messages.message("tickWork"), for: "agents" } },
	// A Read share's guests are let in with no tick (decision 100), so Files and Terminals let them browse and watch.
	defaultGrants: { everyone: [], agents: ["work"], guests: [] },
});

/** One machine held in a workspace: `MachineKind`'s contract. */
export const Machine = MachineKind.contract;
