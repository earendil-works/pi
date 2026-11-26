// Kinds of things: `defineThing` declares a kind (its members, flags and ticks, who makes its things, where they may be
// linked, how several reaching one workspace combine, what a new link starts with, how older ticks read) and makes its remote contract,
// params `{ workspace, thing }`, on the server: a member no tick gives is there for everyone admitted, the others are
// grantable. `expand` turns tick names into the members and flags they give. `ThingKinds` is the registry of every
// kind's data, which the things plugin's index and (later) the page read. Data only: kinds' contract files import it.

import {
	type Contract,
	defineRegistry,
	type Grantable,
	type GrantableName,
	grantable,
	type MessageData,
	type Method,
	remote,
	type Schema,
	Server,
	type TableItem,
} from "@earendil-works/p3/v1";
import { THING_PARAMS, ThingAdmission } from "./contract.ts";

/** Whom a tick can be given: the agents (the agents party, one session's agent), people (everyone, groups, persons), or both. */
export type TickFor = "agents" | "people" | "all";

/** A tick as a kind declares it: its label, whom it is for, and the members and flags it gives. */
export type TickDeclaration<G extends string> = {
	readonly label: MessageData;
	readonly for?: TickFor;
	readonly gives: readonly G[];
};

/** Who makes things of a kind (decision 10): people and agents, people only, or only the kind's own plugin. */
export type Makers = "anyone" | "people" | "plugin";

/** In how many workspaces a thing of a kind may be linked. */
export type Workspaces = "one" | "many";

/** How several things of a kind reaching one workspace combine (decision 75): all apply, or only the nearest. */
export type Stacking = "all" | "nearest";

/** What a new link of a thing of a kind starts with: the ticks of everyone here and of the agents. */
export type DefaultGrants<T extends string = string> = {
	readonly everyone?: readonly T[];
	readonly agents?: readonly T[];
};

/** A kind's data as every host reads it from `ThingKinds`: what the index, the Settings view and the picker need. */
export type KindInfo = {
	readonly name: string;
	readonly version: number;
	readonly workspaces: Workspaces;
	readonly makers: Makers;
	readonly stacking: Stacking;
	/** Whether things of it are workspaces: none of slice 1's kinds are. */
	readonly workspace: "no" | "plain" | "leaf";
	readonly ticks: readonly { readonly name: string; readonly label: MessageData; readonly for: TickFor }[];
	readonly defaultGrants: DefaultGrants;
	/**
	 * Tick names written at an older version `from`, as this version's (item 91, as Chord's `migrate`): pure. Without
	 * it, a grant of an older version counts for nothing and is reported, never guessed.
	 */
	readonly migrateTicks?: (ticks: readonly string[], from: number) => string[];
};

/** Every kind registered, by name, each with its plugin (the first by plugin name wins a name). */
export const ThingKinds = defineRegistry<KindInfo, ReadonlyMap<string, TableItem<KindInfo>>>("things.kinds", {
	version: 1,
});

/** A kind: its data, its remote contract, and its ticks as the names of members and flags they give. */
export type ThingKind<C extends Contract = Contract> = {
	readonly name: string;
	readonly info: KindInfo;
	readonly contract: C;
	/** Every member and flag a tick gives: what the server and an owner are granted. */
	readonly all: readonly GrantableName<C>[];
	/** Each tick's members and flags. */
	readonly gives: ReadonlyMap<string, readonly GrantableName<C>[]>;
};

/** The contract of a kind. */
export type ContractOf<K> = K extends ThingKind<infer C> ? C : never;

type States = { readonly [member: string]: Schema };
type Methods = { readonly [member: string]: Method };
type Flags = { readonly [flag: string]: MessageData };
type Ticks = { readonly [tick: string]: TickDeclaration<string> };

/** The member and flag names the ticks `T` give. */
type GivenBy<T extends Ticks> = { [K in keyof T]: T[K]["gives"][number] }[keyof T];

/** Members `D` with those named in `G` marked grantable. */
type Marked<D, G> = { [K in keyof D]: K extends G ? Grantable<D[K] & (Schema | Method)> : D[K] };

/** The remote contract `defineThing` makes for kind `N`. */
type ThingContract<
	N extends string,
	V extends number,
	S extends States,
	M extends Methods,
	E extends States,
	F extends Flags,
	G,
> = Contract<{
	kind: "remote";
	name: N;
	params: typeof THING_PARAMS;
	history: [
		{
			version: `${V}`;
			members: { state: Marked<S, G>; methods: Marked<M, G>; events: Marked<E, G> };
			changes: never;
		},
	];
	admission: typeof ThingAdmission;
	flags: { [K in keyof F]: string };
}>;

