import type { Ctx } from "./types.ts";

// What a factory declares through `self` besides state cells: the shapes of resources and listeners.

export interface Subscribable<E> {
	subscribe(listener: (event: E) => void): () => void;
}

/** `self.resource(name, declaration)`: something the object opens and later closes (a database, a watch, a socket). */
export interface ResourceDeclaration<T> {
	/** Bump to replace the resource at the next reload (a native value has no schema to detect a change). */
	readonly version: number;
	/** References or resources that must be live/open first. A change replaces the resource. */
	readonly deps?: readonly unknown[];
	/** Exclusive resources are replaced at the gate: old closed before new opened. */
	readonly exclusive?: boolean;
	open(options: { readonly signal: AbortSignal }): T | Promise<T>;
	close?(value: T): void | Promise<void>;
}

export interface Resource<T> {
	readonly key: string;
	/** Throws not_ready until opened. */
	readonly value: T;
}

/** A listener as `self.on` declares it. */
export interface ListenerDecl {
	readonly source: unknown;
	readonly select: ((value: never) => Subscribable<unknown>) | undefined;
	readonly fn: (event: unknown, ctx: Ctx) => void | Promise<void>;
}

// A cell has a `key` and a `value` too: sources are matched before resources.
/** What `self.on(name, source, …)` passes to `select`: a resource's opened value, or the source itself. */
export type ValueOf<S> = S extends Subscribable<unknown> ? S : S extends Resource<infer T> ? T : S;
/** What `self.on(name, source, handler)` delivers: a readable's values, an event source's events. */
export type EventOf<S> = S extends Subscribable<infer E> ? E : S extends Resource<infer T> ? EventOf<T> : never;
