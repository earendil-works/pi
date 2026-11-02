// `linger` and `ref.retry()`: an object that stays warm after its last reference, failed references with `retryAt`,
// a Retry button that skips the backoff, and a broken object renewed by a retry.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/11-linger-and-retry.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { int, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { broken } from "../../../src/next/data/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type RefState } from "../../../src/next/host/index.ts";
import { constant } from "../../../src/next/state/index.ts";

const context = BACKGROUND_CONTEXT;

const Draft = local("example.draft", {
	version: 1,
	params: { conversation: str() },
	members: { text: str(), type: method(obj({ text: str() })) },
});

const Mirror = local("example.mirror", { version: 1, params: { id: int() }, members: { status: str() } });

const DraftDoc = defineState("draft", { schema: obj({ text: str() }), version: 1, initial: () => ({ text: "" }) });

// What the mirror's open finds: nothing configured, then a server that is down, then one that answers.
const remote = { configured: false, up: false };

const facet = defineFacet((host) => {
	// 1. A draft lingers 200 ms after its last reference: a tab that closes and reopens quickly finds its text.
	host.serve(
		Draft,
		({ conversation }, self) => {
			console.log(`  (draft ${conversation} activated)`);
			const doc = self.state(DraftDoc);
			return {
				text: self.derive([doc], ([d]) => d.text),
				type: async ({ text }, ctx) => {
					await doc.change((draft) => {
						draft.text = text;
					}, ctx);
					return null;
				},
			};
		},
		{ linger: 200 },
	);
	host.serve(Mirror, (_, self) => {
		self.open(
			async () => {
				// `broken`: retrying cannot help until someone changes something (no automatic retry).
				if (!remote.configured) throw broken(new Error("no mirror configured"));
				// A plain throw is transient: retried with backoff (1 s, doubling).
				if (!remote.up) throw new Error("mirror unreachable");
				return null;
			},
			() => {},
		);
		return { status: constant("mirroring") };
	});
});

const host = createHost({ onError: (error) => console.log(`  onError: ${error.kind}`) });
await host.load([{ name: "@example/app", facet }], context);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A state for the log: a failure with its kind, when it retries by itself, and its error. */
function describe(state: RefState): string {
	if (state.kind !== "failed") return state.kind;
	const retry = state.retryAt === undefined ? "no automatic retry" : `retries in ${state.retryAt - Date.now()} ms`;
	return `failed, ${state.cause.kind}, ${retry}: ${state.cause.error.message}`;
}

// 2. Linger: release, get again within 200 ms, the same object and its in-memory document.
let draft = await host.get(Draft, { conversation: "c1" }, context);
await draft.type({ text: "hello" }, context);
draft.release();
await wait(100);
draft = await host.get(Draft, { conversation: "c1" }, context);
console.log("within linger:", JSON.stringify(draft.text.value));
draft.release();
await wait(300);
draft = await host.get(Draft, { conversation: "c1" }, context);
console.log("after linger:", JSON.stringify(draft.text.value));
draft.release();

// 3. A held reference follows its object: broken first (no retryAt), so nothing happens by itself.
const mirror = host.hold(Mirror, { id: 1 }, context);
const watch = await mirror.state.watch(context);
watch.start(async (call) => {
	if (call.kind === "value") console.log(`  ref.state → ${describe(call.value)}`);
});
await wait(10);

// 4. The user fixes the configuration and presses Retry: the broken object is renewed and tries again. The server is
// still down: a transient failure, retried automatically at retryAt.
remote.configured = true;
mirror.retry();
await wait(10);

// 5. Retry again (a Retry button): the backoff window is skipped; this time it goes live.
remote.up = true;
mirror.retry();
await wait(10);
console.log("status:", mirror.status.value);

// 6. A retry while live does nothing.
mirror.retry();
await wait(10);
mirror.release();
await host.close(context);
