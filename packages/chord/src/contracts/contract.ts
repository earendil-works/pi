// Contract handles: the branded, immutable value an app declares, its type-level shape, and the Chord-owned data
// behind it.

import type { Context } from "../context/index.ts";
import type { Watchable, WatchHandle } from "../watch.ts";
import type { Change, CurrentStep, History, MembersShape } from "./history.ts";
import type { Address, KindShape } from "./host-kind.ts";
import type { Params, ParamsData } from "./params.ts";
import type { Grantable, Method, NullSchema, QueriesMember, Schema, Static, Ungranted } from "./schema.ts";
import type { Snapshot } from "./snapshot.ts";

export type Kind = "remote" | "local";

/**
 * Everything the types know about a contract: kind, name, params, the whole history and, for a remote contract that
 * declares them, the schema of its admission's data and its flags (rights that are no member, slice 15 §1).
 */
export type ContractShape = {
	readonly kind: Kind;
	readonly name: string;
	readonly params: Params;
	readonly history: History;
	readonly admission?: Schema;
	readonly flags?: { readonly [flag: string]: string };
};

/** A declared contract: a branded handle, immutable by convention. Spread or hand-built copies are refused. */
export interface Contract<S extends ContractShape = ContractShape> {
	readonly kind: S["kind"];
	readonly name: S["name"];
	readonly version: number;
	readonly fingerprint: string;
	/** Type only: absent at runtime. */
	readonly "~shape"?: S;
}

export type ShapeOf<C extends Contract> = NonNullable<C["~shape"]>;

/** The members of a contract's current version. */
export type CurrentMembers<C extends Contract> = CurrentStep<ShapeOf<C>["history"]>["members"];

/**
 * The names an admission may grant on `C` (slice 15 §1.2): its grantable members and its flags; `never` for a contract
 * without any.
 */
export type GrantableName<C extends Contract> =
	| GrantableIn<CurrentMembers<C>>
	| (ShapeOf<C> extends { readonly flags: infer F } ? keyof F & string : never);

/** The grantable members of a members shape, by name. */
export type GrantableIn<S extends MembersShape> =
	| { [M in keyof S["state"]]: S["state"][M] extends Grantable ? M : never }[keyof S["state"]]
	| { [M in keyof S["methods"]]: S["methods"][M] extends Grantable ? M : never }[keyof S["methods"]]
	| {
			[M in keyof NonNullable<S["events"]>]: NonNullable<S["events"]>[M] extends Grantable ? M : never;
	  }[keyof NonNullable<S["events"]>];

/**
 * The value a contract's admission hands its factory (slice 14 §2.1, slice 15 §1.2): the data its `admission` schema
 * describes and the names granted to the caller; `never` for a contract that takes no admission.
 */
export type AdmittedOf<C extends Contract> = WithData<C, { readonly granted: ReadonlySet<GrantableName<C>> }>;

/**
 * The value an admission allows (`allow(value)`): the data its `admission` schema describes, and the grantable names
 * the caller gets (none when left out).
 */
export type AllowedOf<C extends Contract> = WithData<C, { readonly granted?: readonly GrantableName<C>[] }>;

/**
 * `G` with the data `C`'s `admission` schema declares; `never` for a contract not served with `admit` (it declares no
 * `admission`, grantable members or flags).
 */
type WithData<C extends Contract, G> = ShapeOf<C> extends { readonly admission: infer A extends Schema }
	? Static<A> & G
	: [GrantableName<C>] extends [never]
		? never
		: G;

/** The params object of a contract. */
export type ParamsOf<C extends Contract> = { [F in keyof ShapeOf<C>["params"]]: Static<ShapeOf<C>["params"][F]> };

/**
 * What a factory returns: a `Watchable` per state member, a function per method, `(args, context)`, or `(context)`
 * when the method takes no arguments, an event member per event member; a remote contract's grantable state and event
 * members as builders, `() => watchable`, called only if granted (slice 15 §1.3). `X` is the context the methods get.
 */
export type Implementation<C extends Contract, X extends Context = Context> = ShapeOf<C>["kind"] extends "local"
	? MembersImplementation<CurrentMembers<C>, X>
	: RemoteImplementation<CurrentMembers<C>, X>;

/**
 * Members: a `Watchable` per state member, a function per method, an `EventMember` per event member (an object's own
 * `EventSource`, or a reference's member it re-exposes) and, in a local contract, a `KeyedWatchable` per keyed member
 * and the named queries of a `queries` member. A grantable member is typed as the member it marks.
 */
