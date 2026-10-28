// The parts of the Workers runtime these tests use, typed for the repository's Node program. The tests run in workerd
// itself (`vitest.config.ts`); full Workers types would conflict with Node's. `DurableObject` itself is declared by
// packages/codemode/src/cloudflare-modules.d.ts, with an untyped `ctx`.

declare module "cloudflare:workers" {
	import type { DurableObjectSqliteStorage } from "@earendil-works/chord/sqlite/cloudflare";

	export type DurableObjectStorage = DurableObjectSqliteStorage & {
		getAlarm(): Promise<number | null>;
		setAlarm(scheduledTime: number): Promise<void>;
		deleteAlarm(): Promise<void>;
		/** Synchronous key-value storage of a SQLite-backed Durable Object. */
		readonly kv: { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void };
	};

	export type DurableObjectState = {
		readonly storage: DurableObjectStorage;
		blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
		/** Reset the object: its instance is dropped, and the next event starts a new one. */
		abort(reason?: string): void;
	};

	export type DurableObjectId = { toString(): string };
	export type DurableObjectStub = { readonly id: DurableObjectId };
	export type DurableObjectNamespace = { newUniqueId(): DurableObjectId; get(id: DurableObjectId): DurableObjectStub };

	export const env: { readonly SESSIONS: DurableObjectNamespace };
}

declare module "cloudflare:test" {
	import type { DurableObjectState, DurableObjectStub } from "cloudflare:workers";

	/** Run `callback` inside the object, with its instance and state. */
	export function runInDurableObject<O, R>(
		stub: DurableObjectStub,
		callback: (instance: O, state: DurableObjectState) => R | Promise<R>,
	): Promise<R>;
	/** Run the object's alarm now if one is set; whether one ran. */
	export function runDurableObjectAlarm(stub: DurableObjectStub): Promise<boolean>;
	/** Tear the object's instance down, keeping its storage. */
	export function evictDurableObject(stub: DurableObjectStub): Promise<void>;
}
