// The access index (data model F; the prototype's `Access`, `/home/badlogic/p3-access-proto/access.ts`, ported onto
// Chord's store): what each workspace somebody asks about ends up with, kept in memory in the things store's object.
// Loaded on demand: the first question about a workspace reads its entries and its ancestors' (five reads each), a
// person their owner flag and groups (two). Computed per workspace from the parent's result, remembered. Never
// patched: after a commit the touched workspaces and persons that are loaded are read again by the same function
// that loaded them, the results at and below them dropped, and the watchers there asked again; only a changed answer
// is told, as a new object (Chord keeps what it is handed and compares by identity first: an answer handed out is
// never changed). Unwatched workspaces and persons are forgotten past a threshold. Everything runs one operation at
// a time, the store's transactions among them (`commit`): a load never sees half of one commit and half of the next,
// and what a commit changed is read again before anything else is asked. A re-read that fails publishes nothing of
// it: the index forgets everything and ends its watchers, which attach again and load what is on disk.

import { ChordError, type Context, type FollowObserver, type JsonValue, reportError } from "@earendil-works/p3/v1";
import { type Caller, partyKey } from "./contract.ts";
import {
	ABOVE_THE_ROOT,
	type Answer,
	accessHere,
	agentCounts,
	answerOf,
	type Counted,
	GONE,
	type KindsLookup,
	type Maker,
	NOBODY,
	type OwnHere,
	ownAnswerOf,
	ownerAnswer,
	ownerOwnAnswer,
	type PersonEntries,
	personCounts,
	sameAnswer,
	type WorkspaceAccess,
	type WorkspaceEntries,
} from "./rules.ts";

/** What a workspace gives a caller: each thing with an answer, by thing id. */
export type Answers = Readonly<Record<string, Answer>>;

/** How the index reads what is on disk: one workspace's entries (`undefined`: none), one person's. */
export type Reader = {
	workspace(id: string, context: Context): Promise<WorkspaceEntries | undefined>;
	person(id: string, context: Context): Promise<PersonEntries>;
};

/**
 * What one commit wrote to: the workspaces and persons whose entries on disk differ now; the things renamed (no access
 * changes); the workspaces whose children changed (a line added or cut under them); the parties put in or taken out
 * somewhere (by key). The last three only decide which probes are asked again.
 */
export type Touched = {
	readonly workspaces: Set<string>;
	readonly persons: Set<string>;
	readonly things: Set<string>;
	readonly lines: Set<string>;
	readonly members: Set<string>;
};

/** An attached watcher: the answers now, and how to stop. */
export type Attachment = { readonly value: Answers; detach(): void };

/** What a probe's computation reads of what is loaded. */
export type Look = {
	/** What loaded workspace `workspace` ends up with (`GONE` for one not loaded or not there). */
	access(workspace: string): WorkspaceAccess;
	/** Loaded workspace `workspace`'s entries (`undefined`: not loaded, or not there). */
	entries(workspace: string): WorkspaceEntries | undefined;
	/** The answer `caller` (a person loaded) gets for `thing` in loaded workspace `workspace`, as admission computes it. */
	answer(workspace: string, thing: string, caller: Caller): Answer | undefined;
	/** Loaded person `person`'s entries (`undefined`: not loaded). */
	person(person: string): PersonEntries | undefined;
};

/** How a probe's computation loads what it reads: a workspace with its ancestors, a person. */
export type Load = {
	workspace(id: string): Promise<void>;
	person(id: string): Promise<void>;
	/** Notes that the value shows these things' names (a rename asks the probe again). */
	things(ids: readonly string[]): void;
	/** Notes that the value depends on where these parties are put in (a member row of one asks it again). */
	parties(keys: readonly string[]): void;
};

/**
 * A value computed over the index, followed (a list of a workspace's contents, a caller's roots). `compute` loads what
 * it reads beyond `workspace`, its ancestors and `caller` (a person), which the index loads for it, and notes the names
 * and parties it shows (`Load`); what it loaded stays loaded while the probe is attached. It is asked again only after
 * a commit that can change it: one that touched a workspace it loaded or one above them, a child line of one of them, a
 * person it loaded, a thing whose name it shows, a party whose member rows it read; and after the kinds changed. Only a
 * value that differs is told.
 */
