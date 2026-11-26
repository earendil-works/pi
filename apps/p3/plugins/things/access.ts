// The access index (data model F; the prototype's `Access`, `/home/badlogic/p3-access-proto/access.ts`, ported onto
// Chord's store): what each workspace somebody asks about ends up with, kept in memory in the things store's object.
// Loaded on demand: the first question about a workspace reads its entries and its ancestors' (five reads each), a
// person their owner flag and groups (two). Computed per workspace from the parent's result, remembered. Never
// patched: after a commit the touched workspaces and persons that are loaded are read again by the same function
// that loaded them, the results at and below them dropped, and the watchers there asked again; only a changed answer
// is told, as a new object (Chord keeps what it is handed and compares by identity first: an answer handed out is
// never changed). Unwatched workspaces and persons are forgotten past a threshold. Everything it does runs one
// operation at a time, so a load and the re-read after a commit never interleave.

import { ChordError, type Context, type FollowObserver } from "@earendil-works/p3/v1";
import type { Caller } from "./contract.ts";
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

/** A workspace in memory: its entries (`undefined`: it does not exist) and its result once computed. */
type Loaded = { entries: WorkspaceEntries | undefined; access: WorkspaceAccess | undefined };

/** One (workspace, caller) somebody watches: its observers and the answers last told. */
type View = {
	readonly key: string;
	readonly workspace: string;
	readonly caller: Caller;
	readonly observers: Set<FollowObserver<unknown>>;
	last: Answers;
};

/** One op of a followed value's change (Chord's delta op; its module is not part of the API). */
type Op = Extract<Parameters<FollowObserver<unknown>["advance"]>[0], { readonly kind: "value" }>["ops"][number];

/** How many unwatched workspaces are kept before they are forgotten (the prototype's `keepUnwatched`). */
const KEEP_UNWATCHED = 1000;

const NO_ANSWERS: Answers = {};

/** The access index of one store object: `attach` for `Gives`, `changed` after each commit. */
export class AccessIndex {
	readonly #reader: Reader;
	readonly #kinds: () => KindsLookup;
	readonly #keepUnwatched: number;
	#forgetWhenAbove: number;
	readonly #workspaces = new Map<string, Loaded>();
	readonly #persons = new Map<string, PersonEntries>();
	readonly #views = new Map<string, View>();
	readonly #viewsAt = new Map<string, Set<View>>();
	readonly #viewsOf = new Map<string, Set<View>>();
	#queue: Promise<unknown> = Promise.resolve();
	#closed = false;

	/** An index over `reader`, the kinds read through `kinds` at each computation. */
	constructor(reader: Reader, kinds: () => KindsLookup, keepUnwatched = KEEP_UNWATCHED) {
		this.#reader = reader;
		this.#kinds = kinds;
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
			if (this.#workspaces.size > this.#forgetWhenAbove) this.forgetUnwatched();
			await this.#ensure(workspace, context);
			if (caller.kind === "person") await this.#ensurePerson(caller.person, context);
			const view = this.#view(workspace, caller, context);
			view.observers.add(observer);
			context.telemetry.metrics?.counter("things.access.attaches").add(1);
			return { value: view.last, detach: () => this.#detach(view, observer) };
		});
	}

