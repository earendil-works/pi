import type { Draft, Op } from "./delta/index.ts";
import type { RemoteServiceProvider } from "./services/provider.ts";

export type { RemoteServiceError } from "./services/errors.ts";
export type { RemoteServiceProvider } from "./services/provider.ts";

/** Typed identity for one value carried by a {@link Context}. */
export interface ContextKey<T> {
	readonly token: symbol;
	/** Type-only marker that prevents keys with different value types from being interchangeable. */
	readonly valueType?: (value: T) => T;
}

/** Immutable invocation-scoped values passed explicitly through operations. */
export interface Context {
	readonly abortSignal: AbortSignal | undefined;
	value<T>(key: ContextKey<T>): T | undefined;
	toString(): string;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type IsAny<T> = 0 extends 1 & T ? true : false;

/** Strict-JSON representation of an application data type. Unknown payloads become JsonValue. */
export type JsonRepresentation<T> = IsAny<T> extends true
	? JsonValue
	: unknown extends T
		? JsonValue
		: T extends null | boolean | number | string
			? T
			: T extends readonly (infer TItem)[]
				? JsonRepresentation<TItem>[]
				: T extends object
					? { [TKey in keyof T]: JsonRepresentation<T[TKey]> }
					: never;

export interface ReplicatedStateDelivery {
	readonly kind: "hydrate" | "update";
	readonly sequence: number;
}

export interface ReplicatedState<T> {
	/**
	 * Contract-immutable value, or undefined until hydration. It is not frozen and may share containers with an
	 * in-process provider; consumers must not mutate it. Later updates do not mutate previously returned values.
	 */
	readonly value: T | undefined;
	/** Listener values follow the same immutable ownership contract and may share unchanged revision data. */
	subscribe(listener: (value: T, context: Context, delivery: ReplicatedStateDelivery) => void): () => void;
}

export interface MutableReplicatedState<T extends object> extends ReplicatedState<T> {
	readonly value: T;
	/**
	 * Atomically publish one synchronous overlay mutation. Draft handles are unusable after the callback returns.
	 * Values placed through the draft are cloned by value; assigning `undefined` to an object property deletes it.
	 */
	change(context: Context, mutate: (draft: Draft<T>) => void): void;
	/**
	 * Atomically take immutable ownership of an alias-free strict-JSON replacement.
	 * The caller must not mutate the transferred root after this call.
	 */
	replace(context: Context, value: T): void;
}

/** One immutable authoritative revision committed after an attachment snapshot. */
export interface ReplicatedStateSourceFrame<T> {
	/** Monotonic source cursor. The first frame after a snapshot must be `snapshot.cursor + 1`. */
	readonly cursor: number;
	/** The exact immutable value produced by this commit. */
	readonly value: T;
	/** The exact immutable operation batch that produced `value` from the preceding source revision. */
	readonly ops: readonly Op[];
	readonly context: Context;
}

export interface ReplicatedStateSourceAttachment<T> {
	/** Fixed immutable snapshot captured at the atomic attachment boundary. */
	readonly snapshot: { readonly value: T; readonly cursor: number };
	/**
	 * Install the sole listener and synchronously drain every buffered frame in source commit order.
	 * This method is single-use. After it begins, every new committed frame must also be delivered in order
	 * until disposal, including commits made reentrantly while a prior frame is being delivered.
	 */
	activate(listener: (frame: ReplicatedStateSourceFrame<T>) => void): void;
	/** Stop delivery and release source resources. Disposal must be idempotent. */
	dispose(): void;
}

/**
 * An authoritative immutable revision source.
 *
 * `attach()` must synchronously and atomically capture one snapshot and register the returned attachment to buffer
 * every later committed frame. The snapshot must include every commit before that boundary; buffered frames must
 * include every commit after it, with no overlap or gap. Snapshot values, frame values, and operation batches are
 * immutable and remain valid after delivery. Chord only publishes these references; it never applies or re-diffs them.
 */
export interface ReplicatedStateSource<T> {
	attach(): ReplicatedStateSourceAttachment<T>;
}

export interface ReplicatedStateSourceOptions {
	/** Receives source-contract and publication-listener failures without throwing them into the source. */
	readonly onError?: (error: Error) => void;
}

/** A synchronously hydrated publication-only state backed by one source attachment. */
export interface AttachedReplicatedState<T> extends ReplicatedState<T> {
	readonly value: T;
	/** Idempotently release the source attachment. The last published value remains readable. */
	dispose(): void;
}

declare const SERVICE_TYPE: unique symbol;

export type ServiceMode = "singleton" | "keyed";

/** Stable identity for one shared TypeScript service contract. */
export interface Service<T> {
	readonly id: string;
	/** Process-local services accept unrestricted object contracts and are never published remotely. */
	readonly local: boolean;
	readonly [SERVICE_TYPE]?: (value: T) => T;
}

type InvalidJsonPart<T> = IsAny<T> extends true
	? T
	: unknown extends T
		? never
		: [T] extends [JsonValue]
			? [JsonValue] extends [T]
				? never
				: InvalidJsonStructure<T>
			: InvalidJsonStructure<T>;

type InvalidJsonProperty<T> = [Exclude<T, undefined>] extends [never] ? T : InvalidJsonPart<Exclude<T, undefined>>;

type InvalidJsonStructure<T> = T extends null | boolean | number | string
	? never
	: T extends readonly (infer TItem)[]
		? InvalidJsonPart<TItem>
		: T extends (...args: never[]) => unknown
			? T
			: T extends object
				? { [TKey in keyof T]-?: InvalidJsonProperty<T[TKey]> }[keyof T]
				: T;

type InvalidRemoteMember<T> = T extends ReplicatedState<infer TValue>
	? InvalidJsonPart<TValue> extends never
		? never
		: "state value is not JSON"
	: T extends (...args: [...infer TArgs, Context]) => Promise<infer TResult>
		? InvalidJsonPart<TArgs[number]> extends never
			? TResult extends void
				? never
				: InvalidJsonPart<TResult> extends never
					? never
					: "method result is not JSON or void"
			: "method argument is not JSON"
		: "member is not a remote method or ReplicatedState";

type InvalidRemoteMemberNames<T> = {
	[TKey in keyof T]-?: InvalidRemoteMember<T[TKey]> extends never ? never : TKey;
}[keyof T];

export type RemoteServiceContract<T> = InvalidRemoteMemberNames<T> extends never ? T : never;

export interface ServiceSpawner<T> {
	spawn(key: string, implementation: T): () => void;
}

export interface RemoteServices {
	use<T>(service: Service<T>): T;
	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): () => void;
	/** Wait until every currently acquired service has installed its initial snapshot. */
	ready(context: Context): Promise<void>;
	dispose(context: Context): Promise<void>;
}