/**
 * Declares kind `name` (its plugin's, `<plugin>.<kind>`): its members (`state`, `methods`, `events`) and `flags`, its
 * `ticks` (a tick gives members and flags; a member no tick gives is there for everyone admitted), whom its ticks are
 * for, its default grants (its maker gets every tick, item 90), who makes its things (`plugin` by default), in how many workspaces one may be
 * linked (`many`), how several combine (`all`), and how ticks written at an older version read now (`migrateTicks`).
 */
export function defineThing<
	const N extends string,
	const V extends number,
	const T extends Ticks,
	const S extends States = Record<never, never>,
	const M extends Methods = Record<never, never>,
	const E extends States = Record<never, never>,
	const F extends Flags = Record<never, never>,
>(
	name: N,
	declaration: {
		readonly version: V;
		readonly state?: S;
		readonly methods?: M;
		readonly events?: E;
		readonly flags?: F;
		readonly ticks: T & { readonly [K in keyof T]: TickDeclaration<keyof (S & M & E & F) & string> };
		readonly defaultGrants?: DefaultGrants<keyof T & string>;
		readonly makers?: Makers;
		readonly workspaces?: Workspaces;
		readonly stacking?: Stacking;
		readonly migrateTicks?: (ticks: readonly string[], from: number) => string[];
	},
): ThingKind<ThingContract<N, V, S, M, E, F, GivenBy<T>>> {
	const ticks = Object.entries(declaration.ticks);
	const given = new Set(ticks.flatMap(([, tick]) => tick.gives));
	checkTicks(name, declaration, given);
	const marked = <D extends States | Methods>(members: D | undefined) =>
		Object.fromEntries(
			Object.entries(members ?? {}).map(([member, schema]) => [
				member,
				given.has(member) ? grantable(schema) : schema,
			]),
		);
	// The members' marks are computed, which `remote`'s literal declaration types cannot follow: the result is typed
	// as `ThingContract` below.
	const contract = (remote as (name: string, declaration: object) => Contract)(name, {
		version: declaration.version,
		params: THING_PARAMS,
		hostAddress: () => Server(),
		admission: ThingAdmission,
		state: marked(declaration.state),
		methods: marked(declaration.methods),
		events: marked(declaration.events),
		flags: flagLabels(declaration.flags ?? {}),
	});
	const info: KindInfo = {
		name,
		version: declaration.version,
		workspaces: declaration.workspaces ?? "many",
		makers: declaration.makers ?? "plugin",
		stacking: declaration.stacking ?? "all",
		workspace: "no",
		ticks: ticks.map(([tick, { label, for: forWhom }]) => ({ name: tick, label, for: forWhom ?? "all" })),
		defaultGrants: declaration.defaultGrants ?? {},
		...(declaration.migrateTicks === undefined ? {} : { migrateTicks: declaration.migrateTicks }),
	};
	// The contract is `remote`'s over the members marked as `ThingContract` spells out; the names are the ticks' own.
	type C = ThingContract<N, V, S, M, E, F, GivenBy<T>>;
	const gives = new Map(ticks.map(([tick, { gives }]) => [tick, gives as readonly GrantableName<C>[]]));
	return { name, info, contract: contract as unknown as C, all: [...given] as GrantableName<C>[], gives };
}

/**
 * Declaration policy the types state but JavaScript callers can skip (decision 95): a tick gives only the kind's
 * members and flags, and every flag is given by a tick (a flag nobody can be given is no right).
 */
function checkTicks(
	name: string,
	{ state, methods, events, flags }: { state?: States; methods?: Methods; events?: States; flags?: Flags },
	given: ReadonlySet<string>,
): void {
	const names = new Set([state, methods, events, flags].flatMap((members) => Object.keys(members ?? {})));
	for (const gives of given) {
		if (!names.has(gives)) throw new Error(`${name}.ticks: "${gives}" is no member or flag of the kind`);
	}
	for (const flag of Object.keys(flags ?? {})) {
		if (!given.has(flag)) throw new Error(`${name}.flags.${flag}: no tick gives it`);
	}
}

/**
 * The flags' labels as Chord takes them today: a plain string, here the message's `namespace.key`. Flag labels as
 * `MessageData` (decisions 65, 69) are built on Chord's branch `flag-messages` (0f04aee2c, in review); once it lands
 * the messages are passed as they are, and this is the one place to change.
 */
function flagLabels(flags: Flags): Record<string, string> {
	return Object.fromEntries(Object.entries(flags).map(([flag, { namespace, key }]) => [flag, `${namespace}.${key}`]));
}

/** The members and flags `ticks` give on `Kind`, each once; a tick the kind does not have gives nothing (R3). */
export function expand<C extends Contract>(Kind: ThingKind<C>, ticks: readonly string[]): GrantableName<C>[] {
	const names = new Set<GrantableName<C>>();
	for (const tick of ticks) for (const name of Kind.gives.get(tick) ?? []) names.add(name);
	return [...names];
}