export type MembersImplementation<V extends MembersShape, X extends Context = Context> = {
	[M in
		| keyof V["state"]
		| keyof V["methods"]
		| keyof NonNullable<V["keyed"]>
		| keyof NonNullable<V["events"]>
		| keyof NonNullable<V["queries"]>]: M extends keyof V["methods"]
		? MethodFunction<Ungranted<V["methods"][M]>, X>
		: M extends keyof V["state"]
			? Watchable<Static<Ungranted<V["state"][M]>>>
			: M extends keyof NonNullable<V["keyed"]>
				? KeyedWatchable<Static<NonNullable<V["keyed"]>[M]>, KeyOfMember<NonNullable<V["keyed"]>[M]>>
				: M extends keyof NonNullable<V["events"]>
					? EventMember<Static<Ungranted<NonNullable<V["events"]>[M]>>>
					: M extends keyof NonNullable<V["queries"]>
						? NamedQueriesOf<NonNullable<V["queries"]>[M]>
						: never;
};

/** A remote factory's members: as `MembersImplementation`, with grantable state and event members as builders. */
type RemoteImplementation<V extends MembersShape, X extends Context> = {
	[M in keyof MembersImplementation<V, X>]: M extends Exclude<GrantableIn<V>, keyof V["methods"]>
		? () => MembersImplementation<V, X>[M]
		: MembersImplementation<V, X>[M];
};

/** The named queries of a `queries` member declaration: one per listed name, typed by its item and arguments. */
export type NamedQueriesOf<Q> = Q extends QueriesMember<infer I, infer A>
	? { readonly [N in keyof A]: NamedQuery<Static<I>, Static<A[N]>> }
	: never;

/** A page of a named query's items and, when more follow, the cursor to continue after it. */
export type QueryPage<T> = { readonly items: T[]; readonly next?: string };

/**
 * A named query (slice 14 §3.1): a query a store offers under a name, with arguments of `A` and items of `T`. Read
 * live with `self.liveQuery`, counted with `self.count`, shown as a list with `self.list`, or read a page at a time.
 */
export interface NamedQuery<T, A> {
	/** Up to `limit` items for `args` (after `options.after`), and the cursor of the next page when there is one. */
	page(args: A, limit: number, context: Context, options?: { readonly after?: string }): Promise<QueryPage<T>>;
	/** Type only: the arguments. */
	readonly "~args"?: A;
}

/**
 * A subscription to an event member (`EventMember.on`): it lives until `stop()`, its context's abort or its reference's
 * release.
 */
export interface EventSubscription {
	/** Ends the subscription; its listener is not called again, a call already due included. Idempotent. */
	stop(): void;
}

/**
 * An event member as its readers have it (decision "Events: fire-and-forget members"): a reference's, which receives
 * the values its object emits while it is bound to an instance that has the member (granted it), never one emitted before
 * it bound, never replayed. Not a `Watchable`: no value, no derive or routine source.
 */
export interface EventMember<T> {
	/**
	 * Subscribes `listener` at once, bound or not: it gets every event delivered to this member from now on, `at` the
	 * emitting host's `Date.now()` at the emit. Rejects `released` for a released reference and with the abort reason of
	 * an aborted `ctx`.
	 */
	on(listener: (event: { readonly value: T; readonly at: number }) => void, ctx: Context): Promise<EventSubscription>;
}

/** An event member as its object owns it (`self.events<T>()`): it emits. */
export interface EventSource<T> extends EventMember<T> {
	/**
	 * Emits `value` now, outside any transaction: delivered after every state change published before the event flush
	 * (a microtask), to the references bound before this emit. Throws `released` after its attempt's seal.
	 */
	emit(value: T): void;
}

/**
 * A keyed state member (slice 6a §12): documents by key, each watchable on its own; a keyed document handle
 * provides it. `at(key)` is valid only in a factory (it pins the key while that attempt lives).
 */
export interface KeyedWatchable<T, Key = string> {
	/** The document at `key`, `undefined` when absent. */
	get(key: Key, context: Context): Promise<T | undefined>;
	/** A watch of the document at `key` that follows its address, `undefined` when absent. */
	watch(key: Key, context: Context): Promise<WatchHandle<T> | undefined>;
	/** In a factory only: the document at `key` as a watchable, `initial()` while absent. */
	at(key: Key): Watchable<T>;
}

/**
 * A host-keyed member's schema in a contract's types: its documents' schema carrying the key's host kind (type only;
 * `keyed(schema, kind)` declares it).
 */
export type HostKeyed<S, K extends KindShape> = S & { readonly "~key"?: K };

/** The key type of a keyed member's schema: an address of its host kind, or a string. */
export type KeyOfMember<S> = S extends { readonly "~key"?: infer K }
	? K extends KindShape
		? Address<K>
		: string
	: string;

