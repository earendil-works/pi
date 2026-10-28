import type { TSchema } from "typebox";
import { type Draft, diffRevisions, type JsonValue, type Op, type Tracker, track } from "./delta/index.ts";
import { ChordError } from "./errors.ts";
import { enqueue, holdPublications } from "./publish.ts";
import { assertValid } from "./schema.ts";
import type { Ctx, Readable, StateEvent } from "./types.ts";

export interface SourceOptions {
	readonly dev: boolean;
	readonly report: (error: unknown) => void;
}

/** Checks that `ctx` may write an object's cells now; throws otherwise. */
export type WriteGuard = (ctx: Ctx) => void;

let sequence = 0;

/** Fans out values and delta events; listener errors are reported, not thrown to the writer. */
class Fanout<T> {
	readonly #values = new Set<(value: T) => void>();
	readonly #events = new Set<(event: StateEvent<T>) => void>();
	readonly #report: (error: unknown) => void;

	constructor(report: (error: unknown) => void) {
		this.#report = report;
	}

	subscribe(listener: (value: T) => void, current: T): () => void {
		this.#values.add(listener);
		this.#call(listener, current);
		return () => this.#values.delete(listener);
	}

	events(listener: (event: StateEvent<T>) => void, current: T): () => void {
		this.#events.add(listener);
		this.#call(listener, { type: "snap", value: current });
		return () => this.#events.delete(listener);
	}

