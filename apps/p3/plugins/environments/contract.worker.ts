// The environments plugin's contract for worker facets: `ExecutionEnvironments`, which gives a session's tools the
// environment of its location. `/v1/worker` re-exports it.

import { type Context, defineRegistry } from "@earendil-works/p3/v1";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Location } from "../sessions/contract.ts";

/** The execution environment of `location`, or `undefined` when this contribution does not serve its environment. */
export type EnvironmentResolver = (location: Location, context: Context) => ExecutionEnv | undefined;

/** The resolvers, composed: the first by plugin name that answers a location wins. */
export const ExecutionEnvironments = defineRegistry<EnvironmentResolver, EnvironmentResolver>(
	"environments.execution",
	{ version: 1 },
);
