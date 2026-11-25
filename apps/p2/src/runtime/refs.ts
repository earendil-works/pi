// References as p2's UIs (the TUI, the web) hold them: following a value with its current one first, waiting until a
// reference is live, and releasing a held reference a little later so that coming back to it is instant.

import {
	type Contract,
	forbidden,
	type Reference,
	type RefState,
	type Registry,
	type RegistryValue,
} from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { NativeWatchable, Watchable } from "@earendil-works/chord/watch";

/** What every held reference has: its state (loading, live, failed, ended) and its release. */
export type HeldRef = { readonly state: NativeWatchable<RefState>; release(): void };

/** A held reference to a remote object: also the names its binding granted (grantable members and flags). */
export type GrantedRef = HeldRef & { readonly granted: ReadonlySet<string> };

/**
 * Calls `fn` with `source`'s value (at once when it has one, else once its watch is up), then with each change, until
 * the returned stop. A source that ends (its reference released) only stops calling.
 */
export function follow<T>(source: Watchable<T> | NativeWatchable<T>, fn: (value: T) => void): () => void {
	const abort = new AbortController();
	// The value it has now, at once (a bound member, a registry's value), as a UI renders it before the watch is up.
	let last: { readonly value: T } | undefined;
	try {
		last = { value: source.value };
	} catch {
		// No value yet (a member of a reference not bound): the watch brings the first one.
	}
	if (last) fn(last.value);
	source.watch(withAbortSignal(abort.signal, BACKGROUND_CONTEXT)).then(
		(watch) => {
			if (abort.signal.aborted) return;
			// A watch starts at its value and brings later changes only.
			if (!last || watch.value !== last.value) fn(watch.value as T);
			(watch.start as (listener: (call: { kind: string; value?: unknown }) => Promise<void>) => void)(
				async (call) => {
					if (call.kind === "value" && !abort.signal.aborted) fn(call.value as T);
				},
			);
		},
		() => {},
	);
	return () => abort.abort();
}

/** What `followRegistry` reads registries from: a host. */
type RegistryHost = { registry<C, V>(registry: Registry<C, V>, context: Context): Promise<RegistryValue<V>> };

/** Registry values a host gave `followRegistry`, by host and registry: a later follower starts at once. */
const registryValues = new WeakMap<RegistryHost, Map<Registry<unknown, unknown>, RegistryValue<unknown>>>();

/**
 * Registry `registry`'s composed value on `host` if it was followed before (`followRegistry`): what a UI's first render
 * shows, before its follower starts.
 */
export function knownRegistry<C, V>(host: RegistryHost, registry: Registry<C, V>): V | undefined {
	const known = registryValues.get(host)?.get(registry as Registry<unknown, unknown>) as RegistryValue<V> | undefined;
	return known?.value;
}

/**
 * `follow` for registry `registry`'s composed value on `host`, once the host published it; at once (synchronously)
 * when this host's value of it was followed before.
 */
export function followRegistry<C, V>(host: RegistryHost, registry: Registry<C, V>, fn: (value: V) => void): () => void {
	let values = registryValues.get(host);
	if (!values) {
		values = new Map();
		registryValues.set(host, values);
	}
	const known = values.get(registry as Registry<unknown, unknown>) as RegistryValue<V> | undefined;
	if (known) return follow(known, fn);
	let stopped = false;
	let stop = (): void => {};
	void host.registry(registry, BACKGROUND_CONTEXT).then(
		(value) => {
			values.set(registry as Registry<unknown, unknown>, value as RegistryValue<unknown>);
			if (!stopped) stop = follow(value, fn);
		},
		() => {},
	);
	return () => {
		stopped = true;
		stop();
	};
}

/** `R` with its grantable members `M` there: what `liveWith`, `keptWith` and `withGranted` hand on. */
export type With<R, M extends keyof R> = R & { readonly [K in M]-?: NonNullable<R[K]> };

/** A reference to `C` whose binding granted the members `M`. */
export type RefWith<C extends Contract, M extends keyof Reference<C>> = With<Reference<C>, M>;

/** Whether `ref`'s binding granted every one of `members` (none: always). */
function grants<R extends GrantedRef>(ref: R, members: readonly (keyof R)[]): boolean {
	return members.every((member) => ref.granted.has(member as string));
}

/** `ref` if it is live, else `undefined` (loading, failed, ended). */
export function live<R extends HeldRef>(ref: R | undefined): R | undefined {
	return ref !== undefined && ref.state.value.kind === "live" ? ref : undefined;
}

/** `ref` if it is live and its binding granted every one of `members`, else `undefined`. */
export function liveWith<R extends GrantedRef, const M extends keyof R>(
	ref: R | undefined,
	...members: readonly M[]
): With<R, M> | undefined {
	// The members are there exactly while granted (slice 15 §1.4): TypeScript cannot see the check.
	return live(ref) !== undefined && grants(ref!, members) ? (ref as With<R, M>) : undefined;
}

