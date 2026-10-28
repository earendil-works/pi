// The batch (W1), one per host: a commit adopts inside it, then every watched value that changed gets one frame, then
// the flushes it collected run (a link sends one message); Chord calls that would reenter it are refused while it runs.

import type { TelemetryMetrics } from "@earendil-works/pi-telemetry";
import type { Context } from "../../context/index.ts";
import { invalid } from "../data/internal.ts";
import type { Source } from "./watchable.ts";

/** What a batch reports: a watch listener that threw, or a frame delivery that threw (a derive's value is no JSON). */
export type BatchError =
	| { readonly kind: "listener_error"; readonly error: unknown }
	| { readonly kind: "delivery_failed"; readonly error: unknown };

/** A host's batch: the reentrancy flag, the watched sources a commit changed, and where background errors go. */
export class Batch {
	/** Reports a throwing watch listener's error (to the host's `onError`); what watches get as their `report`. */
	readonly reportListener: (error: unknown) => void;
	readonly #report: (error: BatchError) => void;
	readonly #metrics: TelemetryMetrics | undefined;
	/** Set while adopting, delivering or computing a derive; one flag per host. */
	#running = false;
	/** The watched sources the current commit changed, each listed once by its `changed`. */
	#changed: Source[] = [];
	/** What runs once the current commit's frames were delivered, each listed once by its `flushing`. */
	#flushes: ((context: Context) => void)[] = [];
	/** Set while the current commit's flushes run (its links send). */
	#sending = false;
	/** Changes `within` deferred while the flushes sent, for the next commit. */
	#later: (() => void)[] = [];
	/** Changes `soon` collected for the commit on the next microtask, while one is queued. */
	#soon: (() => void)[] | undefined;

	constructor(report: (error: BatchError) => void, metrics: TelemetryMetrics | undefined) {
		this.#report = report;
		this.reportListener = (error) => report({ kind: "listener_error", error });
		this.#metrics = metrics;
	}

	/** Whether a commit's adoption, a delivery or a derive compute runs now: a change made now lands in this batch. */
	get running(): boolean {
		return this.#running;
	}

	/** Throws `invalid/reentrant` inside the batch: `operation` may not run during adoptions or derive computes. */
	assertOutside(operation: string): void {
		if (this.#running) throw invalid("reentrant", `${operation} inside a commit or a derive compute`);
	}

	/** Runs `work` with reentrant calls refused; nests (a derive compute inside a commit). */
	run<T>(work: () => T): T {
		const outer = this.#running;
		this.#running = true;
		try {
			return work();
		} finally {
			this.#running = outer;
		}
	}

	/**
	 * Runs one commit's adoptions, then, still synchronously, delivers a frame for every watched value they changed
	 * (watched derives recompute through their reads), then runs the flushes the deliveries listed. A delivery or flush
	 * that throws is reported; the others still run. What `within` deferred while the flushes sent runs as the next
	 * commit, right after.
	 */
	commit(adopt: () => void, context: Context): void {
		this.run(() => {
			try {
				adopt();
				for (const source of this.#changed) {
					try {
						source.deliver(context);
					} catch (error) {
						this.#report({ kind: "delivery_failed", error });
					}
				}
				this.#sending = true;
				for (const flush of this.#flushes) {
					try {
						flush(context);
					} catch (error) {
						this.#report({ kind: "delivery_failed", error });
					}
				}
			} finally {
				this.#sending = false;
				this.#changed = [];
				this.#flushes = [];
			}
		});
		const later = this.#later;
		if (later.length === 0) return;
		this.#later = [];
		this.commit(() => {
			for (const each of later) each();
		}, context);
	}

	/**
	 * Runs `adopt` inside the commit running now, which delivers what it changed; outside one, as a commit of its own;
	 * while a commit's flushes send, as the next commit (a link closing while it sends ends its holds: their departure
	 * lands in the next batch, so one commit stays one message per link and origin). For changes that happen wherever a
	 * reference binds or ends (`host.references`, `host.activity`).
	 */
	within(adopt: () => void, context: Context): void {
		if (this.#sending) this.#later.push(adopt);
		else if (this.#running) adopt();
		else this.commit(adopt, context);
	}

	/**
	 * Runs `adopt` in one commit on the next microtask, together with every other `soon` until then (changes arriving
	 * outside any commit, as a followed runtime's calls off its commit step: one batch for all of them). `context` is
	 * the first one's.
	 */
	soon(adopt: () => void, context: Context): void {
		if (this.#soon !== undefined) {
			this.#soon.push(adopt);
			return;
		}
		const soon = [adopt];
		this.#soon = soon;
		queueMicrotask(() => {
			this.#soon = undefined;
			this.commit(() => {
				for (const each of soon) each();
			}, context);
		});
	}

	/** Lists a watched source the current commit changed. */
	changed(source: Source): void {
		this.#changed.push(source);
	}

	/** Lists `flush` to run at the end of the current commit, after its deliveries (a link sending what they fed it). */
	flushing(flush: (context: Context) => void): void {
		this.#flushes.push(flush);
	}

	/** Counts one unit of derive work on the host's metrics (a lazy read has no context to count through). */
	count(counter: "chord.derive.computes" | "chord.derive.diffs"): void {
		this.#metrics?.counter(counter).add(1);
	}
}
