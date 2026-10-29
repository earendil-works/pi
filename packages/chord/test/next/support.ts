// Test support: cost counters through the in-memory telemetry adapter, GC checks, and hosts, links, watches and
// rejections for the slice tests.

import { DatabaseSync } from "node:sqlite";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { afterEach, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { BACKGROUND_CONTEXT, type Context, withTelemetry } from "../../src/context/index.ts";
import type { Op } from "../../src/delta/index.ts";
import type { JsonValue } from "../../src/json.ts";
import {
	type Address,
	arr,
	bool,
	bytes,
	type Contract,
	hostKind,
	int,
	local,
	method,
	obj,
	opt,
	type ParamsOf,
	remote,
	str,
} from "../../src/next/contracts/index.ts";
import { currentVariants, variantNames, variantOrder } from "../../src/next/contracts/internal.ts";
import { ChordError, isChordError, PluginError, type Principal } from "../../src/next/data/index.ts";
import { PROTOCOL_VERSION } from "../../src/next/data/internal.ts";
import { defineState } from "../../src/next/documents/index.ts";
import type { Attempt } from "../../src/next/host/attempt.ts";
import {
	type Ctx,
	createHost,
	defineFacet,
	type FacetHost,
	type FacetSelf,
	type Host,
	type HostError,
	type RefState,
	type Self,
	type StoreSelf,
} from "../../src/next/host/index.ts";
import type { ChordObject } from "../../src/next/host/object.ts";
import { type Compression, type Link, memoryLinkPair, type PartLimits } from "../../src/next/link/index.ts";
import {
	binaryCodec,
	type Codec,
	checkMessage,
	jsonPart,
	type Message,
	openPart,
	type Part,
	parsePart,
	textCodec,
} from "../../src/next/link/internal.ts";
import type { ArchivePart } from "../../src/next/store/archive.ts";
import { sqliteBackend } from "../../src/next/store/backend.ts";
import { changeDocument, createDocument, retireDocument } from "../../src/next/store/engine.ts";
import { json } from "../../src/next/store/json-column.ts";
import type { StagedWrite } from "../../src/next/store/step.ts";
import { type ChordStore, openStore, type Store } from "../../src/next/store/store.ts";
import { defineTable, type TableDefinition } from "../../src/next/store/table.ts";
import { TableChanges } from "../../src/next/store/table-changes.ts";
import { evolveTable } from "../../src/next/store/table-evolve.ts";
import { TableHandle, type TableOwner } from "../../src/next/store/table-handle.ts";
import { prepareTables } from "../../src/next/store/table-migration.ts";
import { nodeCompression } from "../../src/next-node/compression.ts";
import { NodeSqliteDatabase, openNodeSqliteDatabase } from "../../src/sqlite/node.ts";
import type { NativeWatchHandle, WatchCall, WatchHandle } from "../../src/watch.ts";

/** Counts of the `chord.data.*` counters. */
export type Counts = { walks: number; validations: number; compilations: number };

/** Runs `work` with a counting context and returns the counters it added. */
export async function counted(work: (context: Context) => void): Promise<Counts> {
	const telemetry = new InMemoryTelemetryContext();
	await telemetry.startSpan({ name: "test" }, (span) => work(withTelemetry(span, BACKGROUND_CONTEXT)));
	const counts: Counts = { walks: 0, validations: 0, compilations: 0 };
	for (const { name, value } of telemetry.getMetrics()) {
		const counter = name.replace("chord.data.", "") as keyof Counts;
		counts[counter] += value;
	}
	return counts;
}

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** Expects every referent to be collected once nothing else holds it. */
export async function expectCollected(...refs: WeakRef<object>[]): Promise<void> {
	for (let round = 0; round < 10 && refs.some((ref) => ref.deref() !== undefined); round++) {
		await new Promise((resolve) => setImmediate(resolve));
		gc();
	}
	expect(refs.map((ref) => ref.deref() === undefined)).toEqual(refs.map(() => true));
}

/** The heap in use once pending work ran and garbage was collected, repeatedly. */
export async function settledHeap(): Promise<number> {
	for (let round = 0; round < 5; round++) {
		await new Promise((resolve) => setImmediate(resolve));
		gc();
	}
	return process.memoryUsage().heapUsed;
}

/** `true` when `A` and `B` are the same type; for type-level tests where `expectTypeOf` cannot compare (bytes). */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** A telemetry adapter, a context counting through it, and the counters recorded so far, by name. */
export async function metered(): Promise<{
	readonly telemetry: InMemoryTelemetryContext;
	readonly context: Context;
	counts(): Record<string, number>;
}> {
	const telemetry = new InMemoryTelemetryContext();
	// A settled span still records through its adapter's metrics.
	const span = await telemetry.startSpan({ name: "test" }, (span) => span);
	const counts = (): Record<string, number> => {
		const result: Record<string, number> = {};
		for (const { name, value } of telemetry.getMetrics()) result[name] = (result[name] ?? 0) + value;
		return result;
	};
	return { telemetry, context: withTelemetry(span, BACKGROUND_CONTEXT), counts };
}

/** Waits until queued watch frames have been delivered. */
export function delivered(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Starts `watch` and collects its frames as `[value, ops]`. */
export function framesOf<T>(watch: WatchHandle<T>): [T, readonly Op[]][] {
	const frames: [T, readonly Op[]][] = [];
	watch.start(async (call) => {
		if (call.kind === "value") frames.push([call.value, call.ops]);
	});
	return frames;
}

/** Starts `watch` and collects every call it gets: values (the `retired` flag included) and failures. */
export function changesOf<T>(watch: WatchHandle<T>): WatchCall<T>[] {
	const calls: WatchCall<T>[] = [];
	watch.start(async (call) => {
		calls.push(call);
	});
	return calls;
}

/** The values of `calls` (a failure as `{ failed: message }`), for short expectations. */
export function valuesOf<T>(calls: readonly WatchCall<T>[]): (T | { readonly failed: string })[] {
	return calls.map((call) => (call.kind === "value" ? call.value : { failed: (call.error as Error).message }));
}

/**
 * Fails the live attempt `self` as a runtime failure of its owner does (slice 6a §1.4); `objects` is the test file's
 * `instancesOf(ChordObject, "attempt")`, whose objects other than `self`'s ignore it.
 */
export function failLive(objects: readonly WeakRef<ChordObject>[], self: Self, error: ChordError): void {
	// The factory's `self` is its attempt.
	for (const object of objects) object.deref()?.failLive(self as unknown as Attempt, { kind: "broken", error });
}

/** A local type whose objects' attempts a test ends by hand (`restartable`); it ends with its last reference. */
export const Restartable = local("app.restartable", {
	version: 1,
	params: { id: int() },
	members: { touch: method() },
});

/** A local type with empty params whose attempts a test ends by hand (`storeRestartable`): it may persist (P3). */
export const StoreRestartable = local("app.store", { version: 1, params: {}, members: { touch: method() } });

/**
 * Serves `Restartable` with `factory` per attempt (its number from 1) and gets object 1 live. `fail()` fails the live
 * attempt as a runtime failure of its owner does (slice 6a §1.4); `retry()` asks for the next attempt and resolves
 * once it is live; `restart()` does both. `objects` is the test file's `instancesOf(ChordObject, "attempt")`; `serve` serves other
 * types on the same host.
 */
export function restartable(
	objects: readonly WeakRef<ChordObject>[],
	factory: (attempt: number, self: Self) => void,
	options: Parameters<typeof loaded>[1] & { readonly serve?: (host: FacetHost) => void } = {},
) {
	return restartableOf(Restartable, { id: 1 }, objects, factory, options);
}

/** As `restartable`, for `StoreRestartable`: its factories may declare tables and persisted documents. */
export function storeRestartable(
	objects: readonly WeakRef<ChordObject>[],
	factory: (attempt: number, self: StoreSelf) => void,
	options: Parameters<typeof loaded>[1] & { readonly serve?: (host: FacetHost) => void } = {},
) {
	return restartableOf(StoreRestartable, {}, objects, factory as (attempt: number, self: Self) => void, options);
}

async function restartableOf<C extends typeof Restartable | typeof StoreRestartable>(
	Type: C,
	params: ParamsOf<C>,
	objects: readonly WeakRef<ChordObject>[],
	factory: (attempt: number, self: Self) => void,
	options: Parameters<typeof loaded>[1] & { readonly serve?: (host: FacetHost) => void },
) {
	const attempts: Self[] = [];
	let started = 0;
	const { host, errors } = await loaded((h) => {
		options.serve?.(h);
		// Both types have the one method `touch`; the factory's `self` is the attempt either way.
		h.serve(Type as typeof Restartable, (_, self) => {
			factory(++started, self);
			attempts.push(self);
			return { touch: async () => null };
		});
	}, options);
	const get = () => host.get(Type as typeof Restartable, params as ParamsOf<typeof Restartable>, BACKGROUND_CONTEXT);
	const reference = await get();
	const fail = (): void => {
		failLive(objects, attempts.at(-1)!, new ChordError({ code: "unavailable", message: "boom" }));
	};
	const retry = async (): Promise<void> => {
		reference.retry();
		(await get()).release();
	};
	const restart = async (): Promise<void> => {
		fail();
		await retry();
	};
	return { host, errors, reference, attempts, fail, retry, restart };
}

/** A host with background errors collected, loaded with one facet (`@test/app`) whose setup is `setup`. */
export async function loaded(
	setup: (host: FacetHost, self: FacetSelf) => void,
	options: {
		readonly telemetry?: InMemoryTelemetryContext;
		readonly context?: Context;
		readonly closeTimeout?: number;
		readonly readyTimeout?: number;
		readonly store?: Store;
	} = {},
): Promise<{ readonly host: Host; readonly errors: HostError[] }> {
	const errors: HostError[] = [];
	const { telemetry, closeTimeout, readyTimeout, store } = options;
	const host = createHost({ telemetry, closeTimeout, readyTimeout, store, onError: (error) => errors.push(error) });
	await host.load([{ name: "@test/app", facet: defineFacet(setup) }], options.context ?? BACKGROUND_CONTEXT);
	return { host, errors };
}

/**
 * A host with background errors collected, loaded with one facet per plugin, in the order given (`setups` by plugin
 * name).
 */
export async function loadedPlugins(
	setups: Readonly<Record<string, (host: FacetHost, self: FacetSelf) => void>>,
	options: { readonly telemetry?: InMemoryTelemetryContext; readonly readyTimeout?: number } = {},
): Promise<{ readonly host: Host; readonly errors: HostError[] }> {
	const errors: HostError[] = [];
	const host = createHost({ ...options, onError: (error) => errors.push(error) });
	const facets = Object.entries(setups).map(([name, setup]) => ({ name, facet: defineFacet(setup) }));
	await host.load(facets, BACKGROUND_CONTEXT);
	return { host, errors };
}

/** A store on a fresh SQLite `:memory:` database, as Chord's layers see it. */
export async function memoryStore(options?: { readonly outbox?: boolean }): Promise<ChordStore> {
	const db = await openNodeSqliteDatabase(":memory:");
	return (await openStore(sqliteBackend(db), BACKGROUND_CONTEXT, options)) as ChordStore;
}

/** A statement of the Node facade's transactions a test can make fail. */
export type TransactionStatement = "BEGIN IMMEDIATE" | "COMMIT" | "ROLLBACK";

/**
 * A Node SQLite facade on `:memory:` whose next `statement` throws, once per `fail` (the D4 matrix: a failed
 * `BEGIN`, `COMMIT` or `ROLLBACK`, as the real facade sees one).
 */
export function faultyDatabase(): { readonly db: NodeSqliteDatabase; fail(statement: TransactionStatement): void } {
	const database = new DatabaseSync(":memory:");
	const failing = new Set<string>();
	const exec = database.exec.bind(database);
	database.exec = (sql: string): void => {
		if (!failing.delete(sql)) {
			exec(sql);
			return;
		}
		// A failed `ROLLBACK` here still rolls back, so the database stays usable for the rest of the test.
		if (sql === "ROLLBACK") exec(sql);
		throw new Error(`injected: ${sql} failed`);
	};
	return { db: new NodeSqliteDatabase(database), fail: (statement) => void failing.add(statement) };
}

/** A store over `faultyDatabase()`, and its `fail`. */
export async function faultyStore(options?: {
	readonly outbox?: boolean;
}): Promise<{ readonly store: ChordStore; fail(statement: TransactionStatement): void }> {
	const { db, fail } = faultyDatabase();
	return { store: (await openStore(sqliteBackend(db), BACKGROUND_CONTEXT, options)) as ChordStore, fail };
}

/**
 * Holds `store`'s next commit step inside its backend transaction, after its admission: `entered` resolves there,
 * `release()` lets it finish; later commits run as usual.
 */
export function holdNextCommit(store: ChordStore): { readonly entered: Promise<void>; release(): void } {
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const commit = store.commit.bind(store);
	store.commit = (writes, fence, ctx) => {
		store.commit = commit;
		const held: StagedWrite = {
			order: "write",
			apply: async () => {
				entered.resolve();
				await gate.promise;
				return [{ kind: "dropIndex", table: "x", name: "y" }];
			},
		};
		return commit([...writes, held], fence, ctx);
	};
	return { entered: entered.promise, release: () => gate.resolve() };
}

/** The owner of a test's table handles: its failures collected. */
export function tableOwner(failures: ChordError[] = []): TableOwner & { readonly failures: ChordError[] } {
	return { label: "app.store", scope: {}, assertLive: () => {}, fail: (error) => void failures.push(error), failures };
}

/** Creates `definition` (and its indexes) in `store` as `app.store:<name>` and returns a handle to it. */
export async function tableIn(
	store: ChordStore,
	definition: TableDefinition,
	owner = tableOwner(),
): Promise<TableHandle> {
	const table = `app.store:${definition.name}`;
	const fence = { admit: () => true, adopt: () => {} };
	await prepareTables([{ definition, table }], store, fence, "app.store", BACKGROUND_CONTEXT);
	return new TableHandle(definition, table, store, owner);
}

/** The error `promise` rejects with, as ChordError JSON when it is one. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return isChordError(error) ? error.toJSON() : error;
	}
	throw new Error("expected a rejection");
}

/** Fakes `setTimeout` and `Date` (from 0) in the calling `describe`; `setImmediate` stays real for `flushed()`. */
export function fakeTimers(): void {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
	});
	afterEach(() => {
		vi.useRealTimers();
	});
}

