// A follow over a changing source (ERNDL-1191): `self.follow(over, attach)`. An object follows a view a runtime
// owns (as p3's transcript follows a conversation on the session's harness), and the runtime comes from a registry
// that a reload replaces. Each new runtime is attached again: its holders see one replacement and no failure; a
// runtime that cannot be observed fails the member alone (`follow_failed`), and the next one heals it.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/79-follow-over.ts
import { BACKGROUND_CONTEXT, type Context } from "../../src/context/index.ts";
import { int, local, obj, str } from "../../src/contracts/index.ts";
import { createHost, defineFacet, type FollowObserver, type HostError } from "../../src/host/index.ts";
import { defineRegistry } from "../../src/registries/index.ts";

const context = BACKGROUND_CONTEXT;

type Count = { readonly n: number };

/** A runtime with a synchronous observer of its one view, as Durable's `observeConversation`. */
class Runtime {
	readonly name: string;
	#value: Count;
	readonly #observers = new Set<FollowObserver<Count>>();
	readonly #broken: boolean;

	constructor(name: string, n: number, broken = false) {
		this.name = name;
		this.#value = { n };
		this.#broken = broken;
	}

	async observe(observer: FollowObserver<Count>, _context: Context) {
		if (this.#broken) throw new Error(`${this.name} cannot be observed`);
		this.#observers.add(observer);
		return { value: this.#value, detach: () => void this.#observers.delete(observer) };
	}

	commit(n: number): void {
		this.#value = { n };
		for (const observer of this.#observers) {
			observer.advance({ kind: "value", value: this.#value, ops: [["s", ["n"], n]], retired: false }, context);
		}
	}
}

// 1. The registry gives the runtime open now: `undefined` while there is none (a reload withdraws it first).
const Runtimes = defineRegistry<Runtime | undefined, Runtime | undefined>("example.runtimes", { version: 1 });
const Provider = local("example.follow-provider", { version: 1, params: {}, members: {} });
const Viewer = local("example.follow-viewer", {
	version: 1,
	params: { id: str() },
	members: { view: obj({ n: int() }) },
});

let give: (runtime: Runtime | undefined) => void = () => {};

const facet = defineFacet((host) => {
	host.serve(Runtimes, { compose: (table) => table[0]?.value });
	host.serve(Provider, (_, self) => {
		const given = self.writable<Runtime | undefined>(undefined);
		self.contribute(Runtimes, given);
		give = (runtime) => given.set(runtime);
		return {};
	});
	// 2. The viewer follows the view over the registry: `attach` runs for each runtime given.
	host.serve(Viewer, (_, self) => {
		const runtimes = self.registry(Runtimes);
		self.retryOn(runtimes);
		return { view: self.follow(runtimes, (runtime, observer, ctx) => runtime.observe(observer, ctx)) };
	});
});

const reports: HostError[] = [];
const host = createHost({ onError: (error) => reports.push(error) });
await host.load([{ name: "@example/follow", facet }], context);
const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

const first = new Runtime("first", 1);
give(first);
const viewer = await host.get(Viewer, { id: "1" }, context);
const watch = await viewer.view.watch(context);
watch.start(async (call) => {
	if (call.kind === "failed") console.log("   frame: failed,", (call.error as Error).message);
	else console.log("   frame:", JSON.stringify(call.ops));
});
console.log("2. view:", viewer.view.value);

// 3. The runtime commits: its ops reach the watch.
first.commit(2);
await settled();

// 4. A reload: the old runtime withdrawn, a new one given. One replacement, nothing failed, nothing reported.
give(undefined);
const second = new Runtime("second", 10);
give(second);
await settled();
second.commit(11);
await settled();
console.log("4. view:", viewer.view.value, "| state:", viewer.state.value.kind, "| reports:", reports.length);

// 5. A runtime that cannot be observed: the member fails (one report), the object stays live; the next heals it.
give(new Runtime("third", 20, true));
await settled();
console.log(
	"5. state:",
	viewer.state.value.kind,
	"| reports:",
	reports.map((report) => report.kind),
);
give(new Runtime("fourth", 30));
await settled();
console.log("   view:", viewer.view.value);

await watch.stop();
await host.close(context);
