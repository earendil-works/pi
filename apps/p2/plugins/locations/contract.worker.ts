// Worker-side contracts of the location tools: the Durable document other worker plugins read (the workspace reopens
// its backend when a pending move lands).
import { defineDoc } from "@earendil-works/pi-durable";
import type { Location } from "@p2/app/v1";

/**
 * The main agent's move, waiting for its turn to end (the worker applies it, `worker.ts`), and the last one that
 * failed. Kept on conversation 1 for the session, whichever top-level conversation (the main one or a `/tree` branch)
 * asked for it.
 */
export type LocationMoveState = { pending?: Location; failed?: { to: Location; error: string } };
export const LocationMoveDoc = defineDoc<LocationMoveState>({
	kind: "p2.location-move",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: (_v, _o, { deltasSinceBase }) => deltasSinceBase >= 64,
});
