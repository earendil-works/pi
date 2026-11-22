// The environments plugin's contract: the machines sessions work on, as the owner sees them. This device is made at
// the server's first start; more kinds (SSH, sandboxes) come with their packages. A session's location names one of
// them and a folder on it. `/v1` re-exports this file.

import { arr, nul, obj, oneOf, remote, Server, type Static, str } from "@earendil-works/p3/v1";

/** This device's environment id: the machine the server runs on. */
export const THIS_DEVICE = "this-device";

/** An environment: its id, its name, and its kind (only this device, `local`, for now). */
export const Environment = obj({ id: str(), name: str({ max: 200 }), kind: oneOf("local") });

/** An environment (see `Environment`). */
export type Environment = Static<typeof Environment>;

/** The environments, every one (a Pi has a few), for the owner: what a new session's location picks from. */
export const Environments = remote("environments.environments", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	// The owner's only (`admitOwner`, the people plugin's; its value `OwnerAdmission`, none).
	admission: nul(),
	variants: { owner: { state: { environments: arr(Environment) } } },
});