/** A method as a function: without the argument when its argument schema is `null` (`null` stays the wire form). */
type MethodFunction<M extends Method, X extends Context = Context> = M["args"] extends NullSchema
	? (context: X) => Promise<Static<M["result"]>>
	: (args: Static<M["args"]>, context: X) => Promise<Static<M["result"]>>;

/** The Chord-owned data behind a contract handle. */
export type ContractData = {
	readonly kind: Kind;
	readonly name: string;
	readonly params: ParamsData;
	/** A remote contract's host address: the address of the host serving an object for its params; none for local. */
	readonly hostAddress: HostAddress | undefined;
	/** Every version of the history, oldest first; the last is current. */
	readonly versions: readonly VersionData[];
	/** The kind of every member name ever declared in the history. */
	readonly kinds: ReadonlyMap<string, MemberKind>;
	/** A remote contract's admission, as its current version declares it; none without one, and for local. */
	readonly admission: AdmissionData | undefined;
	/** A remote contract's flags (slice 15 §1.1): rights that are no member, each with its label; fixed for its history. */
	readonly flags: ReadonlyMap<string, string>;
};

/**
 * A contract's admission (slice 14 §2.1): the schema of the data its factory is handed, and that schema's
 * fingerprint. Never part of the contract's fingerprint; a reload's staging compares it (the value is never checked).
 */
export type AdmissionData = { readonly schema: Snapshot; readonly fingerprint: string };

export type MemberKind = "state" | "method" | "keyed" | "event" | "queries";

/** A `hostAddress` as Chord calls it: with checked params. Plugin code: what it returns is checked where routed. */
export type HostAddress = (params: ParamsOf<Contract>) => Address;

export type VersionData = {
	readonly version: number;
	readonly fingerprint: string;
	readonly members: MembersData;
	/** Its grantable members (slice 15 §1): a remote contract's; a caller has one only if its admission granted it. */
	readonly grantable: ReadonlySet<string>;
	/** The names an admission may grant at this version, sorted: its grantable members and the flags (the wire's indexes). */
	readonly grants: readonly string[];
	/** The changes that produced this version; empty for a base. */
	readonly changes: readonly Change[];
};

/** A contract version's members, or the part of them one binding was granted. */
export type MembersData = {
	readonly state: ReadonlyMap<string, Snapshot>;
	readonly methods: ReadonlyMap<string, MethodData>;
	/** Keyed state members (slice 6a §12): only a local contract has any. */
	readonly keyed: ReadonlyMap<string, KeyedSnapshot>;
	/** Event members: their values' schemas (JSON only). */
	readonly events: ReadonlyMap<string, Snapshot>;
	/** `queries` members (slice 14 §3.1): only a local contract has any. */
	readonly queries: ReadonlyMap<string, QueriesData>;
};

/** A `queries` member's snapshots: its items' schema, and each named query's arguments. */
export type QueriesData = { readonly item: Snapshot; readonly args: ReadonlyMap<string, Snapshot> };

/** A keyed member's schema snapshot and, for a host-keyed one, the host kind its keys are addresses of. */
export type KeyedSnapshot = Snapshot & { readonly key?: KindShape & { readonly kind: string } };

export type MethodData = { readonly args: Snapshot; readonly result: Snapshot };

/** The data behind a contract handle; refuses spread and hand-built copies. */
export function contractData(contract: Contract): ContractData {
	const data = contracts.get(contract);
	if (data === undefined) {
		throw new Error(`${contract.name}: not a declared contract (spread and hand-built copies are refused)`);
	}
	return data;
}

const contracts = new WeakMap<Contract, ContractData>();

/** Whether a method takes no arguments: its argument schema is `null`, so its functions omit the argument. */
export function takesNoArgs(method: MethodData): boolean {
	// A schema's normal form is an object of keywords.
	const normal = method.args.normal as { readonly [keyword: string]: unknown };
	return normal.type === "null" && Object.keys(normal).length === 1;
}

/** A contract's current version. */
export function currentVersion(contract: Contract): VersionData {
	return contractData(contract).versions.at(-1)!;
}

/** The members of a contract's current version. */
export function currentMembers(contract: Contract): MembersData {
	return currentVersion(contract).members;
}

/** The member names of a contract, by kind. */
export type MemberNames = {
	readonly state: readonly string[];
	readonly methods: readonly string[];
	readonly events: readonly string[];
};

/**
 * The names of the state members, methods and event members of a contract's current version, grantable ones included,
 * in the order declared: for code that fills an implementation from another object's members. A local contract's keyed
 * and `queries` members are not among them.
 */
export function memberNames(contract: Contract): MemberNames {
	const { state, methods, events } = currentMembers(contract);
	return { state: [...state.keys()], methods: [...methods.keys()], events: [...events.keys()] };
}

