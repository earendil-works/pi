// `TuiScope` (slice 11 §4, decision "Slice 11, P9"; p2's `TuiScope`): a terminal component's Chord resources, the
// counterpart of the React bindings for terminal UI libraries. It holds references, follows watchables and registries,
// calls one `changed` callback (the app's redraw) on every change, and releases everything at `dispose`. References
// wait and rebind by themselves (no retry loop, unlike p2's); no terminal library dependency.

import { BACKGROUND_CONTEXT, withAbortSignal } from "../context/index.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import type { Held, Host } from "../host/index.ts";
import type { Registry } from "../registries/index.ts";
import type { NativeWatchable, Watchable } from "../watch.ts";

/** A component's scope: what it holds and follows, until `dispose`. */
export class TuiScope<P extends Principal = Principal> {
	readonly #host: Host<P>;
	readonly #changed: () => void;
	readonly #abort = new AbortController();
	readonly #releases: (() => void)[] = [];

	constructor(host: Host<P>, changed: () => void) {
		this.#host = host;
		this.#changed = changed;
	}

	/** A reference to `Type` with `params`, held until `dispose`; its state changes call `changed`. */
	hold<C extends Contract>(Type: C, params: ParamsOf<C>): Held<C> {
		const held = this.#host.hold(Type, params, this.#context());
		this.#releases.push(() => held.release());
		this.watch(held.state);
		return held;
	}

	/**
	 * Follows `source` (a member, a derive, `ref.state`) until `dispose`: its changes call `changed`. Returns a reader of
	 * its current value (`undefined` while it has none: nothing throws in a redraw).
	 */
	watch<T>(source: Watchable<T> | NativeWatchable<T>): () => T | undefined {
		source.watch(this.#context()).then(
			(watch) => {
				(watch.start as (listener: () => Promise<void>) => void)(async () => {
					if (!this.#abort.signal.aborted) this.#changed();
				});
				// The value it acquired may be newer than what was drawn (a reference bound since): draw it.
				if (!this.#abort.signal.aborted) this.#changed();
			},
			// Disposed (or the source ended) before the watch started: nothing to follow.
			() => {},
		);
		return () => {
			try {
				return source.value;
			} catch {
				return undefined;
			}
		};
	}

	/** Registry `R`'s composed value, followed until `dispose`; a reader, `undefined` until it is usable. */
	registry<C, V>(R: Registry<C, V>): () => V | undefined {
		let read: () => V | undefined = () => undefined;
		this.#host.registry(R, this.#context()).then(
			(value) => {
				read = this.watch(value);
				if (!this.#abort.signal.aborted) this.#changed();
			},
			() => {},
		);
		return () => read();
	}

	/** Releases every reference and ends every watch; `changed` is not called after it. */
	dispose(): void {
		this.#abort.abort();
		for (const release of this.#releases.splice(0)) release();
	}

	/** The context of the scope's work: aborted at `dispose`. */
	#context() {
		return withAbortSignal(this.#abort.signal, BACKGROUND_CONTEXT);
	}
}
