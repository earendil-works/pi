// The session's lock in its Durable state (worker): written by the sessions plugin's worker facet from the server's
// `SessionLock`, read by the tool guard and the prompt sections at each use. Absent or null: the session is not locked.
import type { Context } from "@earendil-works/chord/context";
import { type DocumentReader, defineDoc } from "@earendil-works/pi-durable";
import type { SessionLock } from "./session-lock.ts";

export const SessionLockDoc = defineDoc<{ lock: SessionLock | null }>({
	kind: "p2.session-lock",
	version: 1,
	scope: "session",
	initial: () => ({ lock: null }),
	checkpointWhen: () => true,
});

/** The session's lock, or undefined when it is not locked. */
export async function sessionLock(read: DocumentReader, context: Context): Promise<SessionLock | undefined> {
	return (await read.snapshot(SessionLockDoc, context))?.lock ?? undefined;
}
