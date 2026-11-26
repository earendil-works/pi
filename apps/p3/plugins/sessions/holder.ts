// The holding on a session's worker: one reference per thing the session's workspace gives its agent (`AgentThings`),
// held as the worker (the agent), of the kinds with a harness part here (`ThingHarnessParts`), contributed to
// `HeldThings` for the harness. A thing is listed once its reference first went live (its `granted` known). A new map
// whenever a list changes; a kind whose list did not change keeps its array, so the harness rebuilds only the kinds
// whose array is new: a thing given (live) or taken away, its kind's part replaced, a reference granted anew (a
// regrant moves it through loading to live with a new `granted`).

import {
	AgentThings,
	type Context,
	type Contract,
	type FacetHost,
	type Host,
	local,
	type P3Principal,
	type ParamsOf,
	type Reference,
	type TableItem,
} from "@earendil-works/p3/v1";
import { WorkerRuntime } from "@earendil-works/p3/v1/worker";
import {
	type Held,
	type HeldThing,
	HeldThings,
	type ThingHarnessPart,
	ThingHarnessParts,
} from "../things/contract.worker.ts";
import type { ThingKind } from "../things/kind.ts";

/** The holding, once per worker (empty params: it lives as long as the worker's host). */
const SessionHolding = local("sessions.holding", { version: 1, params: {}, members: {} });

/** Serves the holding on `host`: it follows the agent's things and the parts, and contributes `HeldThings`. */
export function serveHolding(host: FacetHost<P3Principal>): void {
	host.serve(SessionHolding, (_params, self) => {
		const runtime = self.registry(WorkerRuntime);
		const parts = self.registry(ThingHarnessParts);
		const agent = self.get(AgentThings, {});
		const held = self.writable<Held>(NOTHING_HELD);
		const holding = self.open(
			async (context) => new Holding(runtime.value.host, runtime.value.session, (value) => held.set(value), context),
			(open) => open.release(),
		);
		self.on(agent.things, ({ value }) => holding.value.sync(value, parts.value));
		self.on(parts, ({ value }) => holding.value.sync(agent.things.value, value));
		self.contribute(HeldThings, held);
		return {};
	});
}

/** What the worker holds before the agent's things arrived. */
const NOTHING_HELD: Held = new Map();

/** A thing the agent gets, as `AgentThings` lists it. */
type Given = { readonly thing: string; readonly kind: string };

/** A watch of a reference's state. */
type StateWatch = Awaited<ReturnType<Reference<Contract>["state"]["watch"]>>;

/**
 * One held thing: its kind (the part's, so a replaced part holds anew), its reference, the grant last seen live
 * (`undefined`: never live yet, so not listed) and the watch of its state.
 */
type Entry = {
	readonly thing: string;
	readonly kind: ThingKind;
	readonly ref: Reference<Contract>;
	readonly held: HeldThing;
	granted: ReadonlySet<unknown> | undefined;
	watch: StateWatch | undefined;
};

/** The references the worker holds as its agent, and the lists it last published per kind. */
class Holding {
	readonly #host: Host<P3Principal>;
	readonly #session: string;
	readonly #publish: (value: Held) => void;
	readonly #context: Context;
	readonly #entries = new Map<string, Entry>();
	/** The things held in `AgentThings`' order: each kind's list keeps it. */
	#order: readonly string[] = [];
	#lists: Held = NOTHING_HELD;
	/** The kinds whose list changed since the last publication. */
	readonly #changed = new Set<string>();
	#released = false;

	constructor(host: Host<P3Principal>, session: string, publish: (value: Held) => void, context: Context) {
		this.#host = host;
		this.#session = session;
		this.#publish = publish;
		this.#context = context;
	}

	/** Holds what `given` names of the kinds with a part in `parts`, releases the rest, and publishes the change. */
	sync(given: readonly Given[], parts: ReadonlyMap<string, TableItem<ThingHarnessPart>>): void {
		const wanted = new Map<string, ThingKind>();
		for (const { thing, kind } of given) {
			const part = parts.get(kind)?.value;
			if (part !== undefined) wanted.set(thing, part.kind);
		}
		for (const entry of this.#entries.values()) if (wanted.get(entry.thing) !== entry.kind) this.#drop(entry);
		for (const [thing, kind] of wanted) if (!this.#entries.has(thing)) this.#hold(thing, kind);
		this.#order = [...wanted.keys()];
		this.#flush();
	}

	/** Releases every reference: the holding's attempt ended. */
	release(): void {
		this.#released = true;
		for (const entry of this.#entries.values()) this.#drop(entry);
	}

	#hold(thing: string, kind: ThingKind): void {
		// The session's workspace is the session's id: the agent holds its things there.
		const workspace = this.#session;
		// Every kind's contract has the things' params (`defineThing` makes it with them); held as the worker's own principal.
		const params = { workspace, thing } as unknown as ParamsOf<Contract>;
		const ref = this.#host.hold(kind.contract, params, this.#context);
		const entry: Entry = { thing, kind, ref, held: { thing, workspace, ref }, granted: undefined, watch: undefined };
		this.#entries.set(thing, entry);
		void this.#follow(entry);
	}

	/** Watches `entry`'s state: live with another `granted` than last seen gives its kind a new list. */
	async #follow(entry: Entry): Promise<void> {
		const watch = await entry.ref.state.watch(this.#context);
		if (this.#entries.get(entry.thing) !== entry) {
			void watch.stop();
			return;
		}
		entry.watch = watch;
		watch.start(async (call) => {
			if (call.kind !== "value" || call.value.kind !== "live" || this.#entries.get(entry.thing) !== entry) return;
			const granted = entry.ref.granted;
			if (granted === entry.granted) return;
			entry.granted = granted;
			this.#changed.add(entry.kind.name);
			this.#flush();
		});
	}

	#drop(entry: Entry): void {
		this.#entries.delete(entry.thing);
		if (entry.granted !== undefined) this.#changed.add(entry.kind.name);
		void entry.watch?.stop();
		entry.ref.release();
	}

	/** Publishes a new map if a kind's list changed: the changed kinds get new arrays, the others keep theirs. */
	#flush(): void {
		if (this.#released || this.#changed.size === 0) return;
		const lists = new Map<string, readonly HeldThing[]>();
		for (const [kind, list] of this.#lists) if (!this.#changed.has(kind)) lists.set(kind, list);
		for (const thing of this.#order) {
			const entry = this.#entries.get(thing)!;
			const kind = entry.kind.name;
			if (entry.granted === undefined || !this.#changed.has(kind)) continue;
			const list = lists.get(kind) as HeldThing[] | undefined;
			if (list === undefined) lists.set(kind, [entry.held]);
			else list.push(entry.held);
		}
		this.#changed.clear();
		this.#lists = lists;
		this.#publish(lists);
	}
}
