// Routines: an object's standing behaviour, declared in its factory. `self.on(source, fn)` reconciles from a value: the
// first call gets the current value (`[["r", value]]`), then one call per change, never overlapping; a call that
// throws is reported (`routine_failed`) and called again with the whole current value after a backoff (1 s doubling to
// 60 s), or at once when the source changes. `self.onLive(fn)` runs once the object is live: a loop with `sleep` is a
// periodic task; its ctx is aborted when the object ends, which `sleep` turns into a rejection, so nothing is left
// running.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/18-routines.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { arr, bool, local, map, method, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, sleep } from "../../../src/next/host/index.ts";

const context = BACKGROUND_CONTEXT;

/** The catalog of sessions: another owner's state, which the forwards reconcile from. */
const Catalog = local("example.catalog", {
	version: 1,
	params: {},
	members: { sessions: map(obj({ archived: bool() })), archive: method(obj({ session: str() })) },
});

/** Port forwards per session; a forward of an archived session must be closed (an invariant across owners, §9). */
const ForwardStore = local("example.forwards", {
	version: 1,
	params: {},
	members: { open: arr(str()), cleanups: arr(str()) },
});

const Sessions = defineState("example.sessions", {
	schema: obj({ sessions: map(obj({ archived: bool() })) }),
	version: 1,
	initial: () => ({ sessions: { s1: { archived: false }, s2: { archived: false } } }),
});

const Forwards = defineState("example.forward-list", {
	schema: obj({ open: arr(str()), cleanups: arr(str()) }),
	version: 1,
	initial: () => ({ open: ["s1", "s2"], cleanups: [] }),
});

const started = Date.now();
const at = () => `${Math.round((Date.now() - started) / 100) / 10}s`;

// 1. The host reports background failures: a routine call that threw arrives as `routine_failed`.
const host = createHost({
	onError: (error) => {
		if (error.kind === "routine_failed") {
			const { kind, position } = error.routine;
			console.log(`  [${at()}] ${error.object} ${kind} #${position} failed: ${(error.error as Error).message}`);
		} else console.error(error);
	},
});

let flaky = true;
const facet = defineFacet((h) => {
	h.serve(Catalog, (_, self) => {
		const doc = self.state(Sessions);
		return {
			sessions: self.derive([doc], ([d]) => d.sessions),
			archive: async ({ session }, ctx) => {
				await doc.change((d) => {
					d.sessions[session] = { archived: true };
				}, ctx);
				return null;
			},
		};
	});
	h.serve(ForwardStore, (_, self) => {
		const forwards = self.state(Forwards);
		const catalog = self.get(Catalog, {});
		// 2. Reconcile: close every forward of an archived session. Idempotent, from the current value; the first close
		// fails once (a flaky remote), and the retry comes with the whole value.
		self.on(catalog.sessions, async ({ value: sessions, ops }, ctx) => {
			console.log(`  [${at()}] on: ${JSON.stringify(ops)}`);
			for (const session of forwards.value.open) {
				if (!sessions[session]?.archived) continue;
				if (flaky) {
					flaky = false;
					throw new Error(`closing the forward of ${session} timed out`);
				}
				await forwards.change((d) => {
					d.open = d.open.filter((open) => open !== session);
				}, ctx);
				console.log(`  [${at()}] closed the forward of ${session}`);
			}
		});
		// 3. A periodic task: a loop with `sleep`, ended by the object's end (the abort rejects `sleep`).
		self.onLive(async (ctx) => {
			for (;;) {
				await sleep(400, ctx);
				await forwards.change((d) => void d.cleanups.push(at()), ctx);
			}
		});
		return {
			open: self.derive([forwards], ([d]) => d.open),
			cleanups: self.derive([forwards], ([d]) => d.cleanups),
		};
	});
});
await host.load([{ name: "@example/forwards", facet }], context);
const store = await host.get(ForwardStore, {}, context);
const catalog = await host.get(Catalog, {}, context);
await sleep(50, context);

// 4. Archive s2: the routine's call throws once, is retried after 1 s with the whole value, and closes the forward.
console.log("archiving s2");
await catalog.archive({ session: "s2" }, context);
await sleep(1_300, context);
console.log("open forwards:", store.open.value);
console.log("periodic cleanups so far:", store.cleanups.value);

// 5. Closing the host aborts the routines: the periodic loop ends in its `sleep`, nothing is reported.
await host.close(context);
console.log("closed; nothing left running");
