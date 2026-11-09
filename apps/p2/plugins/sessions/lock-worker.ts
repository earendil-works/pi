// The session's lock on its worker: followed from the server's `SessionLock` and mirrored into the session's Durable
// state (`SessionLockDoc`), where the tool guard and the prompt read it at each use.
import type { Harness } from "@earendil-works/pi-durable";
import {
	type Context,
	type Ctx,
	expectVariant,
	type FacetHost,
	type SessionLock as Lock,
	local,
	untilAborted,
} from "@p2/app/v1";
import { durableContext } from "@p2/app/v1/node";
import { harnessOf, SessionLockDoc } from "@p2/app/v1/worker";
import { SessionLock } from "./contract.ts";

/** The mirror (worker, host lifetime): no members, a routine. */
const LockMirror = local("p2.session-lock-mirror", { version: 1, params: {}, members: {} });

/** Commits `lock` as the session's lock unless it is that already. */
export async function mirrorLock(durable: Harness, lock: Lock | null, context: Context): Promise<void> {
	const current = (await durable.snapshot(SessionLockDoc, context))?.lock ?? null;
	if (JSON.stringify(current) === JSON.stringify(lock)) return;
	await durable.commit(async (tx) => {
		(await tx.doc(SessionLockDoc)).lock = lock === null ? null : structuredClone(lock);
	}, context);
}

export function serveLockMirror(host: FacetHost): void {
	host.serve(LockMirror, (_params, self) => {
		const harness = harnessOf(self);
		const view = self.get(SessionLock, {});
		self.onLive(async (ctx: Ctx) => {
			const watch = await expectVariant(view, "worker").lock.watch(ctx);
			// One commit at a time, the newest value last.
			let chain = mirrorLock(harness().durable, watch.value, durableContext(ctx)).catch(report);
			watch.start(async (call) => {
				if (call.kind !== "value") return;
				const value = call.value;
				chain = chain.then(() => mirrorLock(harness().durable, value, durableContext(ctx))).catch(report);
			});
			try {
				await untilAborted(ctx);
			} finally {
				await watch.stop();
			}
		});
		return {};
	});
}

const report = (error: unknown): void => console.error("p2 sessions: mirroring the session's lock failed:", error);