export type Probe<T extends JsonValue> = {
	readonly workspace: string;
	readonly caller: Caller;
	compute(look: Look, load: Load, context: Context): Promise<T>;
};

/** A probe attached: its value now, and how to stop. */
export type ProbeAttachment<T> = { readonly value: T; detach(): void };

/** One attached probe: what it computes, whom it tells, the value last told, and what its last computation loaded. */
type ProbeView = {
	readonly probe: Probe<JsonValue>;
	readonly observer: FollowObserver<unknown>;
	last: JsonValue;
	workspaces: Set<string>;
	persons: Set<string>;
	things: Set<string>;
	parties: Set<string>;
};

/** A workspace in memory: its entries (`undefined`: it does not exist) and its result once computed. */
type Loaded = { entries: WorkspaceEntries | undefined; access: WorkspaceAccess | undefined };

/** One attached watcher of what a workspace gives a caller (a `Gives`): its observer and the answers last told. */
type View = {
	readonly workspace: string;
	readonly caller: Caller;
	readonly observer: FollowObserver<unknown>;
	last: Answers;
};

/** One op of a followed value's change (Chord's delta op; its module is not part of the API). */
type Op = Extract<Parameters<FollowObserver<unknown>["advance"]>[0], { readonly kind: "value" }>["ops"][number];

/** How many unwatched workspaces and persons are kept before they are forgotten (the prototype's `keepUnwatched`). */
const KEEP_UNWATCHED = 1000;

const NO_ANSWERS: Answers = {};

/** The access index of one store object: `attach` for `Gives`, `commit` for the store's transactions. */
export class AccessIndex {
	readonly #reader: Reader;
	readonly #kinds: () => KindsLookup;
	/** The store attempt's context: what a commit's re-read and a recovery run under, never a caller's. */
	readonly #context: Context;
	readonly #keepUnwatched: number;
	#forgetWhenAbove: number;
	/** How many views there were at the last sweep: once half of them went, the next attach sweeps. */
	#viewsAtSweep = 0;
	readonly #workspaces = new Map<string, Loaded>();
	readonly #persons = new Map<string, PersonEntries>();
	readonly #views = new Set<View>();
	readonly #viewsAt = new Map<string, Set<View>>();
	readonly #viewsOf = new Map<string, Set<View>>();
	readonly #probes = new Set<ProbeView>();
	#queue: Promise<unknown> = Promise.resolve();
	#closed = false;

	/**
	 * An index over `reader`, the kinds read through `kinds` at each computation, its own work after commits under
	 * `context` (the store attempt's).
	 */
	constructor(reader: Reader, kinds: () => KindsLookup, context: Context, keepUnwatched = KEEP_UNWATCHED) {
		this.#reader = reader;
		this.#kinds = kinds;
		this.#context = context;
		this.#keepUnwatched = keepUnwatched;
		this.#forgetWhenAbove = keepUnwatched;
	}

	/**
	 * Whether it still follows the store: once its store attempt is ending (its context aborted, a reload) or ended,
	 * nothing attaches to it any more; a watcher waits for the next attempt's index instead.
	 */
	get open(): boolean {
		return !this.#closed && this.#context.abortSignal?.aborted !== true;
	}

