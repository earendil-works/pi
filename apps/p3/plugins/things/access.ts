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

import { ChordError, type Context, type FollowObserver, reportError } from "@earendil-works/p3/v1";
import { type Caller, partyKey } from "./contract.ts";
import {
	ABOVE_THE_ROOT,
	type Answer,
	accessHere,
	agentCounts,
	answerOf,
	type Counted,
	type KindsLookup,
	NOBODY,
	ownerAnswer,
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

/** What one commit wrote to: the workspaces and persons whose entries on disk differ now. */
export type Touched = { readonly workspaces: Set<string>; readonly persons: Set<string> };

/** An attached watcher: the answers now, and how to stop. */
export type Attachment = { readonly value: Answers; detach(): void };

/** What a re-read read, before it is taken: entries by workspace and by person. */
type Reread = {
	readonly workspaces: Map<string, WorkspaceEntries | undefined>;
	readonly persons: Map<string, PersonEntries>;
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
	readonly #workspaces = new Map<string, Loaded>();
	readonly #persons = new Map<string, PersonEntries>();
	readonly #views = new Set<View>();
	readonly #viewsAt = new Map<string, Set<View>>();
	readonly #viewsOf = new Map<string, Set<View>>();
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

	/** Whether it still follows the store: once its store object ended, nothing attaches to it any more. */
	get open(): boolean {
		return !this.#closed;
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
		if (this.#closed) return Promise.resolve(undefined);
		return this.#run(async () => {
			if (this.#closed) return undefined;
			if (this.#workspaces.size + this.#persons.size > this.#forgetWhenAbove) this.forgetUnwatched();
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
	 * Runs `transaction`, one commit of the store that says what it wrote to in `touched`, one at a time with every
	 * other operation, then follows it (`changed`); answers what the transaction answers. Its commit and the index's
	 * work are timed apart (`things.store.commit`, `things.access.adopt`).
	 */
	commit<R>(transaction: (touched: Touched) => Promise<R>): Promise<R> {
		return this.#run(async () => {
			const touched: Touched = { workspaces: new Set(), persons: new Set() };
			const started = performance.now();
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
	 * After a commit that wrote `touched`: the loaded entries among them are read again (all of them before any is
	 * taken), the results at and below the touched workspaces dropped, and every view there and of a touched person
	 * asked again; resolves once the changed ones were told.
	 */
	changed(touched: Touched): Promise<void> {
		return this.#run(() => this.#adopt(touched));
	}

	/**
	 * The kinds changed (a plugin loaded, reloaded or removed): every loaded workspace is read again (its grants' ticks
	 * migrate on load, item 91), every result computed again, every view asked.
	 */
	kindsChanged(): Promise<void> {
		return this.#run(async () => {
			const read = await this.#reread(new Set(this.#workspaces.keys()), new Set());
			if (read === undefined) return;
			this.#take(read);
			for (const loaded of this.#workspaces.values()) loaded.access = undefined;
			this.#ask(this.#views);
		});
	}

	/** Drops every workspace with no view at or below it and every person nobody watches as. */
	forgetUnwatched(): void {
		const keep = new Set<string>();
		for (const watched of this.#viewsAt.keys()) {
			for (let at = watched; at !== "" && !keep.has(at); at = this.#workspaces.get(at)?.entries?.parent ?? "") {
				keep.add(at);
			}
		}
		for (const id of this.#workspaces.keys()) if (!keep.has(id)) this.#workspaces.delete(id);
		for (const id of this.#persons.keys()) if (!this.#viewsOf.has(id)) this.#persons.delete(id);
		this.#forgetWhenAbove = this.#workspaces.size + this.#persons.size + this.#keepUnwatched;
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

	/** Follows a commit that wrote `touched` (see `changed`). */
	async #adopt(touched: Touched): Promise<void> {
		if (touched.workspaces.size === 0 && touched.persons.size === 0) return;
		const loaded = new Set([...touched.workspaces].filter((id) => this.#workspaces.has(id)));
		const read = await this.#reread(loaded, touched.persons);
		if (read === undefined) return;
		this.#take(read);
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
	}

	/**
	 * The entries of `workspaces` (and the ancestors not loaded of one made since it was asked about) and of the loaded
	 * ones of `persons`, read again; `undefined` when a read failed, after recovering (nothing of it is taken).
	 */
	async #reread(workspaces: ReadonlySet<string>, persons: ReadonlySet<string>): Promise<Reread | undefined> {
		const read: Reread = { workspaces: new Map(), persons: new Map() };
		try {
			for (const id of workspaces) {
				let entries = await this.#reader.workspace(id, this.#context);
				read.workspaces.set(id, entries);
				while (entries !== undefined && entries.parent !== "" && !this.#workspaces.has(entries.parent)) {
					const parent = entries.parent;
					if (read.workspaces.has(parent)) break;
					entries = await this.#reader.workspace(parent, this.#context);
					read.workspaces.set(parent, entries);
				}
			}
			for (const id of persons) {
				if (this.#persons.has(id)) read.persons.set(id, await this.#reader.person(id, this.#context));
			}
			return read;
		} catch (error) {
			this.#recover(error);
			return undefined;
		}
	}

	/** Takes what `#reread` read: one generation, all of it at once. */
	#take(read: Reread): void {
		for (const [id, entries] of read.workspaces) {
			const loaded = this.#workspaces.get(id);
			if (loaded === undefined) this.#workspaces.set(id, { entries, access: undefined });
			else loaded.entries = entries;
		}
		for (const [id, entries] of read.persons) this.#persons.set(id, entries);
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
		const views = [...this.#views];
		this.#views.clear();
		this.#viewsAt.clear();
		this.#viewsOf.clear();
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
	 * The view's answers now (rule 5): an owner every tick for people of each available thing (item 99), anyone else the
	 * answer of their counted parties. The last answers when nothing differs, and each unchanged thing's answer object
	 * kept.
	 */
	#answers(view: View, context: Context): Answers {
		const access = this.#accessOf(view.workspace, context);
		const { caller } = view;
		const owner = caller.kind === "person" && this.#persons.get(caller.person)?.owner === true;
		const counted = owner ? NOBODY : this.#counted(access, caller);
		const kinds = this.#kinds();
		const last = view.last;
		const answers: Record<string, Answer> = {};
		let same = true;
		let size = 0;
		for (const [thing, given] of access.things) {
			const answer = owner ? ownerAnswer(given.kind, kinds) : answerOf(given, counted);
			if (answer === undefined) continue;
			const before = last[thing];
			if (sameAnswer(before, answer)) answers[thing] = before!;
			else {
				answers[thing] = answer;
				same = false;
			}
			size++;
		}
		return same && size === Object.keys(last).length ? last : answers;
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
		if (own === undefined) loaded.access = ABOVE_THE_ROOT;
		else {
			const above = own.parent === "" ? ABOVE_THE_ROOT : this.#accessOf(own.parent, context);
			loaded.access = accessHere(above, own, this.#kinds());
			context.telemetry.metrics?.counter("things.access.computes").add(1);
		}
		return loaded.access;
	}

	/** Whether loaded workspace `id` is one of `above` or below one (its ancestors are loaded too). */
	#isAtOrBelow(id: string, above: ReadonlySet<string>): boolean {
		if (above.size === 0) return false;
		for (let at = id; at !== ""; at = this.#workspaces.get(at)?.entries?.parent ?? "") if (above.has(at)) return true;
		return false;
	}
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
