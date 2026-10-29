// Watches: follow a state member from its current value through the commits that change it; a busy listener gets
// what changed meanwhile folded into one call; a derive that throws gives a `failed` call, the watch stays open, and
// its next value arrives as a root replacement (it heals on a later change).
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/04-watches.ts
import { BACKGROUND_CONTEXT, withCancel } from "../../../src/context/index.ts";
import { int, local, method, obj } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";

const context = BACKGROUND_CONTEXT;

const Count = defineState("count", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
const Counter = local("example.counter", {
	version: 1,
	params: {},
	members: { count: obj({ n: int() }), double: int(), half: int(), bump: method(), reset: method() },
});

const facet = defineFacet((host) => {
	host.serve(Counter, (_, self) => {
		const count = self.state(Count);
		return {
			count,
			double: self.derive([count], ([c]) => c.n * 2),
			half: self.derive([count], ([c]) => {
				if (c.n % 2 === 1) throw new Error(`${c.n} has no half`);
				return c.n / 2;
			}),
			bump: async (ctx) => {
				await count.change((draft) => {
					draft.n++;
				}, ctx);
				return null;
			},
			reset: async (ctx) => {
				await count.retire(ctx);
				return null;
			},
		};
	});
});

// A derive whose compute throws is reported once per failure episode (`derive_failed`).
const host = createHost({
	onError: (error) => {
		if (error.kind === "derive_failed") console.log(`reported: ${error.object}.${error.member}: ${error.error}`);
		else console.error("background error:", error);
	},
});
await host.load([{ name: "@example/counter", facet }], context);
const counter = await host.get(Counter, {}, context);

// A watch holds the value at acquisition; its listener then gets the changes, asynchronously and in order, never
// overlapping itself. A listener that keeps up gets one call per commit: the new value and the ops that turn the
// previous value into it.
const watch = await counter.count.watch(context);
console.log("acquired:", watch.value);
watch.start(async (call) => {
	if (call.kind === "value") console.log("count frame:", call.value, JSON.stringify(call.ops));
});

// A derive's frame carries the diff of its old and new value.
const { context: cancellable, cancel } = withCancel(context);
const doubled = await counter.double.watch(cancellable);
doubled.start(async (call) => {
	if (call.kind === "value") console.log("double frame:", call.value, JSON.stringify(call.ops));
});

// A failing derive: one `failed` call per failure, the watch stays open; the next value replaces the root.
const half = await counter.half.watch(context);
half.start(async (call) => {
	if (call.kind === "failed") console.log("half failed:", (call.error as Error).message);
	else console.log("half frame:", call.value, JSON.stringify(call.ops));
});

// A slow listener: commits made while it is busy fold into its next call, with the newest value and the ops since
// its previous call (an `s` on one path replaces the one before it).
const slow = await counter.count.watch(context);
slow.start(async (call) => {
	if (call.kind !== "value") return;
	console.log("slow frame:", call.value, JSON.stringify(call.ops));
	await new Promise((resolve) => setTimeout(resolve, 20));
});

await counter.bump(context);
await new Promise((resolve) => setTimeout(resolve, 0));
await counter.bump(context);
await counter.bump(context);
await new Promise((resolve) => setTimeout(resolve, 50));
// Retiring the singleton resets it to initial(): watches get a root replacement.
await counter.reset(context);
await new Promise((resolve) => setTimeout(resolve, 50));

// Cancelling the watch's context ends it; stop() ends it too. Releasing the reference ends the watches taken through it.
cancel();
console.log("double watch:", await doubled.closed);
counter.release();
console.log("count watch:", await watch.closed);

await host.close(context);