export type ServiceCatalogueEntry = {
	readonly serviceId: string;
	readonly mode: ServiceMode;
};

export type ServiceInstanceAddress = {
	readonly key: string;
	readonly generation: number;
};

export type ServiceMemberSnapshot =
	| { readonly name: string; readonly kind: "method" }
	| { readonly name: string; readonly kind: "state"; readonly sequence: number; readonly ops: readonly Op[] };

export type ServiceInstanceSnapshot = {
	readonly instance?: ServiceInstanceAddress;
	readonly members: readonly ServiceMemberSnapshot[];
};

export type ServiceSubscriptionSnapshot = {
	readonly serviceId: string;
	readonly mode: ServiceMode;
	readonly instances: readonly ServiceInstanceSnapshot[];
};

export type ServiceProviderUpdate =
	| {
			readonly type: "state";
			readonly instance?: ServiceInstanceAddress;
			readonly member: string;
			readonly sequence: number;
			readonly ops: readonly Op[];
	  }
	| { readonly type: "unavailable" }
	| { readonly type: "replaced"; readonly snapshot: ServiceInstanceSnapshot }
	| { readonly type: "spawned"; readonly instance: ServiceInstanceSnapshot }
	| { readonly type: "closed"; readonly instance: ServiceInstanceAddress };

