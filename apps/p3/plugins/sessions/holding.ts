// The holding on a session's worker: one reference per thing the session's workspace gives its agent (`AgentThings`),
// held as the worker (the agent), of the kinds with a harness part here (`ThingHarnessParts`), contributed to
// `HeldThings` for the harness, each kind's things nearest last (by depth, then id) and the kinds in the order of
// their first things. `undefined` until every reference of the first sync settled (live, failed or ended), at most
// 4 s, so the harness runs no step against a partial set. A thing is listed while its reference is live. A new map
// whenever a list changes; a kind whose list did not change keeps its array. A kind is published once none of its new
// references is still loading (one publication for 39 things going live), a thing taken away at once. A part replaced
// gives its kind a new array and keeps the references while the contract is the same (a kind's plugin reloaded); a
// reload of this plugin hands over: the old holding keeps its references a while, so calls under way finish.
import {
	type Context,
	type Contract,
	contribute,
	type FacetHost,
	type P3Principal,
	type ParamsOf,
	type RefState,
	reportError,
	type TableItem,
	type Writable,
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
import { AgentThings } from "./contract.ts";

/** Serves the holding on `host`: it follows the agent's things and the parts, and contributes `HeldThings`. */
export function serveHolding(host: FacetHost<P3Principal>): void {
	// Once per worker: it lives as long as the worker's host.
	contribute(host, "sessions.holding", (self) => {
		const runtime = self.registry(WorkerRuntime);
		const parts = self.registry(ThingHarnessParts);
		const agent = self.get(AgentThings, {});
		const held = self.writable<Held | undefined>(undefined);
		const holding = self.open(
			async (context) => new Holding(runtime.value, held, context),
			// A reload hands over (Chord's drain in the background): the next holding holds the same objects at once
			// (they are live here), and the harness keeps the old parts until it published.
			(open, reason) => (reason.kind === "reload" ? open.handOver() : open.release()),
		);
		const sync = (): void => holding.value.sync(agent.things.value, parts.value);
		self.on(agent.things, sync);
		self.on(parts, sync);
		self.contribute(HeldThings, held);
	});
}

/** How long a holding that was reloaded keeps its references: calls under way through them finish meanwhile. */
const HAND_OVER_MS = 5000;

/**
 * How long the first set may take to settle before the holding publishes what has (below the harness's wait for it,
 * 10 s): one thing whose object loads slowly keeps none of the others from the agent; it joins as a change later.
 */
const FIRST_SET_MS = 4000;

/**
 * One held thing: its part (a new one gives its kind a new array), what `HeldThings` lists of it, the grant last seen
 * live (`undefined`: not listed: not live yet, failed or ended), and whether its reference settled once (live, failed
 * or ended) and ended.
 */
type Entry = {
	readonly part: ThingHarnessPart;
	readonly held: HeldThing;
	granted: ReadonlySet<string> | undefined;
	settled: boolean;
	ended: boolean;
};

/** The references the worker holds as its agent, published per kind in `held`. */
class Holding {
	readonly #runtime: WorkerRuntime;
	readonly #held: Writable<Held | undefined>;
	readonly #context: Context;
	/** By thing, in `AgentThings`' order: each kind's list keeps it, and the kinds the order of their first thing. */
	#entries: ReadonlyMap<string, Entry> = new Map();
	/** The kinds whose list changed since their last publication. */
	readonly #changed = new Set<string>();
	/** The kinds that lost a listed thing since their last publication: published at once, loading or not. */
	readonly #lost = new Set<string>();
	/** Publishes the first set as far as it settled once `FIRST_SET_MS` passed; cleared by the holding's end. */
	readonly #bound: ReturnType<typeof setTimeout>;
	#bounded = false;

	constructor(runtime: WorkerRuntime, held: Writable<Held | undefined>, context: Context) {
		this.#runtime = runtime;
		this.#held = held;
		this.#context = context;
		this.#bound = setTimeout(() => {
			this.#bounded = true;
			this.#publish();
		}, FIRST_SET_MS).unref();
	}

	/** Holds what `given` names of the kinds with a part in `parts`, releases the rest, and publishes the change. */
	sync(
		given: readonly { readonly thing: string; readonly kind: string; readonly depth: number }[],
		parts: ReadonlyMap<string, TableItem<ThingHarnessPart>>,
	): void {
		const before = this.#entries;
		const entries = new Map<string, Entry>();
		for (const { thing, kind, depth } of given) {
			const part = parts.get(kind)?.value;
			if (part === undefined) continue;
			const entry = before.get(thing);
			if (entry === undefined || entry.ended || !sameContract(entry.part.kind, part.kind)) {
				entries.set(thing, this.#hold(thing, depth, part));
				this.#changed.add(kind);
			} else if (entry.part !== part || entry.held.depth !== depth) {
				// The same contract (a kind's plugin reloaded) or a link moved: the reference stays, so calls under way go on.
				entries.set(thing, { ...entry, part, held: { ...entry.held, depth } });
				this.#changed.add(kind);
			} else entries.set(thing, entry);
		}
		this.#entries = entries;
		for (const entry of before.values()) {
			if (entries.get(entry.held.thing)?.held.ref === entry.held.ref) continue;
			if (entry.granted !== undefined) {
				this.#lost.add(entry.part.kind.name);
				this.#changed.add(entry.part.kind.name);
			}
			entry.held.ref.release();
		}
		this.#publish();
	}

	/** Releases every reference: the holding's attempt ended. */
	release(): void {
		clearTimeout(this.#bound);
		const entries = this.#entries;
		this.#entries = new Map();
		for (const entry of entries.values()) entry.held.ref.release();
	}

	/** Stops publishing and releases every reference after `HAND_OVER_MS` (the plugin reloaded). */
	handOver(): void {
		clearTimeout(this.#bound);
		const entries = this.#entries;
		this.#entries = new Map();
		setTimeout(() => {
			for (const entry of entries.values()) entry.held.ref.release();
		}, HAND_OVER_MS).unref();
	}

	/** Holds `thing` (linked `depth` above the session) as the worker, of `part`'s kind, and follows its state. */
	#hold(thing: string, depth: number, part: ThingHarnessPart): Entry {
		// The session's workspace is the session's id: the agent holds its things there.
		const workspace = this.#runtime.session;
		// Every kind's contract has the things' params (`defineThing` makes it with them); held as the worker's own principal.
		const params = { workspace, thing } as unknown as ParamsOf<Contract>;
		const ref = this.#runtime.host.hold(part.kind.contract, params, this.#context);
		const entry: Entry = {
			part,
			held: { thing, workspace, depth, ref },
			granted: undefined,
			settled: false,
			ended: false,
		};
		// The watch ends with the reference. Its first value too: a thing another holder here has live is live at once.
		ref.state.watch(this.#context).then(
			(watch) => {
				this.#seen(thing, ref, watch.value);
				watch.start(async (call) => {
					if (call.kind === "value") this.#seen(thing, ref, call.value);
				});
			},
			// Only the holding's end aborts it (its context); anything else is a failure to see.
			(error: unknown) => {
				if (this.#context.abortSignal?.aborted !== true)
					reportError(`sessions: ${thing}'s state`, error, this.#context);
			},
		);
		return entry;
	}

	/** Thing `thing`'s reference `ref` is in `state` now: listed while live (with its `granted`), else not. */
	#seen(thing: string, ref: HeldThing["ref"], state: RefState): void {
		// The entry now: a replaced part keeps the reference in a new entry; a released one is no entry's.
		const entry = this.#entries.get(thing);
		if (entry?.held.ref !== ref || state.kind === "loading") return;
		const kind = entry.part.kind.name;
		const granted = state.kind === "live" ? (ref.granted as ReadonlySet<string>) : undefined;
		entry.settled = true;
		entry.ended = state.kind === "ended";
		if (granted !== entry.granted) {
			if (entry.granted !== undefined && granted === undefined) this.#lost.add(kind);
			entry.granted = granted;
			this.#changed.add(kind);
		}
		this.#publish();
	}

	/**
	 * Publishes a new map once the first sync settled (or `FIRST_SET_MS` passed): each changed kind with no reference
	 * still loading, or one that lost a thing, gets a new array; the others keep the arrays last published.
	 */
	#publish(): void {
		const last = this.#held.value;
		const entries = [...this.#entries.values()];
		if (last === undefined && !this.#bounded && !entries.every((entry) => entry.settled)) return;
		const due = new Set(
			[...this.#changed].filter(
				(kind) =>
					last === undefined ||
					this.#lost.has(kind) ||
					entries.every((entry) => entry.settled || entry.part.kind.name !== kind),
			),
		);
		if (last !== undefined && due.size === 0) return;
		const lists = new Map<string, readonly HeldThing[]>();
		for (const [kind, ofKind] of Map.groupBy(entries, (entry) => entry.part.kind.name)) {
			const list = due.has(kind)
				? ofKind
						.filter((entry) => entry.granted !== undefined)
						.map((entry) => entry.held)
						// Nearest last: the farthest first, then by id (`AgentThings`' order).
						.toSorted((a, b) => b.depth - a.depth)
				: last?.get(kind);
			if (list !== undefined && list.length > 0) lists.set(kind, list);
		}
		for (const kind of due) {
			this.#changed.delete(kind);
			this.#lost.delete(kind);
		}
		this.#held.set(lists);
	}
}

/** Whether two kinds have the same contract (a kind's plugin reloaded makes a new, equal one). */
function sameContract(a: ThingKind, b: ThingKind): boolean {
	return a.contract.name === b.contract.name && a.contract.version === b.contract.version;
}