	/**
	 * Queues delivery to the listeners subscribed now. A listener that subscribes later already got this revision in
	 * its snapshot; one that unsubscribes before delivery is skipped.
	 */
	emit(event: StateEvent<T>): void {
		const events = [...this.#events];
		const values = [...this.#values];
		enqueue(() => {
			for (const listener of events) if (this.#events.has(listener)) this.#call(listener, event);
			for (const listener of values) if (this.#values.has(listener)) this.#call(listener, event.value);
		});
	}

	#call<V>(listener: (value: V) => void, value: V): void {
		try {
			listener(value);
		} catch (error) {
			this.#report(error);
		}
	}
}

/**
 * Whether a state source has its value (entry 8): a remote reference's member before its first snapshot has none, and
 * neither has anything derived from or forwarding it. Sources without this symbol always have their value.
 */
export const HYDRATION: unique symbol = Symbol("chord.hydration");

export interface Hydration {
	readonly hydrated: boolean;
	/** Resolves once hydrated; rejects if the source ends first. */
	whenHydrated(): Promise<void>;
}

/** The hydration of a readable, or undefined for a source that always has its value. */
export function hydrationOf(value: unknown): Hydration | undefined {
	if (value === null || typeof value !== "object") return undefined;
	return (value as { readonly [HYDRATION]?: Hydration })[HYDRATION];
}

/** The hydrations of `sources` that are not hydrated yet. */
export const unhydrated = (sources: Iterable<unknown>): Hydration[] =>
	[...sources].map(hydrationOf).filter((hydration): hydration is Hydration => hydration?.hydrated === false);

/** An object-owned state source (cell or derivation). Writes recompute dependents atomically. */
export abstract class Source<T> implements Readable<T> {
	readonly key: string;
	readonly seq = ++sequence;
	readonly dependents = new Set<Derived<unknown>>();
	/** Schemas of remote state members currently exposing this source (checked per write in dev mode). */
	schemas: readonly TSchema[] = [];
	protected readonly options: SourceOptions;
	protected readonly fanout: Fanout<T>;

	constructor(key: string, options: SourceOptions) {
		this.key = key;
		this.options = options;
		this.fanout = new Fanout(options.report);
	}

	abstract get value(): T;

	subscribe(listener: (value: T) => void): () => void {
		return this.fanout.subscribe(listener, this.value);
	}

	events(listener: (event: StateEvent<T>) => void): () => void {
		return this.fanout.events(listener, this.value);
	}

	/** Per-write validation, dev mode only. */
	validate(value: unknown): void {
		if (!this.options.dev) return;
		for (const schema of this.ownSchemas()) assertValid("state", `state ${this.key}`, schema, value);
		for (const schema of this.schemas) assertValid("state", `state ${this.key}`, schema, value);
	}

	protected ownSchemas(): readonly TSchema[] {
		return [];
	}
}

/** The tracker tracks containers, so a cell tracks `{ v: value }` and strips the box from published ops. */
interface Box<T> {
	v: T;
}

function unbox(ops: readonly Op[], value: unknown): Op[] {
	const result: Op[] = [];
	for (const op of ops) {
		if (op[0] === "r" || op[1].length === 0) return [["r", value as JsonValue]];
		const path = op[1].slice(1);
		switch (op[0]) {
			case "p":
				result.push(["p", path, op[2], op[3], op[4]]);
				break;
			case "m":
				result.push(["m", path, op[2]]);
				break;
			default:
				// s/d/a/t on the value itself replace it.
				if (path.length === 0) return [["r", value as JsonValue]];
				if (op[0] === "d") result.push(["d", path as [string | number, ...(string | number)[]]]);
				else result.push([op[0], path as [string | number, ...(string | number)[]], op[2]] as Op);
		}
	}
	return result;
}

/** A state cell holding any JSON value, validated against its schema at creation and (dev mode) on writes. */
export class Cell<T> extends Source<T> {
	/** Replaced at a reload commit that changes the schema (state-version bump). */
	schema: TSchema;
	#tracker: Tracker<Box<T>>;
	readonly #guard: WriteGuard;
	/** False until `initialize` for a cell declared with `init`: reads and writes throw `not_ready`. */
	#initialized: boolean;

	/**
	 * `initial` is always validated against `schema`; ownership moves to the cell. Without `initial`, the cell has no
	 * value until `initialize` (a cell declared with `init`, filled before its object goes live).
	 */
	constructor(
		key: string,
		schema: TSchema,
		initial: { readonly value: T } | undefined,
		guard: WriteGuard,
		options: SourceOptions,
	) {
		super(key, options);
		if (initial !== undefined) assertValid("state", `initial value of state ${key}`, schema, initial.value);
		this.schema = schema;
		this.#tracker = track<Box<T>>({ v: (initial?.value ?? null) as T });
		this.#guard = guard;
		this.#initialized = initial !== undefined;
	}

	/** Sets the first value of a cell declared with `init` (validated; ownership moves to the cell). Publishes nothing. */
	initialize(value: T): void {
		if (this.#initialized) throw new Error(`state ${this.key} is already initialized`);
		assertValid("state", `initial value of state ${this.key}`, this.schema, value);
		this.#tracker = track<Box<T>>({ v: value });
		this.#initialized = true;
	}

	protected override ownSchemas(): readonly TSchema[] {
		return [this.schema];
	}

	get value(): T {
		if (!this.#initialized) throw notReady(`state ${this.key} (its init has not run)`);
		return this.#tracker.value.v;
	}

	/**
	 * Mutates a draft (only mutated paths are published), or returns a new value (`n => n + 1`). A returned value is
	 * always validated against the schema. The draft is unusable after `fn` returns.
	 */
	change(ctx: Ctx, fn: (draft: Draft<T>) => T): void;
	change(ctx: Ctx, fn: (draft: Draft<T>) => void): void;
	change(ctx: Ctx, fn: (draft: Draft<T>) => unknown): void {
		this.#guard(ctx);
		if (!this.#initialized) throw notReady(`state ${this.key} (its init has not run)`);
		const change = this.#tracker.beginChange();
		let prepared: ReturnType<typeof change.prepare>;
		try {
			const draft = change.state as Draft<Box<T>>;
			const result: unknown = fn(draft.v as Draft<T>);
			if (result instanceof Promise) throw new TypeError("cell.change callbacks must be synchronous");
			if (result !== undefined) {
				if (result !== draft.v) assertValid("state", `state ${this.key}`, this.schema, result);
				draft.v = result as Draft<T>;
			}
			prepared = change.prepare();
		} catch (error) {
			change.abort();
			throw error;
		}
		this.#publish(prepared, "ops");
	}

	/**
	 * Replaces the whole value. Ownership of `value` moves to the cell: never mutate it afterwards.
	 *
	 * Subscribers get a structural diff (`diffRevisions`) when `diff` is true, or by default when the new value shares
	 * containers with the old one (a new immutable revision of the same state, e.g. mirrored from another store);
	 * otherwise a single `r` op. The resulting value is the same either way; only the ops differ.
	 */
	replace(ctx: Ctx, value: T, options: { readonly diff?: boolean } = {}): void {
		this.#guard(ctx);
		if (!this.#initialized) throw notReady(`state ${this.key} (its init has not run)`);
		const before = this.value;
		const diff = options.diff ?? sharesStructure(before, value);
		const ops = diff ? diffRevisions(before as JsonValue, value as JsonValue) : undefined;
		this.#publish(this.#tracker.prepareReplace({ v: value }), "ops", true, ops);
	}

	/**
	 * Installs a migrated value and its schema (reload commit). The caller validated the value and the derivations
	 * over it against every schema that will apply, so nothing is checked here. Subscribers receive a reset.
	 */
	reset(value: T, schema: TSchema): void {
		this.schema = schema;
		this.#publish(this.#tracker.prepareReplace({ v: value }), "reset", false);
	}

	/** Adopts this revision and every derived one, then queues all notifications (cell first, then derivations). */
	#publish(
		prepared: ReturnType<Tracker<Box<T>>["prepareReplace"]>,
		type: "ops" | "reset",
		validate = true,
		ops?: readonly Op[],
	): void {
		if (prepared.ops.length === 0 && type === "ops") {
			this.#tracker.adopt(prepared);
			return;
		}
		const value = prepared.value.v;
		let candidates: Map<Derived<unknown>, unknown>;
		try {
			if (validate) this.validate(value);
			candidates = computeDependents(this as Source<unknown>, value, validate);
		} catch (error) {
			prepared.abort();
			throw error;
		}
		holdPublications(() => {
			this.#tracker.adopt(prepared);
			const published = ops !== undefined && ops.length > 0 ? ops : unbox(prepared.ops, value);
			this.fanout.emit(type === "reset" ? { type, value } : { type, ops: published, value });
			for (const [derived, next] of candidates) derived.install(next);
		});
	}
}

/** True if `b` reuses at least one container of `a` at the same key: a new revision of the same state. */
function sharesStructure(a: unknown, b: unknown): boolean {
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || a === b) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	for (const [key, child] of Object.entries(b)) {
		if (child !== null && typeof child === "object" && (a as Record<string, unknown>)[key] === child) return true;
	}
	return false;
}

/** Recomputes every transitive dependent of `changed` against candidate values and validates them. */
function computeDependents(changed: Source<unknown>, value: unknown, validate = true): Map<Derived<unknown>, unknown> {
	const pending = new Set<Derived<unknown>>();
	const visit = (source: Source<unknown>): void => {
		for (const derived of source.dependents) {
			if (pending.has(derived)) continue;
			pending.add(derived);
			visit(derived);
		}
	};
	visit(changed);
	const values = new Map<Readable<unknown>, unknown>([[changed, value]]);
	const result = new Map<Derived<unknown>, unknown>();
	for (const derived of [...pending].sort((a, b) => a.seq - b.seq)) {
		const next = derived.compute((source) => (values.has(source) ? values.get(source) : source.value));
		if (validate) derived.validate(next);
		values.set(derived, next);
		result.set(derived, next);
	}
	return result;
}

export type Sources = readonly Readable<unknown>[];
export type SourceValues<S extends Sources> = { [K in keyof S]: S[K] extends Readable<infer T> ? T : never };

const isReadable = (value: unknown): value is Readable<unknown> =>
	value !== null &&
	typeof value === "object" &&
	typeof (value as Readable<unknown>).subscribe === "function" &&
	"value" in value;

/**
 * A synchronous derivation. Sources are object cells/derivations (recomputed atomically with the write) or other
 * readables such as reference state members (recomputed when they publish). Subscribers receive diffs.
 */
export class Derived<T> extends Source<T> {
	readonly sources: readonly Readable<unknown>[];
	readonly #fn: (...values: never[]) => unknown;
	#value: T;
	#external: (() => void)[] = [];

	constructor(key: string, sources: Sources, fn: (...values: never[]) => unknown, options: SourceOptions) {
		super(key, options);
		this.sources = sources.map((source) => {
			if (!isReadable(source)) throw new TypeError(`derive ${key}: sources must be readables`);
			return source;
		});
		this.#fn = fn;
		this.#value = undefined as T;
	}

	get value(): T {
		return this.#value;
	}

	/** Hydrated once every source is (a derivation over a remote member waits for its snapshot). */
	get [HYDRATION](): Hydration | undefined {
		const pending = unhydrated(this.sources);
		if (pending.length === 0) return undefined;
		return {
			hydrated: false,
			whenHydrated: () => Promise.all(pending.map((hydration) => hydration.whenHydrated())).then(() => {}),
		};
	}

	/**
	 * Computes the first value (or takes it from `precomputed`, a reload's validated dry run) and starts following
	 * the sources (at install, never inside a factory).
	 */
	attach(precomputed?: ReadonlyMap<unknown, unknown>): void {
		this.#value = precomputed?.has(this) ? (precomputed.get(this) as T) : this.compute((source) => source.value);
		for (const source of this.sources) {
			if (source instanceof Source) source.dependents.add(this as Derived<unknown>);
			else this.#external.push(source.subscribe(() => this.refresh()));
		}
	}

	detach(): void {
		for (const source of this.sources)
			if (source instanceof Source) source.dependents.delete(this as Derived<unknown>);
		for (const unsubscribe of this.#external.splice(0)) unsubscribe();
	}

	compute(read: (source: Readable<unknown>) => unknown): T {
		const result: unknown = this.#fn(...(this.sources.map(read) as never[]));
		if (result instanceof Promise) throw new TypeError(`derive ${this.key}: fn must be synchronous`);
		return result as T;
	}

	/** Recomputes and republishes, including dependents. Errors are reported (the source write already happened). */
	refresh(): void {
		try {
			const next = this.compute((source) => source.value);
			const dependents = computeDependents(this as Derived<unknown>, next);
			holdPublications(() => {
				this.install(next);
				for (const [derived, value] of dependents) derived.install(value);
			});
		} catch (error) {
			this.options.report(error);
		}
	}

	install(next: T): void {
		const before = this.#value;
		this.#value = next;
		const ops: Op[] =
			before === undefined || next === undefined
				? [["r", (next ?? null) as JsonValue]]
				: diffRevisions(before as JsonValue, next as JsonValue);
		if (ops.length > 0) this.fanout.emit({ type: "ops", ops, value: next });
	}
}

export const isSource = (value: unknown): value is Cell<unknown> | Derived<unknown> => value instanceof Source;

/** Thrown by placeholders used before activation finished. */
export const notReady = (what: string): ChordError => new ChordError("not_ready", `${what} is not ready`);