	/**
	 * Attaches `observer` to what `workspace` gives `caller`: loads what that needs, answers the answers now, and
	 * tells the observer each changed value from then on, until `detach`. `undefined` once it closed.
	 */
	attach(
		workspace: string,
		caller: Caller,
		observer: FollowObserver<unknown>,
		context: Context,
	): Promise<Attachment | undefined> {
		if (!this.open) return Promise.resolve(undefined);
		return this.#run(async () => {
			if (!this.open) return undefined;
			// Past the budget, or many views gone since the last sweep (a burst of pins released): forget.
			const loaded = this.#workspaces.size + this.#persons.size;
			if (loaded > this.#forgetWhenAbove || this.#views.size * 2 < this.#viewsAtSweep) this.forgetUnwatched();
			await this.#ensure(workspace, context);
			if (caller.kind === "person") await this.#ensurePerson(caller.person, context);
			// Closed while it loaded: the close's sweep has passed, nothing may attach behind it.
			if (this.#closed) return undefined;
			const view: View = { workspace, caller, observer, last: NO_ANSWERS };
			view.last = this.#answers(view, context);
			this.#views.add(view);
			addTo(this.#viewsAt, workspace, view);
			if (caller.kind === "person") addTo(this.#viewsOf, caller.person, view);
			context.telemetry.metrics?.counter("things.access.attaches").add(1);
			return { value: view.last, detach: () => this.#detach(view) };
		});
	}

	/**
	 * Attaches `observer` to `probe`'s value: loads what it needs, computes it, and tells the observer each changed
	 * value from then on, until `detach`. `undefined` once it closed.
	 */
	probe<T extends JsonValue>(
		probe: Probe<T>,
		observer: FollowObserver<unknown>,
		context: Context,
	): Promise<ProbeAttachment<T> | undefined> {
		if (!this.open) return Promise.resolve(undefined);
		return this.#run(async () => {
			if (!this.open) return undefined;
			const view: ProbeView = {
				probe,
				observer,
				last: null,
				workspaces: new Set(),
				persons: new Set(),
				things: new Set(),
				parties: new Set(),
			};
			view.last = await this.#compute(view, context);
			if (this.#closed) return undefined;
			this.#probes.add(view);
			return { value: view.last as T, detach: () => this.#probes.delete(view) };
		});
	}

	/**
	 * Runs `transaction`, one commit of the store that says what it wrote to in `touched`, one at a time with every
	 * other operation, then follows it: the loaded entries among the touched ones are read again, the results at and
	 * below the touched workspaces dropped, and every view there and of a touched person asked again; answers what the
	 * transaction answers once the changed views were told. Its wait in the queue, its commit and the index's work are
	 * timed apart (`things.store.wait`, `things.store.commit`, `things.access.adopt`).
	 */
	commit<R>(transaction: (touched: Touched) => Promise<R>): Promise<R> {
		const queued = performance.now();
		return this.#run(async () => {
			const touched: Touched = {
				workspaces: new Set(),
				persons: new Set(),
				things: new Set(),
				lines: new Set(),
				members: new Set(),
			};
			const started = performance.now();
			this.#context.telemetry.metrics?.histogram("things.store.wait").record(started - queued);
			const result = await transaction(touched);
			const metrics = this.#context.telemetry.metrics;
			metrics?.histogram("things.store.commit").record(performance.now() - started);
			const adopting = performance.now();
			await this.#adopt(touched);
			metrics?.histogram("things.access.adopt").record(performance.now() - adopting);
			return result;
		});
	}

	/**
	 * The kinds changed (a plugin loaded, reloaded or removed): `install` puts the new kinds in place, inside the queue,
	 * so every operation runs with one snapshot of them; then every loaded workspace is read again (its grants' ticks
	 * migrate on load, item 91), every result computed again, every view asked.
	 */
	kindsChanged(install: () => void): Promise<void> {
		return this.#run(async () => {
			install();
			if (!(await this.#reread(new Set(this.#workspaces.keys()), new Set()))) return;
			for (const loaded of this.#workspaces.values()) loaded.access = undefined;
			this.#ask(this.#views);
			await this.#askProbes(this.#probes);
		});
	}

	/**
	 * The parties present in each of `workspaces` (rule 3), persons hidden there by every route left out (item 106):
	 * loaded as a question loads them, one operation in the queue.
	 */
	parties(workspaces: readonly string[], context: Context): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
		return this.#run(async () => {
			const parties = new Map<string, ReadonlySet<string>>();
			for (const workspace of workspaces) {
				await this.#ensure(workspace, context);
				const { present, hidden } = this.#accessOf(workspace, context);
				parties.set(workspace, hidden.size === 0 ? present : new Set([...present].filter((p) => !hidden.has(p))));
			}
			return parties;
		});
	}

	/** Drops every workspace with no view at or below it and every person nobody watches as. */
	forgetUnwatched(): void {
		const keep = new Set<string>();
		const persons = new Set(this.#viewsOf.keys());
		const watching = [...this.#viewsAt.keys()];
		for (const view of this.#probes) {
			watching.push(...view.workspaces);
			for (const person of view.persons) persons.add(person);
		}
		for (const watched of watching) {
			for (let at = watched; at !== "" && !keep.has(at); at = this.#workspaces.get(at)?.entries?.parent ?? "") {
				keep.add(at);
			}
		}
		for (const id of this.#workspaces.keys()) if (!keep.has(id)) this.#workspaces.delete(id);
		for (const id of this.#persons.keys()) if (!persons.has(id)) this.#persons.delete(id);
		this.#forgetWhenAbove = this.#workspaces.size + this.#persons.size + this.#keepUnwatched;
		this.#viewsAtSweep = this.#views.size;
	}

	/** What is in memory: the loaded workspaces and persons, and the views. */
	loaded(): { readonly workspaces: number; readonly persons: number; readonly views: number } {
		return { workspaces: this.#workspaces.size, persons: this.#persons.size, views: this.#views.size };
	}

	/**
	 * The store object ended: no later commit reaches this index, so every observer is ended `failed` (its `Gives`
	 * attaches again to the index of the store's next attempt) and nothing more is attached.
	 */
	close(): void {
		this.#closed = true;
		this.#endViews(new ChordError({ code: "unavailable", message: "things: the access index closed" }));
	}

	/** Runs `operation` after every one queued before it (a commit too, after the index closed). */
	#run<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(operation);
		// The queue keeps no result: an attachment's answers stay only while a view keeps them.
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** Follows a commit that wrote `touched` (see `commit`); nothing once closed (no view is left to tell). */
	async #adopt(touched: Touched): Promise<void> {
		const nothing =
			touched.workspaces.size === 0 &&
			touched.persons.size === 0 &&
			touched.things.size === 0 &&
			touched.lines.size === 0 &&
			touched.members.size === 0;
		if (this.#closed || nothing) return;
		const loaded = new Set([...touched.workspaces].filter((id) => this.#workspaces.has(id)));
		if (!(await this.#reread(loaded, touched.persons))) return;
		const asked = new Set<View>();
		if (touched.workspaces.size > 0) {
			for (const [id, loaded] of this.#workspaces) {
				if (!this.#isAtOrBelow(id, touched.workspaces)) continue;
				loaded.access = undefined;
				for (const view of this.#viewsAt.get(id) ?? []) asked.add(view);
			}
		}
		for (const id of touched.persons) for (const view of this.#viewsOf.get(id) ?? []) asked.add(view);
		this.#ask(asked);
		const probes = new Set<ProbeView>();
		for (const view of this.#probes) if (this.#concerns(view, touched)) probes.add(view);
		await this.#askProbes(probes);
	}

	/** Whether a commit that wrote `touched` can change `view`'s value (see `Probe`). */
	#concerns(view: ProbeView, touched: Touched): boolean {
		for (const id of touched.persons) if (view.persons.has(id)) return true;
		for (const id of touched.things) if (view.things.has(id)) return true;
		for (const key of touched.members) if (view.parties.has(key)) return true;
		for (const id of touched.lines) if (view.workspaces.has(id)) return true;
		if (touched.workspaces.size === 0) return false;
		for (const id of view.workspaces)
			if (this.#workspaces.has(id) && this.#isAtOrBelow(id, touched.workspaces)) return true;
		for (const id of touched.workspaces) if (view.workspaces.has(id)) return true;
		return false;
	}

	/**
	 * Asks each of `views` again and tells its observer a changed value. A computation that fails (a list past its
	 * bound fails closed, a read failed) ends that probe alone, `failed` (its list's object retries and attaches again):
	 * the index and every other watcher stay as they are (decision 109: only a storage failure fails the store). An
	 * observer that throws is reported.
	 */
	async #askProbes(views: ReadonlySet<ProbeView>): Promise<void> {
		for (const view of views) {
			if (!this.#probes.has(view)) continue;
			let value: JsonValue;
			try {
				value = await this.#compute(view, this.#context);
			} catch (error) {
				this.#probes.delete(view);
				reportError("things: a list over the access index failed; it attaches again", error, this.#context);
				view.observer.end({
					kind: "failed",
					error: new ChordError({ code: "unavailable", message: "things: a list over the access index failed" }),
				});
				continue;
			}
			if (sameJson(view.last, value)) continue;
			view.last = value;
			try {
				// The whole value replaced: a holder over a link applies the ops, so an empty list would change nothing there.
				view.observer.advance({ kind: "value", value, ops: [["r", value]], retired: false }, this.#context);
			} catch (error) {
				reportError("things: a probe's watcher of the access index failed", error, this.#context);
			}
		}
	}

	/**
	 * `view`'s probe's value now: its workspace with its ancestors and its caller (a person) loaded first; what the
	 * computation loads besides is remembered as what the view keeps loaded.
	 */
	async #compute(view: ProbeView, context: Context): Promise<JsonValue> {
		const { workspace, caller } = view.probe;
		const workspaces = new Set<string>();
		const persons = new Set<string>();
		const things = new Set<string>();
		const parties = new Set<string>();
		const load: Load = {
			things: (ids) => {
				for (const id of ids) things.add(id);
			},
			parties: (keys) => {
				for (const key of keys) parties.add(key);
			},
			workspace: (id) => {
				workspaces.add(id);
				return this.#ensure(id, context);
			},
			person: (id) => {
				persons.add(id);
				return this.#ensurePerson(id, context);
			},
		};
		await load.workspace(workspace);
		if (caller.kind === "person") await load.person(caller.person);
		view.workspaces = workspaces;
		view.persons = persons;
		view.things = things;
		view.parties = parties;
		return view.probe.compute(this.#look(context), load, context);
	}

	/** What a probe's computation reads. */
	#look(context: Context): Look {
		return {
			access: (workspace) => (this.#workspaces.has(workspace) ? this.#accessOf(workspace, context) : GONE),
			entries: (workspace) => this.#workspaces.get(workspace)?.entries,
			answer: (workspace, thing, caller) =>
				this.#workspaces.has(workspace) ? this.#answerNow(workspace, thing, caller, context) : undefined,
			person: (person) => this.#persons.get(person),
		};
	}

	/**
	 * Reads the entries of the loaded `workspaces` (with the ancestors of one made since it was asked about) and of the
	 * loaded ones of `persons` again; whether it did. A read that fails recovers, so nothing half read is asked.
	 */
	async #reread(workspaces: ReadonlySet<string>, persons: ReadonlySet<string>): Promise<boolean> {
		try {
			for (const id of workspaces) {
				const loaded = this.#workspaces.get(id);
				if (loaded === undefined) continue;
				loaded.entries = await this.#reader.workspace(id, this.#context);
				await this.#ensure(id, this.#context);
			}
			for (const id of persons) {
				if (this.#persons.has(id)) this.#persons.set(id, await this.#reader.person(id, this.#context));
			}
			return true;
		} catch (error) {
			this.#recover(error);
			return false;
		}
	}

	/**
	 * A re-read failed: what is in memory may be older than the disk, so it is all forgotten and every watcher ended
	 * `failed`; their `Gives` attach again and load what is on disk (admissions fail closed meanwhile).
	 */
	#recover(error: unknown): void {
		reportError("things: the access index could not read a change again; it starts over", error, this.#context);
		this.#workspaces.clear();
		this.#persons.clear();
		this.#forgetWhenAbove = this.#keepUnwatched;
		this.#endViews(new ChordError({ code: "unavailable", message: "things: the access index starts over" }));
	}

	/** Ends every view's observer with `error`; the views go. */
	#endViews(error: ChordError): void {
		const views = [...this.#views, ...this.#probes];
		this.#views.clear();
		this.#viewsAt.clear();
		this.#viewsOf.clear();
		this.#probes.clear();
		for (const view of views) view.observer.end({ kind: "failed", error });
	}

	/** Loads `workspace` and its ancestors, each once. */
	async #ensure(workspace: string, context: Context): Promise<void> {
		for (let at = workspace; at !== ""; ) {
			let loaded = this.#workspaces.get(at);
			if (loaded === undefined) {
				loaded = { entries: await this.#reader.workspace(at, context), access: undefined };
				this.#workspaces.set(at, loaded);
			}
			at = loaded.entries?.parent ?? "";
		}
	}

	/** Loads person `person`, once. */
	async #ensurePerson(person: string, context: Context): Promise<void> {
		if (!this.#persons.has(person)) this.#persons.set(person, await this.#reader.person(person, context));
	}

	/** Stops `view`. */
	#detach(view: View): void {
		if (!this.#views.delete(view)) return;
		removeFrom(this.#viewsAt, view.workspace, view);
		if (view.caller.kind === "person") removeFrom(this.#viewsOf, view.caller.person, view);
	}

	/**
	 * Asks each of `views` again and tells its observer a changed answer; a view detached meanwhile (by another's
	 * observer) is not told, and an observer that throws is reported without keeping the others from being told.
	 */
	#ask(views: ReadonlySet<View>): void {
		for (const view of [...views]) {
			if (!this.#views.has(view)) continue;
			const answers = this.#answers(view, this.#context);
			if (answers === view.last) continue;
			const ops = opsBetween(view.last, answers);
			view.last = answers;
			try {
				view.observer.advance({ kind: "value", value: answers, ops, retired: false }, this.#context);
			} catch (error) {
				reportError("things: a watcher of the access index failed", error, this.#context);
			}
		}
	}

	/**
	 * The answer `caller` gets for `thing` in `workspace` now, loading what that needs (`undefined`: nothing), one at a
	 * time with every other operation: not live (R41, `ThingsStore.answerOf`; linking's check, R9).
	 */
	answer(workspace: string, thing: string, caller: Caller, context: Context): Promise<Answer | undefined> {
		return this.#run(async () => {
			await this.#ensure(workspace, context);
			if (caller.kind === "person") await this.#ensurePerson(caller.person, context);
			return this.#answerNow(workspace, thing, caller, context);
		});
	}

	/** The answer `caller` (a person loaded) gets for `thing` in loaded workspace `workspace` now. */
	#answerNow(workspace: string, thing: string, caller: Caller, context: Context): Answer | undefined {
		const access = this.#accessOf(workspace, context);
		const everything = this.#everything(caller);
		const counted = everything ? NOBODY : this.#counted(access, caller);
		if (access.own?.id === thing) return this.#ownAnswer(workspace, access.own, caller, counted, context);
		const given = access.things.get(thing);
		if (given === undefined) return undefined;
		const kinds = this.#kinds();
		const depth = this.#depths(workspace).get(given.at) ?? 0;
		return everything ? ownerAnswer(given.kind, kinds, depth) : answerOf(given, counted, kinds, depth);
	}

	/** How far above `workspace` (loaded, with its ancestors) each of them is: itself 0, its parent 1, ... */
	#depths(workspace: string): ReadonlyMap<string, number> {
		const depths = new Map<string, number>();
		for (let at = workspace, depth = 0; at !== ""; at = this.#workspaces.get(at)?.entries?.parent ?? "", depth++) {
			depths.set(at, depth);
		}
		return depths;
	}

	/**
	 * The view's answers now (rule 5): an owner (and the server) every tick for people of each available thing (item
	 * 99), anyone else the answer of their counted parties; the workspace's own thing among them (item 88). The last
	 * answers when nothing differs, and each unchanged thing's answer object kept.
	 */
	#answers(view: View, context: Context): Answers {
		const access = this.#accessOf(view.workspace, context);
		const { caller } = view;
		const owner = this.#everything(caller);
		const counted = owner ? NOBODY : this.#counted(access, caller);
		const kinds = this.#kinds();
		const last = view.last;
		const answers: Record<string, Answer> = {};
		const depths = this.#depths(view.workspace);
		// An owner's answer is the same for every thing of a kind linked at one depth: made once per depth and kind.
		const ownerAnswers = new Map<number, Map<string, Answer>>();
		const ownerOf = (kind: string, depth: number) => {
			const atDepth = ownerAnswers.get(depth) ?? new Map<string, Answer>();
			ownerAnswers.set(depth, atDepth);
			const made = atDepth.get(kind);
			if (made !== undefined) return made;
			const answer = ownerAnswer(kind, kinds, depth);
			atDepth.set(kind, answer);
			return answer;
		};
		let same = true;
		let size = 0;
		const put = (thing: string, answer: Answer | undefined) => {
			if (answer === undefined) return;
			const before = last[thing];
			if (sameAnswer(before, answer)) answers[thing] = before!;
			else {
				answers[thing] = answer;
				same = false;
			}
			size++;
		};
		for (const [thing, given] of access.things) {
			const depth = depths.get(given.at) ?? 0;
			put(thing, owner ? ownerOf(given.kind, depth) : answerOf(given, counted, kinds, depth));
		}
		if (access.own !== undefined)
			put(access.own.id, this.#ownAnswer(view.workspace, access.own, caller, counted, context));
		return same && size === Object.keys(last).length ? last : answers;
	}

	/**
	 * `caller`'s answer on workspace `workspace`'s own thing (`own`), `counted` there: an owner's and the server's every
	 * tick for people and every kind people may make, anyone else's as their parties give it; with the workspaces
	 * above it they are present in (item 96).
	 */
	#ownAnswer(workspace: string, own: OwnHere, caller: Caller, counted: Counted, context: Context): Answer | undefined {
		const kinds = this.#kinds();
		const everything = this.#everything(caller);
		const answer = everything ? ownerOwnAnswer(own.kind, kinds) : ownAnswerOf(own, counted, makerOf(caller), kinds);
		if (answer === undefined) return undefined;
		const above: string[] = [];
		for (let at = this.#workspaces.get(workspace)?.entries?.parent ?? ""; at !== ""; ) {
			const access = this.#accessOf(at, context);
			if (everything || this.#counted(access, caller).parties.length > 0) above.push(at);
			at = this.#workspaces.get(at)?.entries?.parent ?? "";
		}
		return { ...answer, above };
	}

	/** Whether `caller` gets everything available (items 78, 99): an owner, or the server (trusted server code). */
	#everything(caller: Caller): boolean {
		return caller.kind === "server" || (caller.kind === "person" && this.#persons.get(caller.person)?.owner === true);
	}

	/** Rule 4: whom `caller` counts as in a workspace with `access`. */
	#counted(access: WorkspaceAccess, caller: Caller): Counted {
		switch (caller.kind) {
			case "person":
				return personCounts(access, partyKey(caller), this.#persons.get(caller.person)!);
			case "agent":
				return agentCounts(access, partyKey(caller));
			case "server":
				return NOBODY;
		}
	}

	/** What workspace `id` (loaded, with its ancestors) ends up with: computed from the parent's, kept. */
	#accessOf(id: string, context: Context): WorkspaceAccess {
		const loaded = this.#workspaces.get(id)!;
		if (loaded.access !== undefined) return loaded.access;
		const own = loaded.entries;
		// A workspace that does not exist, or whose line above is cut (a removal under way), gives nothing.
		if (own === undefined) loaded.access = GONE;
		else {
			const above = own.parent === "" ? ABOVE_THE_ROOT : this.#accessOf(own.parent, context);
			loaded.access = accessHere(above, own, this.#kinds());
			context.telemetry.metrics?.counter("things.access.computes").add(1);
		}
		return loaded.access;
	}

	/** Whether loaded workspace `id` is one of `above` or below one (its ancestors are loaded too). */
	#isAtOrBelow(id: string, above: ReadonlySet<string>): boolean {
		for (let at = id; at !== ""; at = this.#workspaces.get(at)?.entries?.parent ?? "") if (above.has(at)) return true;
		return false;
	}
}

/** Whom `caller` is for the Make ceiling: a session's agent, else a person (the server has every answer anyway). */
function makerOf(caller: Caller): Maker {
	return caller.kind === "agent" ? "agent" : "person";
}

/** The ops that turn `before` into `after`: a thing's answer set, or deleted. */
function opsBetween(before: Answers, after: Answers): Op[] {
	const ops: Op[] = [];
	for (const thing of Object.keys(before)) if (after[thing] === undefined) ops.push(["d", [thing]]);
	for (const [thing, answer] of Object.entries(after)) if (before[thing] !== answer) ops.push(["s", [thing], answer]);
	return ops;
}

function addTo<T>(sets: Map<string, Set<T>>, key: string, value: T): void {
	const set = sets.get(key) ?? new Set<T>();
	sets.set(key, set.add(value));
}

function removeFrom<T>(sets: Map<string, Set<T>>, key: string, value: T): void {
	const set = sets.get(key);
	if (set?.delete(value) && set.size === 0) sets.delete(key);
}

/** Whether two JSON values are the same, field by field. */
function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
	const keys = Object.keys(a);
	if (Array.isArray(b) || keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
