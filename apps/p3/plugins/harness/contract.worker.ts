// The harness plugin's contract for worker facets: the open Durable harness for other objects of the worker
// (`SessionHarness`). What the agent gets comes from the things it holds (`ThingHarnessParts` and `HeldThings`, the
// things plugin's `contract.worker.ts`). `/v1/worker` re-exports it.

import { type Context, defineRegistry } from "@earendil-works/p3/v1";
import type { Harness } from "@earendil-works/p3/v1/worker";

/**
 * The session's open Durable harness, contributed once it is open: `durable` for following conversations, and
 * `submit`, the one way to start work, which first applies what the agent holds now (a thing let go of is gone from
 * that submit on) and reports the session `working` before Durable accepts the input (a crash in between leaves it
 * for the waker).
 */
export type OpenHarness = {
	readonly durable: Harness;
	submit(
		conversation: string | undefined,
		input: { readonly text: string; readonly requestId: string },
		context: Context,
	): Promise<void>;
};

/** The open harness (see `OpenHarness`); `undefined` until it is open. */
export const SessionHarness = defineRegistry<OpenHarness, OpenHarness | undefined>("harness.session", { version: 1 });