/** Waits until every pending promise callback has run. */
export function flushed(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** The kinds and objects of the reported `activation_failed` errors, with their causes' kinds. */
export function failures(errors: readonly HostError[]): string[] {
	return errors.flatMap((error) =>
		error.kind === "activation_failed" ? [`${error.object}: ${error.failure.kind}`] : [],
	);
}

/** The principals of the remote tests. */
export type TestPrincipal =
	| { kind: "owner" }
	| { kind: "guest"; session: string }
	| { kind: "server" }
	| { kind: "worker"; session: string };

/**
 * A server (principal `server`, loaded with one facet whose setup is `setup`) and a client connected to it, the
 * client's link stamped `child`; background errors collected per host.
 */
export async function linked(
	setup: (host: FacetHost<TestPrincipal>) => void,
	options: {
		readonly child?: TestPrincipal;
		readonly context?: Context;
		readonly telemetry?: InMemoryTelemetryContext;
		readonly readyTimeout?: number;
	} = {},
): Promise<{
	readonly server: Host<TestPrincipal>;
	readonly client: Host<TestPrincipal>;
	readonly errors: { readonly server: HostError[]; readonly client: HostError[] };
	readonly links: readonly [Link, Link];
}> {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const errors = { server: [] as HostError[], client: [] as HostError[] };
	const { telemetry, readyTimeout } = options;
	const server = createHost<TestPrincipal>({
		address: Server(),
		principal: { kind: "server" },
		telemetry,
		readyTimeout,
		onError: (error) => errors.server.push(error),
	});
	await server.load([{ name: "@test/app", facet: defineFacet<TestPrincipal>(setup) }], context);
	const client = createHost<TestPrincipal>({ telemetry, readyTimeout, onError: (error) => errors.client.push(error) });
	await client.load([], context);
	const links = memoryLinkPair();
	server.accept(links[0], { principal: options.child ?? { kind: "owner" }, codec: testCodec() }, context);
	client.connect(links[1], { principal: { kind: "server" }, codec: testCodec() }, context);
	return { server, client, errors, links };
}

/** The incarnation a raw peer greets with. */
export const RAW_PEER = "00000000-0000-7000-8000-000000000000";

/**
 * A peer speaking the wire by hand, in the current test codec, at the other end of `link`: it sends `hello` (unless
 * `hello: false`, announcing `calls`, default 256), records what arrives, acks every `bound` and `state` with its origin
 * (unless `ack: false`: then `ack()` sends one), and sends what a test forges.
 */
export class RawPeer {
	readonly received: Message[] = [];
	closed = false;
	readonly codec: Codec;
	readonly #link: Link;
	#waiters: (() => void)[] = [];

	constructor(
		link: Link,
		options: {
			readonly hello?: boolean;
			readonly calls?: number;
			readonly ack?: boolean;
			readonly codec?: Codec;
		} = {},
	) {
		this.#link = link;
		this.codec = options.codec ?? testCodec();
		link.onMessage((bytes) => {
			const message = checkMessage(this.codec.decode(bytes), BACKGROUND_CONTEXT);
			this.received.push(message);
			if (options.ack !== false && (message.kind === "bound" || message.kind === "state")) this.ack(message.origin);
			for (const wake of this.#waiters.splice(0)) wake();
		});
		link.onClose(() => {
			this.closed = true;
			for (const wake of this.#waiters.splice(0)) wake();
		});
		if (options.hello !== false) {
			this.send({ kind: "hello", protocol: PROTOCOL_VERSION, incarnation: RAW_PEER, calls: options.calls ?? 256 });
		}
	}

	send(message: Message): void {
		this.#link.send(this.codec.encode(message));
	}

	/** Acknowledges one `bound` or `state` message of `origin` (none: the peer's own). */
	ack(origin?: number): void {
		this.send(origin === undefined ? { kind: "ack" } : { kind: "ack", origin });
	}

	close(): void {
		this.#link.close();
	}

	/** Sends a message as raw bytes. */
	sendBytes(message: Uint8Array): void {
		this.#link.send(message);
	}

	/** The first received message of `kind` not taken yet, waiting for it; throws if the link closes first. */
	async next<K extends Message["kind"]>(kind: K): Promise<Extract<Message, { kind: K }>> {
		for (;;) {
			const index = this.received.findIndex((message) => message.kind === kind);
			if (index >= 0) return this.received.splice(index, 1)[0] as Extract<Message, { kind: K }>;
			if (this.closed) throw new Error(`link closed before ${kind}`);
			await new Promise<void>((resolve) => this.#waiters.push(resolve));
		}
	}

	/** The kinds received and not taken, in order. */
	kinds(): string[] {
		return this.received.map(({ kind }) => kind);
	}
}

/** A part's value as its owner reads it: opened (inflated when deflated) without limits, and parsed. */
export function partValue(part: Part): unknown {
	const unlimited = { part: Number.POSITIVE_INFINITY, decoded: Number.POSITIVE_INFINITY };
	return parsePart(openPart(part, unlimited, nodeCompression, BACKGROUND_CONTEXT));
}

/** The codecs every protocol test runs with. */
export const CODECS: readonly Codec[] = [binaryCodec, textCodec];

let currentCodec: Codec = binaryCodec;

/** The codec of the protocol test running now (`forEachCodec`); links in tests use it at both ends. */
export function testCodec(): Codec {
	return currentCodec;
}

/** Runs `suite` once per codec, as `binary codec` and `text codec`. */
export function forEachCodec(suite: () => void): void {
	for (const codec of CODECS) {
		describe(`${codec.name} codec`, () => {
			beforeAll(() => {
				currentCodec = codec;
			});
			suite();
		});
	}
}

/** The wire's indexes of a remote contract's variant (2b): the variant's, and its state members' and methods' by name. */
export function wireNames(Type: Contract, variant: string) {
	const names = variantNames(currentVariants(Type).get(variant)!);
	const indexes = (list: readonly string[]) => Object.fromEntries(list.map((name, index) => [name, index]));
	return {
		variant: variantOrder(Type).indexOf(variant),
		state: indexes(names.state),
		methods: indexes(names.methods),
		/** A message's members by index as an object by name, their parts parsed. */
		named: (members: readonly { readonly member: number; readonly ops?: Part; readonly value?: Part }[]) =>
			Object.fromEntries(members.map(({ member, ops, value }) => [names.state[member], partValue((ops ?? value)!)])),
	};
}

/** A server host as in `linked` and a raw peer on a link it accepted as `child`, with `limits`. */
export async function rawLinked(
	setup: (host: FacetHost<TestPrincipal>) => void,
	options: {
		readonly child?: Principal;
		readonly hello?: boolean;
		readonly readyTimeout?: number;
		readonly limits?: PartLimits;
		readonly compression?: Compression;
		/** What the raw peer is to the host: a child (`accept`, the default) or its parent (`connect`). */
		readonly role?: "child" | "parent";
	} = {},
): Promise<{ readonly server: Host<TestPrincipal>; readonly peer: RawPeer; readonly errors: HostError[] }> {
	const errors: HostError[] = [];
	const server = createHost<TestPrincipal>({
		address: Server(),
		principal: { kind: "server" },
		readyTimeout: options.readyTimeout,
		compression: options.compression,
		onError: (error) => errors.push(error),
	});
	await server.load([{ name: "@test/app", facet: defineFacet<TestPrincipal>(setup) }], BACKGROUND_CONTEXT);
	const [a, b] = memoryLinkPair();
	const child = (options.child ?? { kind: "owner" }) as TestPrincipal;
	const link = { principal: child, codec: testCodec(), limits: options.limits };
	if (options.role === "parent") server.connect(a, link, BACKGROUND_CONTEXT);
	else server.accept(a, link, BACKGROUND_CONTEXT);
	return { server, peer: new RawPeer(b, { hello: options.hello }), errors };
}

/** Waits until messages and closes in flight on memory links (one task per hop) have arrived. */
export async function transported(): Promise<void> {
	for (let hop = 0; hop < 6; hop++) await flushed();
}

/** The variants of the notes types: an editor variant for owners, a reader one for guests. */
const NOTES_VARIANTS = {
	editor: {
		state: { notes: arr(obj({ text: str() })), count: int() },
		methods: {
			add: method(obj({ text: str() }), int()),
			fail: method(obj({ how: str() })),
			wait: method(),
			echo: method(obj({ data: bytes() }), bytes()),
		},
	},
	reader: { state: { notes: arr(obj({ text: str() })), count: int() }, methods: { wait: method() } },
};

/** The host kind of the test servers, where every test type but `PlacedNotes` lives. */
export const Server = hostKind("server");

/** `Server()` as a hold names it on the wire: the address of every test type served on the server. */
export const SERVER_ADDRESS = { kind: "server", params: {} };

/** The remote type of the link tests: notes per session, an editor variant for owners, a reader one for guests. */
export const Notes = remote("app.notes", {
	version: 1,
	params: { session: str() },
	hostAddress: () => Server(),
	variants: NOTES_VARIANTS,
});

/** The kind of the relay tests' workers: one per session. */
export const Session = hostKind("session", { id: str() });

/** `Notes` placed on the session's worker: the relay tests' type. */
export const PlacedNotes = remote("app.placed-notes", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: NOTES_VARIANTS,
});

const NotesDoc = defineState("notes", {
	schema: obj({ list: arr(obj({ text: str() })) }),
	version: 1,
	initial: () => ({ list: [] }),
});

/** The shared store behind `Notes` (§6): the notes of a session, once, whoever views them. */
export const NoteStore = local("app.note-store", {
	version: 1,
	params: { session: str() },
	members: { list: arr(obj({ text: str() })), add: method(obj({ text: str() }), int()) },
});

/** What `serveNotes` records: the handlers' contexts of `wait` calls, and every factory run of `Notes`. */
export type NotesProbe = { readonly waits: Ctx<TestPrincipal>[]; readonly factories: string[] };

/**
 * Serves `NoteStore` and `Notes` over it: `notes` and `count` are derives over the store's list; guests get the reader
 * variant. `wait` resolves when its context is aborted; `fail` throws a ChordError (`chord`), a PluginError (`plugin`)
 * or a plain Error.
 */
export function serveNotes(
	host: FacetHost<TestPrincipal>,
	Type: typeof Notes | typeof PlacedNotes = Notes,
): NotesProbe {
	const probe: NotesProbe = { waits: [], factories: [] };
	host.serve(NoteStore, (_, self) => {
		const doc = self.state(NotesDoc);
		return {
			list: self.derive([doc], ([d]) => d.list),
			add: async ({ text }, ctx) => {
				await doc.change((draft) => void draft.list.push({ text }), ctx);
				return doc.value.list.length;
			},
		};
	});
	// The two types differ in their name and host address only.
	host.serve(Type as typeof Notes, ({ session }, principal, self) => {
		probe.factories.push(`${session} ${principal.kind}`);
		const store = self.get(NoteStore, { session });
		const notes = self.derive([store.list], ([list]) => list);
		const count = self.derive([store.list], ([list]) => list.length);
		const wait = async (ctx: Ctx<TestPrincipal>) => {
			probe.waits.push(ctx);
			await new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", resolve));
			return null;
		};
		if (principal.kind === "guest") return { variant: "reader", members: { notes, count, wait } };
		return {
			variant: "editor",
			members: {
				notes,
				count,
				wait,
				add: async (args, ctx) => store.add(args, ctx),
				fail: async ({ how }) => {
					if (how === "chord") throw new ChordError({ code: "forbidden", message: "not yours" });
					if (how === "plugin") throw new PluginError("quota", "too many", { limit: 1 });
					throw new Error("plain");
				},
				echo: async ({ data }) => data,
			},
		};
	});
	return probe;
}

/** Adds a note to the session's store from the server itself; the reference it takes keeps the store. */
export async function addNote(server: Host<TestPrincipal>, session: string, text: string): Promise<void> {
	const store = await server.get(NoteStore, { session }, BACKGROUND_CONTEXT);
	await store.add({ text }, BACKGROUND_CONTEXT);
}

/** A client connected to a raw peer playing the provider (the link's limits `limits`), after the handshake. */
export async function rawProvider(
	options: { readonly readyTimeout?: number; readonly limits?: PartLimits; readonly compression?: Compression } = {},
) {
	const errors: HostError[] = [];
	const client = createHost<TestPrincipal>({
		readyTimeout: options.readyTimeout,
		compression: options.compression,
		onError: (error) => errors.push(error),
	});
	await client.load([], BACKGROUND_CONTEXT);
	const peer = await rawParent(client, options.limits);
	return { client, peer, errors };
}

/**
 * Connects `host` to a new raw peer playing its parent (a first link, or the next after a drop), the link's limits
 * `limits`, after the handshake.
 */
export async function rawParent(host: Host<TestPrincipal>, limits?: PartLimits): Promise<RawPeer> {
	const [a, b] = memoryLinkPair();
	host.connect(a, { principal: { kind: "server" }, codec: testCodec(), limits }, BACKGROUND_CONTEXT);
	const peer = new RawPeer(b);
	await peer.next("hello");
	return peer;
}

/** Starts a `ref.state` watch and collects the states it delivers, by kind (failed ones with their error's message). */
export function statesOf(watch: NativeWatchHandle<RefState>): string[] {
	const states: string[] = [];
	watch.start(async (call) => {
		if (call.kind !== "value") return;
		const state = call.value;
		states.push(state.kind === "failed" ? `failed: ${state.cause.error.message}` : state.kind);
	});
	return states;
}

/** The wire's indexes of `Notes`'s editor variant. */
export const EDITOR = wireNames(Notes, "editor");

/** Answers the next hold with `bound`: the editor variant with `notes` and `count`. */
export async function bindNext(peer: RawPeer, notes: { text: string }[] = []) {
	const { hold } = await peer.next("hold");
	bindHold(peer, hold, notes);
	return hold;
}

/** Sends `bound` for `hold`: the editor variant with `notes` and `count`. */
export function bindHold(peer: RawPeer, hold: number, notes: { text: string }[] = []): void {
	const members = [
		{ member: EDITOR.state.notes!, value: jsonPart(notes) },
		{ member: EDITOR.state.count!, value: jsonPart(notes.length) },
	];
	peer.send({ kind: "bound", holds: [{ hold, variant: EDITOR.variant, members, failed: [] }] });
}

/**
 * Records weakly every instance of a class that calls `method` from now on, for GC tests of objects a test cannot
 * reach (holds, remote objects). Patches the prototype for the rest of the test file.
 */
export function instancesOf<T extends object>(
	Class: { readonly prototype: T },
	method: keyof T & string,
): WeakRef<T>[] {
	const instances: WeakRef<T>[] = [];
	const prototype = Class.prototype as Record<string, (...args: unknown[]) => unknown>;
	const original = prototype[method]!;
	prototype[method] = function (this: T, ...args: unknown[]) {
		instances.push(new WeakRef(this));
		return original.apply(this, args);
	};
	return instances;
}

/** What a route's `resolve` returns in the relay tests. */
export type Resolved = {
	readonly link: Link;
	readonly principal: TestPrincipal;
	readonly trusted?: boolean;
	readonly codec?: Codec;
	readonly limits?: PartLimits;
};

/** What `relayed` builds: the hosts, the links the server holds, the resolves it ran and the errors per host. */
export type Relayed = {
	readonly tab: Host<TestPrincipal>;
	readonly server: Host<TestPrincipal>;
	/** The worker of each resolved session address, the latest one per key. */
	readonly workers: Map<string, Host<TestPrincipal>>;
	/** The server's end of each resolved route link, in order. */
	readonly routeLinks: Link[];
	/** The server's end of the tab's link. */
	readonly tabLink: Link;
	/** The address keys `resolve` ran for, in order. */
	readonly resolves: string[];
	readonly errors: { readonly tab: HostError[]; readonly server: HostError[]; readonly worker: HostError[] };
};

/**
 * Three hosts: a tab connected to a server, and a server routing `Session` to an in-process worker per address (made
 * by each `resolve`, connected before it loads, W6) that serves `PlacedNotes` and `Notes`'s store. The tab acts as
 * `tab` (owner by default); `authorize` admits everyone by default; route links are trusted when `trusted`.
 * `server` and `worker` add setups of their own; `resolve` wraps the default one (`worker()` makes the worker).
 */
export async function relayed(
	options: {
		readonly tab?: TestPrincipal;
		readonly authorize?: (principal: TestPrincipal, address: { readonly key: string }) => boolean;
		readonly trusted?: boolean;
		readonly codecs?: { readonly tab?: Codec; readonly route?: Codec };
		readonly server?: (host: FacetHost<TestPrincipal>) => void;
		readonly worker?: (host: FacetHost<TestPrincipal>) => void;
		readonly resolve?: (
			address: Address<typeof Session>,
			worker: () => Resolved,
			context: Context,
		) => Promise<Resolved>;
		readonly context?: Context;
		/** The server's and the workers' `revokedBy`. */
		readonly revokedBy?: (principal: TestPrincipal) => readonly JsonValue[];
		/** The server's `revokedBy` when it differs from the workers'. */
		readonly serverRevokedBy?: (principal: TestPrincipal) => readonly JsonValue[];
		/** The compressor of each host: tab, server, workers. */
		readonly compression?: {
			readonly tab?: Compression;
			readonly server?: Compression;
			readonly worker?: Compression;
		};
		/** The limits of the tab's link at the server. */
		readonly limits?: PartLimits;
	} = {},
): Promise<Relayed> {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const errors = { tab: [] as HostError[], server: [] as HostError[], worker: [] as HostError[] };
	const workers = new Map<string, Host<TestPrincipal>>();
	const routeLinks: Link[] = [];
	const resolves: string[] = [];
	const { revokedBy, compression = {} } = options;
	const server = createHost<TestPrincipal>({
		address: Server(),
		principal: { kind: "server" },
		revokedBy: options.serverRevokedBy ?? revokedBy,
		compression: compression.server,
		onError: (error) => errors.server.push(error),
	});
	const codec = options.codecs?.route ?? testCodec();
	const worker = (address: Address<typeof Session>): Resolved => {
		resolves.push(address.key);
		const [a, b] = memoryLinkPair();
		const principal = { kind: "worker", session: address.params.id } as const;
		const host = createHost<TestPrincipal>({
			address,
			principal,
			revokedBy,
			compression: compression.worker,
			onError: (error) => errors.worker.push(error),
		});
		host.connect(b, { principal: { kind: "server" }, trusted: options.trusted, codec }, context);
		const facet = defineFacet<TestPrincipal>((h) => {
			serveNotes(h, PlacedNotes);
			options.worker?.(h);
		});
		void host.load([{ name: "@test/worker", facet }], context);
		workers.set(address.key, host);
		routeLinks.push(a);
		return { link: a, principal, trusted: options.trusted, codec };
	};
	const resolve = options.resolve ?? (async (_address, made) => made());
	server.route(
		Session,
		{
			authorize: options.authorize ?? (() => true),
			resolve: (address, routing) => resolve(address, () => worker(address), routing),
		},
		context,
	);
	await server.load(
		[{ name: "@test/server", facet: defineFacet<TestPrincipal>((h) => options.server?.(h)) }],
		context,
	);
	const tab = createHost<TestPrincipal>({ compression: compression.tab, onError: (error) => errors.tab.push(error) });
	await tab.load([], context);
	const [a, b] = memoryLinkPair();
	const tabCodec = options.codecs?.tab ?? testCodec();
	const accepted = { principal: options.tab ?? { kind: "owner" }, codec: tabCodec, limits: options.limits } as const;
	server.accept(a, accepted, context);
	tab.connect(b, { principal: { kind: "server" }, codec: tabCodec }, context);
	return { tab, server, workers, routeLinks, tabLink: a, resolves, errors };
}

/**
 * A `resolve` for `relayed` whose workers are raw peers playing the provider, collected in `peers` in order; their
 * links trusted when `trusted`.
 */
export function rawWorkers(
	peers: RawPeer[],
	options: {
		readonly calls?: number;
		readonly ack?: boolean;
		readonly trusted?: boolean;
		readonly limits?: PartLimits;
	} = {},
): (address: Address<typeof Session>) => Promise<Resolved> {
	return async (address) => {
		const [a, b] = memoryLinkPair();
		peers.push(new RawPeer(b, options));
		const principal = { kind: "worker", session: address.params.id } as const;
		return { link: a, principal, codec: testCodec(), trusted: options.trusted, limits: options.limits };
	};
}

/** A host's incarnation, which its handshakes send. */
export function incarnationOf(host: Host<TestPrincipal>): string {
	// Every host is a `ChordHost`.
	return (host as unknown as { readonly incarnation: string }).incarnation;
}

/** Counts the bytes every `DecompressionStream` puts out while installed; `restore` puts the real one back. */
export function countInflated(): { readonly bytes: number; restore(): void } {
	const Real = globalThis.DecompressionStream;
	const counter = { bytes: 0, restore: () => vi.unstubAllGlobals() };
	class Counted {
		readonly writable: WritableStream<BufferSource>;
		readonly readable: ReadableStream<Uint8Array>;
		constructor(format: CompressionFormat) {
			const real = new Real(format);
			this.writable = real.writable;
			this.readable = real.readable.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						counter.bytes += chunk.byteLength;
						controller.enqueue(chunk);
					},
				}),
			);
		}
	}
	vi.stubGlobal("DecompressionStream", Counted);
	return counter;
}

