// Chord v2's API with p2's principals (browser-safe): hosts, facets and handlers see a `P2Principal` and narrow on its
// `kind`. Plugins import these through `@p2/app/v1` instead of Chord's generic forms.
import {
	bool,
	type Ctx as ChordCtx,
	ChordError,
	type Facet as ChordFacet,
	type FacetHost as ChordFacetHost,
	type Factory as ChordFactory,
	type Host as ChordHost,
	type HostOptions as ChordHostOptions,
	type Self as ChordSelf,
	type StoreSelf as ChordStoreSelf,
	type Contract,
	createHost as chordCreateHost,
	defineFacet as chordDefineFacet,
	defineRegistry,
	defineState,
	type FacetSelf,
	type Held,
	type HostError,
	hostKind,
	int,
	type JsonObject,
	keyedEntries,
	oneOf,
	type Reference,
	type RefIn,
	type Registry,
	type Schema,
	type StateDefinition,
	str,
	type Watchable,
} from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { NativeWatchable } from "@earendil-works/chord/watch";
import { type P2Principal, principalKey, type Revocation, revokedBy } from "./principals.ts";

export type Ctx = ChordCtx<P2Principal>;
export type Host = ChordHost<P2Principal, Revocation>;
export type HostOptions = ChordHostOptions<P2Principal, Revocation>;
export type Facet = ChordFacet<P2Principal>;
export type FacetHost = ChordFacetHost<P2Principal>;
export type Factory<C extends Contract> = ChordFactory<C, P2Principal>;
/** A factory's `self` (any object). */
export type Self = ChordSelf<P2Principal>;
/** A host-lifetime local object's `self` (it may contribute to registries). */
export type StoreSelf = ChordStoreSelf<P2Principal>;
export type { FacetSelf };
/** A reference to an object of `C` (v1's name). */
export type Ref<C extends Contract> = Reference<C>;
export type { Held, HostError };
export type { RefIn };

/** A p2 host: principals keyed and revoked the same way on every host. */
export const createHost = (options: HostOptions): Host =>
	chordCreateHost<P2Principal, Revocation>({ principalKey, revokedBy, ...options });

/** A facet of p2's hosts: factories, methods and routines see a `P2Principal`. */
export const defineFacet = (setup: (host: FacetHost, self: FacetSelf) => void): Facet =>
	chordDefineFacet<P2Principal>(setup);

/** The server: one host. */
export const Server = hostKind("server");
/** A session's worker: one per session. */
export const Session = hostKind("session", { id: str() });
/** Where server objects live (a contract's `hostAddress`). */
export const serverHost = () => Server();
/** Where session objects live: the worker of the params' `session` (a contract's `hostAddress`). */
export const sessionHost = ({ session }: { readonly session: string }) => Session({ id: session });

/** Params fields (Chord's typed schemas): a required string, integer, boolean or one of some strings. */
export const param = { str, int, bool, oneOf };

// Chord's decided errors for plugins: `invalid(reason, message)` for refused arguments or params, `forbidden(message)`
// for a refused principal.
export { forbidden, invalid } from "@earendil-works/chord";

type Variants<R> = R extends { readonly variant: infer V } ? Exclude<V, undefined> : never;
/** The variants of a reference to `C` (remote types), or `never`. */
export type VariantOf<C extends Contract> = Variants<Reference<C>>;

/**
 * `ref` narrowed to `variant`, for code that knows which variant its principal gets (a worker's `Sessions` is `worker`):
 * throws `invalid/member` when the live reference is in another one.
 */
export function expectVariant<R extends { readonly variant: unknown }, const V extends Variants<R>>(
	ref: R,
	variant: V,
): Extract<R, { readonly variant: V }> {
	if (ref.variant !== variant)
		throw new ChordError({
			code: "invalid",
			reason: "member",
			message: `expected variant ${String(variant)}, got ${String(ref.variant)}`,
		});
	return ref as Extract<R, { readonly variant: V }>;
}

/**
 * `ref` if it is in one of `variants`, else `undefined` (a reference still loading has no variant yet). A runtime check
 * of `ref.variant`: code that depends on a variant narrows with it instead of casting.
 */
export function inVariant<R extends { readonly variant: unknown }, const V extends Variants<R>>(
	ref: R | undefined,
	...variants: readonly V[]
): Extract<R, { readonly variant: V }> | undefined {
	return ref !== undefined && (variants as readonly unknown[]).includes(ref.variant)
		? (ref as Extract<R, { readonly variant: V }>)
		: undefined;
}

/**
 * A native another object contributes to `registry` (a single-provider registry composed from its contribution), for a
 * factory: read at each use; throws "`what` is not open" while there is none.
 */
export function nativeOf<V>(self: Self, registry: Registry<V, V | undefined>, what: string): () => V {
	const value = self.registry(registry);
	return () => {
		const native = value.value;
		if (native === undefined) throw new Error(`${what} is not open`);
		return native;
	};
}

/** Serves a registry of one native: the first contribution (by plugin name), `undefined` before there is one. */
export function serveNative<V>(host: FacetHost, registry: Registry<V, V | undefined>): void {
	host.serve(registry, { compose: (table) => table[0]?.value });
}

/**
 * `self.derive` for values TypeScript does not see as JSON: pi-schema's optional fields are `T | undefined`, which
 * Chord's `JsonValue` refuses. The value is JSON at runtime all the same (state is).
 */