/** Version `version` of a contract's history (an older consumer's binding, Q10). */
export function versionAt(contract: Contract, version: number): VersionData {
	// Callers name a version the provider binds (`binds`): its history has it.
	return contractData(contract).versions.find((data) => data.version === version)!;
}

/** Granted nothing: the shared empty set (a contract without grantable members, a denied or unbound reference). */
export const NO_GRANTS: ReadonlySet<string> = new Set();

/**
 * The members of `version` a binding granted `granted` has: its plain members and the granted ones. Shared per version
 * and set of granted members (a `WeakMap` keyed by the version: gone with its contract), and found by the set itself
 * first: granted sets are shared (`grantedSet` in `host/admission.ts`), so a bind makes no key (0.95 KiB per bind).
 */
export function grantedMembers(version: VersionData, granted: ReadonlySet<string>): MembersData {
	if (version.grantable.size === 0) return version.members;
	let shapes = grantedShapes.get(version);
	if (shapes === undefined) {
		shapes = { bySet: new WeakMap(), byNames: new Map() };
		grantedShapes.set(version, shapes);
	}
	let members = shapes.bySet.get(granted);
	if (members !== undefined) return members;
	// Another set of the same names (a consumer's, a test's) shares the members of its names' key.
	const kept = [...version.grantable].filter((member) => granted.has(member)).sort();
	const key = JSON.stringify(kept);
	members = shapes.byNames.get(key);
	if (members === undefined) {
		const plain = <T>(entries: ReadonlyMap<string, T>): ReadonlyMap<string, T> =>
			new Map([...entries].filter(([member]) => !version.grantable.has(member) || granted.has(member)));
		const { state, methods, keyed, events, queries } = version.members;
		members = { state: plain(state), methods: plain(methods), keyed, events: plain(events), queries };
		shapes.byNames.set(key, members);
	}
	shapes.bySet.set(granted, members);
	return members;
}

/** A version's granted members: by the granted set (while it lives), and by the granted members' names. */
type GrantedShapes = {
	readonly bySet: WeakMap<ReadonlySet<string>, MembersData>;
	readonly byNames: Map<string, MembersData>;
};

const grantedShapes = new WeakMap<VersionData, GrantedShapes>();

/**
 * The names of `granted` as the wire carries them: indexes into `version.grants` (names it lacks are left out), in a
 * list of the caller's own (a message's lists are its codec's to write, which may be user code). Computed once per
 * version and granted set, kept while both live, and copied: a copy of 2 indexes allocates 35 B in 6 ns, a walk of
 * the grants into a grown list 200 B in 36 ns.
 */
export function grantIndexes(version: VersionData, granted: ReadonlySet<string>): number[] {
	if (granted.size === 0) return NO_INDEXES;
	let lists = grantIndexLists.get(version);
	if (lists === undefined) {
		lists = new WeakMap();
		grantIndexLists.set(version, lists);
	}
	let indexes = lists.get(granted);
	if (indexes === undefined) {
		indexes = [];
		const { grants } = version;
		for (let index = 0; index < grants.length; index++) if (granted.has(grants[index]!)) indexes.push(index);
		lists.set(granted, indexes);
	}
	return indexes.slice();
}

const grantIndexLists = new WeakMap<VersionData, WeakMap<ReadonlySet<string>, number[]>>();

/** No indexes: one shared empty list, as before the hot-path pass. */
const NO_INDEXES: number[] = [];

/**
 * Members' names in the order links index them: each kind sorted; members without event members share one empty list.
 * Made once per `members` (a version's, or a version's granted to one set of names: every binding of them shares the
 * lists) and kept weakly: gone with its contract.
 */
export function memberOrder(members: MembersData): MemberNames {
	let order = memberOrders.get(members);
	if (order === undefined) {
		order = {
			state: [...members.state.keys()].sort(),
			methods: [...members.methods.keys()].sort(),
			events: members.events.size === 0 ? NO_NAMES : [...members.events.keys()].sort(),
		};
		memberOrders.set(members, order);
	}
	return order;
}

const memberOrders = new WeakMap<MembersData, MemberNames>();

const NO_NAMES: readonly string[] = [];

/** A new contract handle for `data`; the caller states the type-level shape. */
export function createContract<C extends Contract>(data: ContractData): C {
	const current = data.versions.at(-1)!;
	const contract: Contract = {
		kind: data.kind,
		name: data.name,
		version: current.version,
		fingerprint: current.fingerprint,
	};
	contracts.set(contract, data);
	// The shape is type-level only; every caller states the shape it built.
	return contract as C;
}