/**
 * `ref` with `members`, for code that knows its principal is granted them (a worker's `Sessions` has `renameSelf`):
 * throws `forbidden` when its binding did not grant one.
 */
export function expectGranted<R extends GrantedRef, const M extends keyof R>(
	ref: R,
	...members: readonly M[]
): With<R, M> {
	const missing = members.find((member) => !ref.granted.has(member as string));
	if (missing !== undefined) throw forbidden(`not granted ${String(missing)}`);
	// As in `liveWith`.
	return ref as With<R, M>;
}

/**
 * `ref` if it can still bind again (loading, live or failed transiently), else `undefined`. For reads that should
 * outlast a dropped connection: a reference held over a link keeps its members' last values (and what it was granted)
 * while the link is down. Calls need `live`.
 */
export function kept<R extends HeldRef>(ref: R | undefined): R | undefined {
	if (ref === undefined) return undefined;
	const state = ref.state.value;
	if (state.kind === "ended" || (state.kind === "failed" && state.cause.kind === "broken")) return undefined;
	return ref;
}

/** `kept`, for a reference whose last binding granted every one of `members`. */
export function keptWith<R extends GrantedRef, const M extends keyof R>(
	ref: R | undefined,
	...members: readonly M[]
): With<R, M> | undefined {
	// As in `liveWith`.
	return kept(ref) !== undefined && grants(ref!, members) ? (ref as With<R, M>) : undefined;
}

/** The reference's state kind now. */
export const statusOf = (ref: HeldRef): RefState["kind"] => ref.state.value.kind;

/**
 * Resolves once `ref` is live; rejects with the error when it ends or fails broken (asking again cannot help). A
 * transient failure keeps waiting: the reference retries.
 */
export function whenLive(ref: HeldRef): Promise<void> {
	return new Promise((resolve, reject) => {
		const stop = follow(ref.state, (state) => {
			if (state.kind === "live") resolve();
			else if (state.kind === "ended") reject(state.error);
			else if (state.kind === "failed" && state.cause.kind === "broken") reject(state.cause.error);
			else return;
			// Called during `follow` when the state is known at once: `stop` exists only afterwards.
			queueMicrotask(() => stop());
		});
	});
}

/**
 * Calls `action` with `ref`, held for this one call (by a command or a menu row: no view of theirs outlives the call),
 * once it is live, then releases it. Rejects when the reference ends or fails broken.
 */
export async function withHeld<R extends HeldRef, T>(ref: R, action: (live: R) => Promise<T>): Promise<T> {
	try {
		await whenLive(ref);
		return await action(ref);
	} finally {
		ref.release();
	}
}

/**
 * `withHeld` for a reference whose binding must grant `members`: rejects when it binds without one of them (the
 * principal may not).
 */
export async function withGranted<R extends GrantedRef, const M extends keyof R, T>(
	ref: R,
	members: readonly M[],
	action: (live: With<R, M>) => Promise<T>,
): Promise<T> {
	return withHeld(ref, async (held) => {
		const live = liveWith(held, ...members);
		if (!live) throw new Error(`Not allowed: ${members.join(", ")}`);
		return action(live);
	});
}

/** The error of a failed or ended reference, if any. */
export function errorOf(ref: HeldRef): Error | undefined {
	const state = ref.state.value;
	return state.kind === "ended" ? state.error : state.kind === "failed" ? state.cause.error : undefined;
}

/**
 * Releases held references later: a chat stays held for a while after its screen is left, so that switching back is
 * instant, at most `cap` of them at once (the oldest goes first).
 */
export class Lingering {
	readonly #delays: Readonly<Record<string, number>>;
	readonly #cap: number;
	readonly #waiting = new Map<HeldRef, ReturnType<typeof setTimeout>>();

	constructor(delays: Readonly<Record<string, number>>, cap: number) {
		this.#delays = delays;
		this.#cap = cap;
	}

	/** Releases `ref` (of the type named `type`) after its type's delay; at once for a type without one. */
	release(ref: HeldRef, type: string): void {
		const delay = this.#delays[type];
		if (delay === undefined) {
			ref.release();
			return;
		}
		const timer = setTimeout(() => this.#now(ref), delay);
		// A lingering reference never keeps a process alive (a TUI exiting, a test ending).
		(timer as { unref?: () => void }).unref?.();
		this.#waiting.set(ref, timer);
		if (this.#waiting.size > this.#cap) this.#now(this.#waiting.keys().next().value as HeldRef);
	}

	/** Releases every waiting reference now (a host closing). */
	flush(): void {
		for (const ref of [...this.#waiting.keys()]) this.#now(ref);
	}

	#now(ref: HeldRef): void {
		clearTimeout(this.#waiting.get(ref));
		this.#waiting.delete(ref);
		ref.release();
	}
}

/** p2's delays: a chat lingers two minutes, at most four of them. */
export const UI_LINGER = new Lingering({ "p2.chat": 2 * 60_000 }, 4);