/** The tables of `archiveStore`: edits (v1 with an index; v2 adds `done`) and notes, whose v2 migration crashed. */
export const ArchiveTables = (() => {
	const EditsV1 = defineTable("edits", {
		version: 1,
		columns: {
			id: str(),
			path: str(),
			at: int(),
			note: opt(str()),
			meta: opt(json(obj({ a: int() }), { version: 1 })),
		},
		key: ["id"],
		indexes: { by_path: ["path", "at"] },
	});
	const EditsV2 = evolveTable(EditsV1, (t) => t.add("done", bool({ default: false })));
	const NotesV1 = defineTable("notes", { version: 1, columns: { id: int(), text: str() }, key: ["id"] });
	const NotesV2 = evolveTable(NotesV1, (t) =>
		t.rows((row) => {
			if (row.id === 120) throw new Error("crash");
			return { text: `${row.text}!` };
		}),
	);
	return { EditsV1, EditsV2, NotesV1, NotesV2 };
})();

/**
 * A store holding a bit of everything an archive carries: `app.store:edits` at version 2 with 150 rows (two
 * export pages; some written at version 1, `NULL` and `json(...)` cells, an index), `app.store:notes` left
 * `migrating` at version 2 after one committed chunk, and documents: a singleton, keyed ones with deltas after their
 * base, and a retired one.
 */