export function deriveTyped<const S extends readonly (Watchable<unknown> | NativeWatchable<unknown>)[], T>(
	self: Self,
	sources: S,
	compute: (
		values: {
			readonly [I in keyof S]: S[I] extends Watchable<infer V>
				? V
				: S[I] extends NativeWatchable<infer V>
					? V
					: never;
		},
	) => T,
): Watchable<T> {
	// Typed as Chord's derive is, but for any `T` (see above).
	return (self as unknown as { derive(sources: S, compute: unknown): Watchable<T> }).derive(sources, compute);
}

/**
 * `defineState` (in memory, a singleton) for a schema whose static type TypeScript does not see as JSON (see
 * `deriveTyped`). The document is JSON at runtime all the same.
 */
export function defineTypedState<T extends object>(
	name: string,
	options: { readonly schema: Schema<T>; readonly version: number; readonly initial: () => NoInfer<T> },
): StateDefinition<T & JsonObject, false, false> {
	// Typed as Chord's defineState is, but for any object type `T` (see above).
	return defineState(name, options as never) as unknown as StateDefinition<T & JsonObject, false, false>;
}

const NEVER_ABORTED = new AbortController().signal;

/** `context`'s abort signal (a routine's, a handler's); one that never aborts for a context without one. */
export const signalOf = (context: Context): AbortSignal => context.abortSignal ?? NEVER_ABORTED;

/** One line for a host's background error, as p2's logs and owner notices show it. */
export function hostErrorText(error: HostError): string {
	const message = (value: unknown) => (value instanceof Error ? value.message : String(value));
	switch (error.kind) {
		case "registry_undeclared":
			return `registry ${error.registry} has contributions (${error.plugins.join(", ")}) and no provider`;
		case "unbound_long":
			return `a request has waited for ${error.waitingFor} since ${new Date(error.since).toISOString()}: ${error.error.message}`;
		case "transaction_cancelled":
			return `${error.object}: a transaction was cancelled before it committed (${message(error.error)})`;
	}
	const failure = "error" in error ? error.error : "failure" in error ? error.failure.error : undefined;
	return `${error.kind}: ${message(failure)}`;
}

/**
 * Whether a host error is a link handshake with a peer on a newer link protocol (this code is outdated: reload it).
 * Chord reports a mismatch only as its message, "handshake: protocol <peer>, this host speaks <local>".
 */
export function newerPeerProtocol(error: { readonly kind: string; readonly error?: unknown }): boolean {
	if (error.kind !== "protocol_error") return false;
	const versions = /handshake: protocol (\d+), this host speaks (\d+)/.exec(String(error.error));
	return versions !== null && Number(versions[1]) > Number(versions[2]);
}

/** A plain listener source outside Chord (a watcher's events): `subscribe` returns its stop. */
export type Subscribable<T> = { subscribe(listener: (value: T) => void): () => void };

/**
 * Resolves with the first value of `source` that `done` accepts (the current one included); aborting `context`
 * rejects.
 */
export async function until<T>(source: Watchable<T>, done: (value: T) => boolean, context: Context): Promise<T> {
	const watch = await source.watch(context);
	try {
		if (done(watch.value)) return watch.value;
		return await new Promise<T>((resolve, reject) => {
			watch.start(async (call) => {
				if (call.kind === "value" && done(call.value)) resolve(call.value);
			});
			void watch.closed.then((end) => reject(end.kind === "failed" ? end.error : new Error(`watch ${end.kind}`)));
		});
	} finally {
		await watch.stop();
	}
}

/** A registry of keyed contributions (`{ key: value }`), composed into one map: v1's registry tables. */
export type KeyedRegistry<V> = Registry<Readonly<Record<string, V>>, ReadonlyMap<string, V>>;

/** Declares a keyed registry; its defining facet serves it with `serveKeyed` on every host kind that reads it. */
export const keyedRegistry = <V>(name: string): KeyedRegistry<V> =>
	defineRegistry<Readonly<Record<string, V>>, ReadonlyMap<string, V>>(name, { version: 1 });

/** Serves a keyed registry: every contribution's keys, a duplicate reported and the first plugin by name kept. */
export function serveKeyed<V>(host: FacetHost, registry: KeyedRegistry<V>): void {
	host.serve(registry, {
		compose: (table, { report }) =>
			new Map([...keyedEntries(table, (value) => value, report)].map(([key, item]) => [key, item.value])),
	});
}

/**
 * A state source following a native that tells listeners of its changes (`subscribe` returns the stop): `self.follow`
 * of a synchronous observer, so the state is the native's, never a copy a routine keeps. Its value is `read()` at
 * activation and after every change, sent whole (`[["r", value]]`: derives over it diff for the wire). Both run once
 * the object's natives opened, so they may read a native's `.value`. A change the native makes inside a method
 * reaches the source before the method's answer (an off-batch change commits on the next microtask).
 */
export function followNative<T>(
	self: Self,
	subscribe: (changed: () => void) => () => void,
	read: () => T,
): Watchable<T> {
	return self.follow(async (observer, context) => {
		const detach = subscribe(() => {
			const value = read();
			// JSON at runtime: `read` gives the native's plain data (optional fields TypeScript does not see as JSON).
			observer.advance({ kind: "value", value, ops: [["r", value as never]], retired: false }, context);
		});
		return { value: read(), detach };
	});
}
