// Readers of named queries (slice 14 §3.2): what `self.liveQuery`, `self.count` and `self.list` have in common. A
// reader holds the named query and its arguments as the factory gave them (a value, or a watchable the arguments
// follow), opens once the provider is live, and reads again when the provider has another live instance or the
// arguments change: its member shows the previous value until the new read's first run is adopted.

import type { Context } from "../context/index.ts";
import { ChordError, invalid } from "../data/index.ts";
import { canonicalJsonOnly } from "../data/internal.ts";
import type { JsonValue } from "../json.ts";
import { type Batch, type Dependent, type DeriveSource, type FramedSource, Source } from "../state/internal.ts";
import type { LiveTarget } from "../store/shared-read.ts";
import type { NamedQueryHandle, NamedTarget } from "./named-query.ts";

/** The arguments a factory gave a reader: a value, or a watchable the arguments follow. */
export type GivenArguments =
	| { readonly kind: "fixed"; readonly value: JsonValue }
	| { readonly kind: "following"; readonly source: DeriveSource };

/**
 * How opening a reader ended: it has a value; its read has not run yet (a table it reads is being created or
 * migrated: no failure, it runs when the table is ready); it waits on a failure (the provider, its arguments, its
 * first run); or its own code broke.
 */
export type Opened =
	| { readonly kind: "ready" }
	| { readonly kind: "loading" }
	| { readonly kind: "waiting"; readonly error: unknown }
	| { readonly kind: "broken"; readonly error: unknown };

/**
 * What a reader reads through and feeds: a live query, a count, a list. The source that has the reader's value: its
 * attempt follows it while it waits.
 */
export type Reading = FramedSource & {
	/** Reads `target` from now on; resolves once its first run settled (adopted, overtaken or held). */
	read(target: LiveTarget, context: Context): Promise<unknown>;
	/** What it should read cannot be read: the source fails, and nothing read before may heal it. */
	fail(error: unknown, context: Context): void;
	/** Its attempt ended. */
	detach(error: Error): void;
};

/**
 * One reader of an attempt: opened before the attempt goes live, closed at its end. It opens its `reading` once the
 * provider is live, and reads again whenever what it reads moves.
 */
export class Reader {
	readonly #given: GivenQuery;
	readonly #reading: Reading;
	/** Tells its attempt, waiting on it, that what it reads moved before it could read anything. */
	readonly #wake: () => void;
	/** The context its reads run under: its attempt's, set by its first `open`. */
	#context: Context | undefined;
	/** Whether a read was opened: from then on a move reads again, before it only wakes the attempt. */
	#started = false;
	#closed = false;

	constructor(given: GivenQuery, reading: Reading, wake: () => void) {
		this.#given = given;
		this.#reading = reading;
		this.#wake = wake;
	}

	/** The source that changes when the reader gets a value. */
	get source(): FramedSource {
		return this.#reading;
	}

	/**
	 * Opens the read (the provider is live: its attempt's dependencies are) and resolves once its first run settled.
	 * Called again while its attempt waits on it: a reader with a value is ready, one that never read tries again, one
	 * whose run failed waits for its next good run.
	 */
	async open(context: Context): Promise<Opened> {
		if (this.#context === undefined) {
			this.#context = context;
			this.#given.follow(() => this.#moved());
		}
		if (!this.#started) {
			let target: LiveTarget;
			try {
				target = this.#given.target(context);
			} catch (error) {
				// Refused arguments and a throwing builder are the reader's own code (`invalid`, a plain error); a provider
				// or arguments not ready yet are waited for.
				return { kind: isOwnCode(error) ? "broken" : "waiting", error };
			}
			this.#started = true;
			await this.#reading.read(target, context);
		}
		const source = this.#reading;
		if (source.ready) return { kind: "ready" };
		const failure = source.failure;
		return failure === undefined ? { kind: "loading" } : { kind: "waiting", error: failure.error };
	}

	/** Its attempt ended: no commit runs its reads again, its member's reads throw `error`. */
	close(error: Error): void {
		this.#closed = true;
		this.#given.release();
		this.#reading.detach(error);
	}

