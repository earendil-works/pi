// The Session's writer: commits the mutation line admitted, stored in batches off the line and published in line order.
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import { SessionFailed } from "../errors.ts";
import type { CommitResult, Seq, StorageWrite } from "../types.ts";

/** A part's own failure at publication: memory could not adopt it, or one of the Session's own observers threw. */
export type PublishFailure = { readonly kind: "adoption" | "listener"; readonly error: unknown };

/** One logical commit the line admitted: stored (`writes`, never empty), or held in memory only (no `writes`). */
export type PartSpec = {
	/** Line index of the job that admitted it: a failure it causes makes only later jobs' outcomes `SessionFailed`. */
	readonly index: number;
	readonly writes: readonly StorageWrite[] | undefined;
	/** Keys it writes: a read of one waits for its publication. */
	readonly keys: readonly string[];
	readonly context: Context;
	/** Publish it in memory, in line order, once it is durable (with its seq) or, held, once the parts before it are. */
	readonly publish: (seq: Seq | undefined) => PublishFailure | undefined;
	/** It will never be published: abort what it prepared. */
	readonly discard: () => void;
};

/** An admitted part and its outcome. */
export type Part = PartSpec & {
	/**
	 * Resolves once it is published; rejects once it never will be, and also after publication when its storage call
	 * rejected or the Session failed meanwhile. Always handled, so a part nobody awaits rejects silently.
	 */
	readonly outcome: Promise<void>;
};

type Admitted = Part & {
	readonly settle: { resolve(): void; reject(error: unknown): void };
	/** Set once its outcome is settled. */
	done: boolean;
	/** Opens once it is published or never will be; never rejects. */
	readonly gate: PromiseWithResolvers<void>;
};

/** How a part that will not resolve settles: with an error of its own, which may be any value, or `SessionFailed`. */
type FailedOutcome = { readonly kind: "own"; readonly error: unknown } | { readonly kind: "failed" };

const SESSION_FAILED: FailedOutcome = { kind: "failed" };

/** What the writer needs of its Session. */
export type WriterHost = {
	commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		context: Context,
	): Promise<CommitResult>;
	/** Apply a stored batch to the Session's read caches, right before it is published. */
	stored(writes: readonly StorageWrite[]): void;
	/**
	 * Run one part's publication inside the Storage's own scope (`Storage.publishing`); `undefined` when it ran at once,
	 * else settles once it ran.
	 */
	publishing(publish: () => void, context: Context): Promise<void> | undefined;
	/** The Session's failure, if it failed. */
	failure(): { readonly error: unknown } | undefined;
	/**
	 * Fail the Session; `at` is the line index of the first job whose outcome the failure is, and `own` the jobs after it
	 * whose outcome is still their own error (the other parts of a call that rejected), not `SessionFailed`.
	 */
	fail(error: unknown, at: number, own: readonly number[]): void;
	/** Report an own observer's throw that cannot fail the Session, as it fails with a storage error. */
	report(error: unknown, context: Context): void;
};

/**
 * The writer of one Session. The line admits each commit as a part once its callback and settlement succeeded; the
 * writer sends every part admitted while no call is in flight as one `commit()` call, off the line, and publishes
 * the parts of a call one by one, in line order, with a macrotask between two, so the continuations of the waits one
 * resolves start before the next is published. Held commits are parts without writes, published when the parts before
 * them are.
 *
 * Each part registers the keys it writes; until it is published, it is the newest unpublished writer of each, and a
 * job that touches one waits for its gate. A key leaves when its newest writer is published, so the map holds one entry
 * per key with an unpublished writer.
 */
export class Writer {
	readonly #host: WriterHost;
	/** Admitted parts not yet sent, in line order. */
	#queue: Admitted[] = [];
	#flight = false;
	/** Per key, the newest unpublished part that writes it. */
	readonly #unpublished = new Map<string, Admitted>();
	/** The newest admitted part that is not yet published, whose gate opens after every earlier one's. */
	#newest: Admitted | undefined;

	constructor(host: WriterHost) {
		this.#host = host;
	}

	/** Admit a part: register its keys, queue it, and send it at once unless a call is in flight. */
	admit(spec: PartSpec): Part {
		const outcome = Promise.withResolvers<void>();
		outcome.promise.catch(() => {});
		const part: Admitted = {
			...spec,
			outcome: outcome.promise,
			settle: {
				resolve: () => {
					part.done = true;
					outcome.resolve();
				},
				reject: (error) => {
					part.done = true;
					outcome.reject(error);
				},
			},
			done: false,
			gate: Promise.withResolvers<void>(),
		};
		for (const key of spec.keys) this.#unpublished.set(key, part);
		this.#newest = part;
		this.#queue.push(part);
		this.#pump();
		return part;
	}

