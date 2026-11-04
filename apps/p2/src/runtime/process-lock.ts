// One process per name (Node): Chord's process lock, taken or refused. Chord's lock waits while another process holds
// it; p2's servers refuse instead (one server per data directory), after waiting `waitMs` for a holder that is exiting.
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { processLock } from "@earendil-works/chord/workers";

/** Takes the lock `name`, or rejects when another process still holds it after `waitMs`; resolves with its release. */
export async function takeProcessLock(name: string, waitMs = 0): Promise<() => Promise<void>> {
	const lock = await processLock(
		name,
		withAbortSignal(AbortSignal.timeout(Math.max(waitMs, 1)), BACKGROUND_CONTEXT),
	).catch((error: unknown) => {
		throw new Error(`${name} is held by another process`, { cause: error });
	});
	return () => lock.release();
}