	/**
	 * What it reads moved: the new read replaces the current one once its first run is adopted. Before its first read
	 * its attempt waits on it and tries again.
	 */
	#moved(): void {
		if (this.#closed) return;
		if (!this.#started) {
			this.#wake();
			return;
		}
		const context = this.#context!;
		let target: LiveTarget;
		try {
			target = this.#given.target(context);
		} catch (error) {
			this.#reading.fail(error, context);
			return;
		}
		// A failure of the run is the member's (a failed member with its last value); nothing awaits it.
		void this.#reading.read(target, context);
	}
}

/** Whether `error` is of the reader's own code: arguments the schema refused, or a builder that threw. */
function isOwnCode(error: unknown): boolean {
	return error instanceof ChordError ? error.code === "invalid" : true;
}

/**
 * A named query with the arguments a factory gave it: what it reads now (`target`), and a call whenever that changes
 * (another live instance of the provider, other arguments by canonical JSON), made after the batch that changed it.
 */
export class GivenQuery implements Dependent {
	readonly handle: NamedQueryHandle;
	readonly #args: GivenArguments;
	readonly #batch: Batch;
	/** The canonical JSON of the arguments read last; `undefined` before the first read and after a failed one. */
	#read: string | undefined;
	#moved: (() => void) | undefined;
	/** The release of its follow of the provider's instances, while it follows (fields, not a closure: 112 B less). */
	#releaseInstance: (() => void) | undefined;
	/** The arguments' source it follows, while it follows. */
	#source: Source | undefined;
	/** Set from an invalidation until the batch's flush compares the arguments. */
	#checking = false;

	constructor(handle: NamedQueryHandle, args: GivenArguments, batch: Batch) {
		this.handle = handle;
		this.#args = args;
		this.#batch = batch;
	}

	/**
	 * What reading the query reads now: the provider's declaration for the arguments' value. Throws while the provider
	 * is not live or the arguments have no value; arguments the provider refuses throw its `invalid/args`.
	 */
	target(context: Context): NamedTarget {
		this.#read = undefined;
		const args = this.#value();
		const target = this.handle.provided().target(args, context);
		this.#read = target.sharing.args;
		return target;
	}

	/** Calls `moved` from now on whenever `target` would read something else, until `release`. */
	follow(moved: () => void): void {
		this.#moved = moved;
		this.#releaseInstance = this.handle.follow(moved);
		const args = this.#args;
		// A constant never changes: only a source is followed.
		const source = args.kind === "following" && args.source instanceof Source ? args.source : undefined;
		source?.dependents.add(this);
		this.#source = source;
	}

	release(): void {
		this.#releaseInstance?.();
		this.#source?.dependents.delete(this);
		this.#releaseInstance = undefined;
		this.#source = undefined;
		this.#moved = undefined;
	}

	/** The arguments' source changed in the current batch: compared once the batch delivered (no compute here). */
	invalidate(): void {
		if (this.#checking) return;
		this.#checking = true;
		this.#batch.flushing((context) => {
			this.#checking = false;
			let now: string | undefined;
			try {
				now = canonicalJsonOnly(this.#value(), context);
			} catch {
				// Arguments that cannot be computed, or are no JSON: the reader tries to read and shows that failure.
				now = undefined;
			}
			if (now === undefined || now !== this.#read) this.#moved?.();
		});
	}

	sourceRetired(): void {}

	/**
	 * The arguments' value. A reader opens before its attempt's natives, followed sources and pinned keys (an attempt
	 * waiting on a read holds none): arguments computed from one have no value then and would get none while the
	 * attempt waits. That is the reader's own code, refused as such, not waited for.
	 */
	#value(): JsonValue {
		const args = this.#args;
		if (args.kind === "fixed") return args.value;
		try {
			return args.source.value;
		} catch (error) {
			if (!(error instanceof ChordError) || error.code !== "not_ready") throw error;
			const rule = "a reader's arguments read references, registries, writables and earlier reads";
			throw invalid(
				"args",
				`query "${this.handle.label}": ${rule}, not a followed source or a native (${error.message})`,
			);
		}
	}
}