	/** The gate of the newest unpublished writer of `key`, or `undefined` when it has none. */
	gate(key: string): Promise<void> | undefined {
		return this.#unpublished.get(key)?.gate.promise;
	}

	/** Opens once every part admitted so far is published or never will be. */
	drained(): Promise<void> | undefined {
		return this.#newest?.gate.promise;
	}

	/** Keys with an unpublished writer, for tests that bound memory. */
	get unpublished(): number {
		return this.#unpublished.size;
	}

	#pump(): void {
		if (this.#flight || this.#queue.length === 0) return;
		this.#flight = true;
		const parts = this.#queue;
		this.#queue = [];
		void this.#flush(parts);
	}

	/**
	 * Send and publish `parts`, then what was admitted meanwhile. Never rejects: a throw the writer did not expect fails
	 * the Session and settles the parts (`#abandon()`), so no outcome or gate is stranded.
	 */
	async #flush(parts: readonly Admitted[]): Promise<void> {
		try {
			await this.#send(parts);
		} catch (error) {
			this.#abandon(parts, error);
		}
		this.#flight = false;
		this.#pump();
	}

	/** Store `parts` in one call, then publish them in order; settles every one of them. */
	async #send(parts: readonly Admitted[]): Promise<void> {
		const stored = parts.filter((part) => part.writes !== undefined);
		const seqs: (Seq | undefined)[] = [];
		let result: CommitResult | undefined;
		let rejected: { readonly error: unknown } | undefined;
		const failed = this.#host.failure();
		if (failed !== undefined) {
			for (const part of parts) this.#unpublish(part, new SessionFailed(failed.error));
			return;
		}
		if (stored.length > 0) {
			try {
				result = await this.#host.commit(
					stored.map((part) => part.writes!),
					(index, seq) => {
						seqs[index] = seq;
					},
					withoutAbortSignal(stored[0]!.context),
				);
			} catch (error) {
				rejected = { error };
			}
		}
		// A call that settles once another failure failed the Session reports `SessionFailed` with that first error,
		// whatever it returned (spec §10.1), and publishes nothing.
		const failedMeanwhile = this.#host.failure();
		if (failedMeanwhile !== undefined) {
			for (const part of parts) this.#unpublish(part, new SessionFailed(failedMeanwhile.error));
			return;
		}
		await this.#publish(parts, seqs, result, rejected);
	}

	/**
	 * Publish the received parts and held ones in order, a macrotask apart, and settle every part (group commit §3.4). A
	 * refusal, a rejection, or a part whose adoption or own observer throws fails the Session once the parts before it
	 * are published and the host observers got the last one; the parts after it are not published, and reject with
	 * `SessionFailed`. What the failure decides (the outcomes, and the gates of the parts it concerns) is settled only
	 * once the Session failed, so no job waiting at such a gate, and no later outcome, goes on as if it had not.
	 */
	async #publish(
		parts: readonly Admitted[],
		seqs: readonly (Seq | undefined)[],
		result: CommitResult | undefined,
		rejected: { readonly error: unknown } | undefined,
	): Promise<void> {
		let stop: { readonly error: unknown; readonly at: number; readonly external?: true } | undefined;
		/**
		 * Settled once the Session failed: each part, whether it was published, and its outcome: an error of its own (any
		 * value, `undefined` included), or `SessionFailed`.
		 */
		const failing: { readonly part: Admitted; readonly outcome: FailedOutcome; readonly published: boolean }[] = [];
		let storedIndex = 0;
		let published = 0;
		for (const part of parts) {
			const index = part.writes === undefined ? undefined : storedIndex++;
			if (stop !== undefined) {
				// A part after a rejected call's last receipt has the call's error; any other part after a stop was not sent,
				// nor any part once something else failed the Session.
				const outcome: FailedOutcome =
					rejected !== undefined && index !== undefined && stop.external !== true
						? { kind: "own", error: rejected.error }
						: SESSION_FAILED;
				failing.push({ part, outcome, published: false });
				continue;
			}
			const seq = index === undefined ? undefined : seqs[index];
			if (index !== undefined && seq === undefined) {
				const error =
					rejected !== undefined
						? rejected.error
						: index === result?.stored && "refused" in result
							? result.refused
							: new Error("Storage committed without adopting the batch");
				failing.push({ part, outcome: { kind: "own", error }, published: false });
				stop = { error, at: part.index };
				continue;
			}
			// A macrotask between two parts: what the first resolves runs before the second is published.
			if (published++ > 0) await hop();
			let failure: PublishFailure | undefined;
			// Failed by something else meanwhile, during the hop or before a storage's scope runs the publication: nothing
			// more of the call is published. Checked right before it would be, after every wait.
			let external: { readonly error: unknown } | undefined;
			const publication = this.#host.publishing(() => {
				external = this.#host.failure();
				if (external !== undefined) return;
				// Its keys leave first, so what its publication schedules sees it published; its waiters wake after it.
				this.#unregister(part);
				// A throw anywhere in it, the read caches included, leaves memory behind what is stored: like an adoption's.
				try {
					if (part.writes !== undefined) this.#host.stored(part.writes);
					failure = part.publish(seq);
				} catch (error) {
					failure = { kind: "adoption", error };
				}
			}, part.context);
			if (publication !== undefined) await publication;
			if (external !== undefined) {
				stop = { error: external.error, at: part.index, external: true };
				failing.push({ part, outcome: SESSION_FAILED, published: false });
				continue;
			}
			if (failure?.kind === "adoption") {
				failing.push({ part, outcome: { kind: "own", error: failure.error }, published: true });
				stop = { error: failure.error, at: part.index };
				continue;
			}
			// A part published while its call rejected is durable but rejects (spec §10.1); an own observer's throw is then
			// reported, as the Session fails with the storage error.
			if (rejected !== undefined) {
				if (failure !== undefined) this.#host.report(failure.error, part.context);
				failing.push({ part, outcome: { kind: "own", error: rejected.error }, published: true });
				continue;
			}
			// An own observer's throw: the commit stands; the Session fails after it.
			if (failure !== undefined) stop = { error: failure.error, at: part.index };
			const failedMeanwhile = this.#host.failure();
			if (failedMeanwhile !== undefined && failure === undefined) {
				part.settle.reject(new SessionFailed(failedMeanwhile.error));
			} else part.settle.resolve();
			this.#open(part);
		}
		if (rejected !== undefined || stop !== undefined) {
			// After the host dispatch of the last part published, which is one microtask away.
			await Promise.resolve();
			// Every part of the call that rejected keeps the storage error; the first of them is the failure's boundary.
			const own = failing.flatMap(({ part, outcome }) => (outcome.kind === "own" ? [part.index] : []));
			if (rejected !== undefined) this.#host.fail(rejected.error, own[0]!, own);
			else this.#host.fail(stop!.error, stop!.at, own);
		}
		for (const { part, outcome, published: stored } of failing) {
			const error = outcome.kind === "own" ? outcome.error : this.#failed(stop!.error);
			if (stored) {
				part.settle.reject(error);
				this.#open(part);
			} else this.#unpublish(part, error);
		}
		// Admitted while this call ran, after the failure: never sent.
		const failure = this.#host.failure();
		if (failure !== undefined) {
			const queued = this.#queue;
			this.#queue = [];
			for (const part of queued) this.#unpublish(part, new SessionFailed(failure.error));
		}
	}

	/**
	 * A throw the writer itself did not expect while sending or publishing `parts` (a bug): fail the Session at the first
	 * of them and settle every one not settled yet, so no outcome, gate, or close waits on it forever.
	 */
	#abandon(parts: readonly Admitted[], error: unknown): void {
		this.#host.fail(error, parts[0]!.index, []);
		for (const part of parts) {
			if (!part.done) this.#unpublish(part, this.#failed(error));
			this.#unregister(part);
			this.#open(part);
		}
	}

	/** `SessionFailed` with the Session's failure, or with `error` until the Session records it. */
	#failed(error: unknown): SessionFailed {
		const failure = this.#host.failure();
		return new SessionFailed(failure !== undefined ? failure.error : error);
	}

	/** Settle a part that will never be published: discard it, reject it with `error`, and open its gate. */
	#unpublish(part: Admitted, error: unknown): void {
		part.discard();
		part.settle.reject(error);
		this.#unregister(part);
		this.#open(part);
	}

	/** Drop the keys a part is still the newest writer of: it is published, or never will be. */
	#unregister(part: Admitted): void {
		for (const key of part.keys) if (this.#unpublished.get(key) === part) this.#unpublished.delete(key);
	}

	/** Open a part's gate: the jobs waiting for it go on. The newest part's opens `drained()` too. */
	#open(part: Admitted): void {
		part.gate.resolve();
		if (this.#newest === part) this.#newest = undefined;
	}
}

/**
 * Yield to the event loop once: `setImmediate` where there is one, otherwise a `MessageChannel` message (Workers,
 * browsers). Microtasks queued before it, such as wait continuations, run first.
 */
function hop(): Promise<void> {
	if (typeof setImmediate === "function") return new Promise((resolve) => setImmediate(resolve));
	const channel = new MessageChannel();
	return new Promise((resolve) => {
		channel.port1.onmessage = () => {
			channel.port1.close();
			resolve();
		};
		channel.port2.postMessage(undefined);
	});
}