export async function archiveStore(options?: { readonly outbox?: boolean }): Promise<ChordStore> {
	const { EditsV1, EditsV2, NotesV1, NotesV2 } = ArchiveTables;
	const store = await memoryStore(options);
	const fence = { admit: () => true, adopt: () => {} };
	const edits = await tableAt(store, "app.store:edits", EditsV1);
	const notes = await tableAt(store, "app.store:notes", NotesV1);
	const staged: StagedWrite[] = [];
	const editChanges = new TableChanges(edits, staged);
	for (let i = 0; i < 150; i++) {
		editChanges.put({
			id: `e${String(i).padStart(3, "0")}`,
			path: `p/${i % 4}`,
			at: i,
			...(i % 2 === 0 ? { note: `n${i}` } : {}),
			...(i % 3 === 0 ? { meta: { a: i } } : {}),
		});
	}
	const noteChanges = new TableChanges(notes, staged);
	for (let i = 0; i < 150; i++) noteChanges.put({ id: i, text: `t${i}` });
	await store.commit(staged, fence, BACKGROUND_CONTEXT);
	await prepareTables([{ definition: EditsV2, table: "app.store:edits" }], store, fence, "app", BACKGROUND_CONTEXT);
	await prepareTables(
		[{ definition: NotesV2, table: "app.store:notes" }],
		store,
		fence,
		"app",
		BACKGROUND_CONTEXT,
	).catch(() => {});
	const address = { namespace: "chord", owner: "app.store", kind: "memo" };
	const base = (value: JsonValue) => ({ version: 1, fingerprint: "f1", value });
	let ids: readonly number[] = [];
	const created = {
		admit: () => true,
		adopt: (_: number, created: readonly number[]) => {
			ids = created;
		},
	};
	await store.commit(
		["", "a", "b", "gone"].map((key) =>
			createDocument({ ...address, key }, base({ title: key }), JSON.stringify({ title: key })),
		),
		created,
		BACKGROUND_CONTEXT,
	);
	const [, a, b, gone] = ids;
	const delta = (title: string) => ({ kind: "delta", version: 1, ops: [["s", ["title"], title]] }) as const;
	await store.commit(
		[changeDocument(a!, 1, delta("a2"), JSON.stringify(delta("a2").ops)), retireDocument(gone!, 1)],
		fence,
		BACKGROUND_CONTEXT,
	);
	await store.commit([changeDocument(a!, 2, delta("a3"), JSON.stringify(delta("a3").ops))], fence, BACKGROUND_CONTEXT);
	await store.commit([changeDocument(b!, 1, delta("b2"), JSON.stringify(delta("b2").ops))], fence, BACKGROUND_CONTEXT);
	return store;
}

/** `definition` prepared as `table` in `store`, and a handle to it. */
async function tableAt(store: ChordStore, table: string, definition: TableDefinition): Promise<TableHandle> {
	await prepareTables(
		[{ definition, table }],
		store,
		{ admit: () => true, adopt: () => {} },
		"app",
		BACKGROUND_CONTEXT,
	);
	return new TableHandle(definition, table, store, tableOwner());
}

/** Every part of `store`'s export. */
export async function exported(store: Store): Promise<ArchivePart[]> {
	const parts: ArchivePart[] = [];
	for await (const part of store.export(BACKGROUND_CONTEXT)) parts.push(part);
	return parts;
}
