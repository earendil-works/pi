// The environments plugin's contract: the machines sessions work on, as other plugins name them. A machine is a thing
// of one family kind (kind.ts; its types: `MachineTypes`); a session's location names a machine's thing id and a
// folder on it. This device's machine is the kind's one thing in Pi (`OneThing` with `MACHINE_KIND`). A terminal as
// the machines' terminal host lists it (`TerminalRow`) is here too, so the terminal kind's state (terminals/kind.ts)
// shows the same row. `/v1` re-exports this file.

import { arr, int, nul, obj, remote, Server, type Static, str, union } from "@earendil-works/p3/v1";

/** The machines' family kind (`MachineKind`, the plugin's own): what `OneThing` names to find this device's machine. */
export const MACHINE_KIND = "environments.machine";

/** This device's machine type (`this-device.ts`): the one whose machines a worker runs tools on with Node, there. */
export const THIS_DEVICE_TYPE = "local";

/** A machine as the owner's list shows it: its thing id, its name and its type (a `MachineTypes` entry's name). */
export const Environment = obj({ id: str(), name: str({ max: 200 }), type: str() });

/** A machine as the owner's list shows it (see `Environment`). */
export type Environment = Static<typeof Environment>;

/**
 * The machines, every one (a Pi has a few), for the owner: what a new session's location picks from until a session's
 * location is per conversation (ERNDL-704).
 */
export const Environments = remote("environments.environments", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	// The owner's only (`admitOwner`, the people plugin's; its value `OwnerAdmission`, none).
	admission: obj({}),
	state: { environments: arr(Environment) },
});

/**
 * This device's machine id, for every signed-in caller: where a view opened outside a session works
 * (`useWorkLocation`), and what a test's location names. `""` until the machine was made.
 */
export const ThisDevice = remote("environments.this-device", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	state: { machine: str() },
});

/**
 * A terminal as its machine's terminal host lists it: its id, the machine and folder it started in, and its exit code
 * once its program ended (`null` while it runs; it stays until closed, its output kept). Its size is no part of it: a
 * resize changes no viewer's list.
 */
export const TerminalRow = obj({ id: str(), machine: str(), folder: str(), exitCode: union([int(), nul()]) });

/** A terminal as its machine's terminal host lists it (see `TerminalRow`). */
export type TerminalRow = Static<typeof TerminalRow>;