	/**
	 * After a commit that wrote `touched`: the loaded entries among them are read again, the results at and below the
	 * touched workspaces dropped, and every view there and of a touched person asked again; resolves once the changed
	 * ones were told.
	 */
	changed(touched: Touched, context: Context): Promise<void> {
		return this.#run(async () => {
			for (const id of touched.workspaces) {
				const loaded = this.#workspaces.get(id);
				if (loaded === undefined) continue;
				loaded.entries = await this.#reader.workspace(id, context);
				// A workspace made since it was asked about: its ancestors are loaded now.
				await this.#ensure(id, context);
			}
			for (const id of touched.persons) {
				if (this.#persons.has(id)) this.#persons.set(id, await this.#reader.person(id, context));
			}
			const asked = new Set<View>();
			for (const [id, loaded] of this.#workspaces) {
				if (!this.#isAtOrBelow(id, touched.workspaces)) continue;
				loaded.access = undefined;
				for (const view of this.#viewsAt.get(id) ?? []) asked.add(view);
			}
			for (const id of touched.persons) for (const view of this.#viewsOf.get(id) ?? []) asked.add(view);
			this.#ask(asked, context);
		});
	}

	/**
	 * The kinds changed (a plugin loaded, reloaded or removed): every loaded workspace is read again (its grants' ticks
	 * migrate on load, item 91), every result computed again, every view asked.
	 */
	kindsChanged(context: Context): Promise<void> {
		return this.#run(async () => {
			for (const [id, loaded] of this.#workspaces) {
				loaded.entries = await this.#reader.workspace(id, context);
				loaded.access = undefined;
			}
			this.#ask(new Set(this.#views.values()), context);
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
		this.#forgetWhenAbove = this.#workspaces.size + this.#keepUnwatched;
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
		const error = new ChordError({ code: "unavailable", message: "things: the access index closed" });
		for (const view of [...this.#views.values()]) {
			for (const observer of view.observers) observer.end({ kind: "failed", error });
		}
	}

	/** Runs `operation` after every one queued before it. */
	#run<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(() => {
			if (this.#closed) {
				throw new ChordError({ code: "unavailable", message: "things: the access index closed" });
			}
			return operation();
		});
		// The queue keeps no result: an attachment's answers stay only while a view keeps them.
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
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

	/** The view of (`workspace`, `caller`), made with its first answers when nobody watched it. */
	#view(workspace: string, caller: Caller, context: Context): View {
		const key = `${workspace}\n${callerText(caller)}`;
		const found = this.#views.get(key);
		if (found !== undefined) return found;
		const view: View = { key, workspace, caller, observers: new Set(), last: NO_ANSWERS };
		view.last = this.#answers(view, context);
		this.#views.set(key, view);
		addTo(this.#viewsAt, workspace, view);
		if (caller.kind === "person") addTo(this.#viewsOf, caller.person, view);
		return view;
	}

	/** Stops `observer`; the view goes with its last observer. */
	#detach(view: View, observer: FollowObserver<unknown>): void {
		view.observers.delete(observer);
		if (view.observers.size > 0 || this.#views.get(view.key) !== view) return;
		this.#views.delete(view.key);
		removeFrom(this.#viewsAt, view.workspace, view);
		if (view.caller.kind === "person") removeFrom(this.#viewsOf, view.caller.person, view);
	}

	/** Asks each of `views` again (loading what a change made needed) and tells its observers a changed answer. */
	#ask(views: ReadonlySet<View>, context: Context): void {
		for (const view of views) {
			if (this.#views.get(view.key) !== view) continue;
			const answers = this.#answers(view, context);
			if (answers === view.last) continue;
			const ops = opsBetween(view.last, answers);
			view.last = answers;
			for (const observer of [...view.observers]) {
				observer.advance({ kind: "value", value: answers, ops, retired: false }, context);
			}
		}
	}

	/**
	 * The view's answers now (rule 5): an owner every tick for people of each available thing (item 99), anyone else the answer of their
	 * counted parties. The last answers when nothing differs, and each unchanged thing's answer object kept.
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
				return personCounts(access, `person/${caller.person}`, this.#persons.get(caller.person)!);
			case "agent":
				return agentCounts(access, `agent/${caller.session}`);
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

/** A caller's text in a view's key (the views' map is keyed by text: built once per view). */
function callerText(caller: Caller): string {
	switch (caller.kind) {
		case "person":
			return `person/${caller.person}`;
		case "agent":
			return `agent/${caller.session}`;
		case "server":
			return "server";
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