export type ServiceCall = {
	readonly serviceId: string;
	readonly instance?: ServiceInstanceAddress;
	readonly member: string;
	/** Borrowed immutable values. Chord validates but does not clone them. */
	readonly args: readonly JsonValue[];
};

export interface ServiceSubscription {
	readonly snapshot: ServiceSubscriptionSnapshot;
	activate(): void;
	close(context?: Context): void | Promise<void>;
}

/**
 * Pluggable wire boundary consumed by a remote service binding.
 *
 * Implementations choose transport, framing, routing, and envelope encoding. Values crossing this
 * boundary must remain strict JSON. Chord does not clone values or require a particular application wire protocol;
 * adapters own serialization and any isolation copies they require.
 *
 */
export interface RemoteServiceTransport {
	invoke(call: ServiceCall, context: Context): Promise<JsonValue | undefined>;
	subscribe(
		serviceId: string,
		mode: ServiceMode,
		listener: (update: ServiceProviderUpdate, context: Context) => void,
		context: Context,
	): Promise<ServiceSubscription>;
}

export interface RemoteServiceBindingOptions {
	readonly services: readonly { readonly id: string }[];
	readonly transport: RemoteServiceTransport;
	readonly bound?: boolean;
	readonly onError?: (error: Error) => void;
	readonly assertAccess?: () => void;
}

export interface RemoteServiceBinding extends RemoteServices {
	rebind(bound: boolean, context: Context): Promise<void>;
}

export interface FacetEnvironment {
	/** Declare a hard dependency on one singleton service and return its stable handle. */
	use<T>(service: Service<T>): T;
	/** Declare a hard dependency on a keyed service and observe each live instance. */
	observe<T>(service: Service<T>, handler: (service: T, context: Context) => void | Promise<void>): void;
	/** Declare and install this facet's singleton implementation of a service. */
	provide<T>(service: Service<T>, implementation: NoInfer<T>): void;
	/** Declare ownership of a multi-instance service and return its deferred spawning capability. */
	provideMany<T>(service: Service<T>): ServiceSpawner<T>;
	/**
	 * Create initialized mutable state by taking immutable ownership of an alias-free strict-JSON root.
	 * The caller must not mutate `initial` after this call.
	 */
	replicatedState<T extends object>(initial: T): MutableReplicatedState<T>;
	/** Give the facet ownership of a resource cleanup function. */
	own(disposal: () => void | Promise<void>): void;
	/** Register asynchronous initialization after dependencies are bound and ready. */
	onActivate(callback: () => void | Promise<void>): void;
	/** Register final facet teardown. */
	onDeactivate(callback: () => void | Promise<void>): void;
}

export interface Facet {
	readonly id: string;
	setup(env: FacetEnvironment): void;
}

export interface RemoteServiceSource {
	/** Whether this currently unavailable source may provisionally own absent requirements. */
	readonly acceptsUnavailableServices: boolean;
	catalogue(context: Context): Promise<readonly ServiceCatalogueEntry[]>;
	open(options: {
		readonly services: readonly { readonly id: string }[];
		assertAccess(): void;
		onError(error: Error): void;
	}): RemoteServices;
}

export interface FacetOptions {
	readonly facets: readonly Facet[];
	readonly serviceSources?: readonly RemoteServiceSource[];
	readonly onError?: (error: Error) => void;
}

export interface FacetHost {
	readonly services: RemoteServiceProvider;
	/** Activate and replace facets with matching IDs without disconnecting consumer service handles. */
	reload(facets: readonly Facet[]): Promise<void>;
	dispose(): Promise<void>;
}

export interface LoadedFacets {
	readonly facets: readonly Facet[];
	dispose(): Promise<void>;
}

export interface FacetLoader {
	load(): Promise<LoadedFacets>;
}
