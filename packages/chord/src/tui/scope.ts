// `TuiScope` (slice 11 §4, decision "Slice 11, P9"; p2's `TuiScope`): a terminal component's Chord resources, the
// counterpart of the React bindings for terminal UI libraries. It holds references, follows watchables and registries,
// calls one `changed` callback (the app's redraw) on every change, and releases everything at `dispose`. Its page state
// is the host's, shared by every scope (React's `usePageState`): a scope opened again after a plugin reload finds it.
// Its messages render in the host's language, and a change of the locale or a translation redraws.
// References wait and rebind by themselves (no retry loop, unlike p2's); no terminal library dependency.

import { BACKGROUND_CONTEXT, withAbortSignal } from "../context/index.ts";
import type { Contract, ParamsOf } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import type { Held, Host } from "../host/index.ts";
import type { Registry } from "../registries/index.ts";
import { hostLanguage, type Language, type MessageData, type Messages, type Translator } from "../surfaces/index.ts";
import { type PageState, pageState } from "../surfaces/page-state.ts";
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

	/**
	 * The host's page state at `key`, kept for the terminal's life, not the scope's (a new key starts at `initial`); its
	 * changes call `changed` until `dispose`.
	 */
	pageState<T>(key: string, initial: T): PageState<T> {
		const state = pageState(this.#host, key, initial);
		// A closure of its own: two scopes may share one `changed`, and subscribers are a set of functions.
		this.#releases.push(state.subscribe(() => this.#changed()));
		return state;
	}

	/**
	 * `messages` in the host's language as it is at each call (the first catalog before the host follows one); a change
	 * of the locale or a translation calls `changed` until `dispose`.
	 */
	messages<N extends string, M>(messages: Messages<N, M>): Translator<N, M> {
		const language = hostLanguage(this.#host);
		this.#releases.push(language.subscribe(() => this.#changed()));
		let bound: { readonly language: Language | undefined; readonly t: PlainTranslator } | undefined;
		const current = (): PlainTranslator => {
			const now = language.read();
			// A translator's overloads are one function's, keyed by the catalog's shape: called here as that function.
			if (bound === undefined || bound.language !== now) {
				bound = { language: now, t: messages.in(now) as unknown as PlainTranslator };
			}
			return bound.t;
		};
		const t: PlainTranslator = Object.assign((key: string, ...args: unknown[]) => current()(key, ...args), {
			render: (message: MessageData) => current().render(message),
		});
		return t as unknown as Translator<N, M>;
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

/** A translator as the function it is: any key, any arguments. */
type PlainTranslator = ((key: string, ...args: unknown[]) => string) & { render(message: MessageData): string };
