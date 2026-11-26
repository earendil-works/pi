// The environments plugin's contract: the machines sessions work on, as other plugins name them. A machine is a thing
// of one family kind (kind.ts; its types: `MachineTypes`); a session's location names a machine's thing id and a
// folder on it. This device's machine is the kind's one thing in Pi (`OneThing` with `MACHINE_KIND`). `/v1`
// re-exports this file.

import { arr, obj, remote, Server, type Static, str } from "@earendil-works/p3/v1";

/** The machines' family kind (`MachineKind`, the plugin's own): what `OneThing` names to find this device's machine. */
export const MACHINE_KIND = "environments.machine";

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
 * This device's machine id, for every signed-in caller and every session's worker: the default of a new session's
 * location, and the machine a worker runs tools on, until the machine's harness part replaces that (ERNDL-704).
 */
export const ThisDevice = remote("environments.this-device", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	state: { machine: str() },
});
