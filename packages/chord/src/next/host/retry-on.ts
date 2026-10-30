// Wake signals (slice 8 §3, D2): `self.retryOn(...sources)`. The object follows each declared source while it lives,
// replaced by each attempt's declaration; a new value of a source wakes it (the object decides what a wake does: a
// retry while failed, remembered while it activates, nothing while live). Failures of a source wake nothing.

import { RegistryValueSource } from "../registries/internal.ts";
import { Constant, type NativeObserver } from "../state/internal.ts";

/** What `retryOn` takes: sources that live independently of the attempt (a registry value; a constant never wakes). */
export type RetrySource = RegistryValueSource | Constant;

/**
 * Checks a `retryOn` source (declaration policy: TypeScript cannot tell a reference's member or this attempt's
 * `writable` from a registry value or a constant).
 */
export function retrySource(source: unknown, label: string): RetrySource {
	if (source instanceof RegistryValueSource || source instanceof Constant) return source;
	throw new Error(`${label}: self.retryOn takes registry values and constants (sources that outlive the attempt)`);
}

/**
 * The wake signals of one object: its subscriptions (one set at a time, the last attempt's declaration) and what its
 * object decides a wake by.
 */
export class RetryWakes {
	/** The attempt a wake arrived during, while it activates: if it fails, it is retried at once. */
	during: object | undefined;
	/**
	 * Set from its object's contributions leaving until that batch delivered: a composition its own leaving made does
	 * not wake it (an object failing live would retry itself without backoff).
	 */
	leaving = false;
	#subscribed: { readonly source: RegistryValueSource; readonly observer: NativeObserver<unknown> }[] = [];

	/** Follows `sources` instead of the previous set; `wake` runs inside the batch of each new value (it only records). */
	replace(sources: readonly RetrySource[], wake: () => void): void {
		this.stop();
		const observer: NativeObserver<unknown> = {
			advance: (call) => {
				if (call.kind === "value") wake();
			},
			end: () => {},
		};
		for (const source of sources) {
			if (!(source instanceof RegistryValueSource)) continue;
			source.subscribe(observer);
			this.#subscribed.push({ source, observer });
		}
	}

	/** Stops following (the object ended, or a new declaration replaces the set). */
	stop(): void {
		for (const { source, observer } of this.#subscribed) source.unsubscribe(observer);
		this.#subscribed = [];
	}
}
