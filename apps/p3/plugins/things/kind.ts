// Kinds of things: `defineThing` declares a kind (its members and ticks, flag ticks among them, who makes its things, where they may be
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

/**
 * A tick as a kind declares it: its label, whom it is for, and the members and flag ticks it gives; without `gives` it
 * is a flag tick, a right of its own (a Chord flag of its name, decision 97).
 */
export type TickDeclaration<G extends string> = {
	readonly label: MessageData;
	readonly for?: TickFor;
	readonly gives?: readonly G[];
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
	readonly ticks: readonly { readonly name: string; readonly label: MessageData; readonly for: TickFor }[];
	readonly defaultGrants: DefaultGrants;
	/**
	 * The version of the ticks' meaning (item 105; 1 by default): bumped only when tick names change meaning, apart
	 * from the contract's `version`. Grants record it.
	 */
	readonly ticksVersion: number;
	/**
	 * Tick names written at an older `ticksVersion` `from`, as this one's (as a document's `migrate`): pure. A grant of
	 * an older ticks version without one, or one it throws for, counts for nothing and is reported once.
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
	/** Each tick's members and flags (a flag tick's: itself). */
	readonly gives: ReadonlyMap<string, readonly GrantableName<C>[]>;
};

type States = { readonly [member: string]: Schema };
type Methods = { readonly [member: string]: Method };
type Ticks = { readonly [tick: string]: TickDeclaration<string> };

/** The flag ticks of `T`: those without `gives`, each a flag of its own name (decision 97). */
type FlagTicks<T extends Ticks> = {
	[K in keyof T]: T[K] extends { readonly gives: readonly string[] } ? never : K;
}[keyof T] &
	string;

/** The member and flag names the ticks `T` give (a flag tick gives itself). */
type GivenBy<T extends Ticks> =
	| { [K in keyof T]: T[K] extends { readonly gives: readonly (infer G)[] } ? G : never }[keyof T]
	| FlagTicks<T>;

/** Members `D` with those named in `G` marked grantable. */
type Marked<D, G> = { [K in keyof D]: K extends G ? Grantable<D[K] & (Schema | Method)> : D[K] };

/** The remote contract `defineThing` makes for kind `N`. */
type ThingContract<
	N extends string,
	V extends number,
	S extends States,
	M extends Methods,
	E extends States,
	T extends Ticks,
> = Contract<{
	kind: "remote";
	name: N;
	params: typeof THING_PARAMS;
	history: [
		{
			version: `${V}`;
			members: { state: Marked<S, GivenBy<T>>; methods: Marked<M, GivenBy<T>>; events: Marked<E, GivenBy<T>> };
			changes: never;
		},
	];
	admission: typeof ThingAdmission;
	flags: { [K in FlagTicks<T>]: string };
}>;

/**
 * Declares kind `name` (its plugin's, `<plugin>.<kind>`): its members (`state`, `methods`, `events`), its `ticks` (a
 * tick gives members and flag ticks; a tick without `gives` is a flag of its own name, decision 97; a member no tick
 * gives is there for everyone admitted), whom its ticks are for, its default grants (its maker gets every tick, item
 * 90), who makes its things (`plugin` by default), in how many workspaces one may be linked (`many`), how several
 * combine (`all`), the version of its ticks' meaning (`ticksVersion`) and how older ticks read now (`migrateTicks`).
 */
export function defineThing<
	const N extends string,
	const V extends number,
	const T extends Ticks,
	const S extends States = Record<never, never>,
	const M extends Methods = Record<never, never>,
	const E extends States = Record<never, never>,
>(
	name: N,
	declaration: {
		readonly version: V;
		readonly state?: S;
		readonly methods?: M;
		readonly events?: E;
		readonly ticks: T & {
			readonly [K in keyof T]: TickDeclaration<(keyof (S & M & E) & string) | FlagTicks<T>>;
		};
		readonly defaultGrants?: DefaultGrants<keyof T & string>;
		readonly makers?: Makers;
		readonly workspaces?: Workspaces;
		readonly stacking?: Stacking;
		readonly ticksVersion?: number;
		readonly migrateTicks?: (ticks: readonly string[], from: number) => string[];
	},
): ThingKind<ThingContract<N, V, S, M, E, T>> {
	const declared: Ticks = declaration.ticks;
	const ticks = Object.entries(declared);
	const flags = ticks.filter(([, tick]) => tick.gives === undefined);
	const gives = new Map<string, readonly string[]>(ticks.map(([tick, { gives: names }]) => [tick, names ?? [tick]]));
	const given = new Set([...gives.values()].flat());
	checkTicks(name, declaration, given, new Set(flags.map(([flag]) => flag)));
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
		flags: Object.fromEntries(flags.map(([flag, { label }]) => [flag, flagLabel(label)])),
	});
	const info: KindInfo = {
		name,
		version: declaration.version,
		workspaces: declaration.workspaces ?? "many",
		makers: declaration.makers ?? "plugin",
		stacking: declaration.stacking ?? "all",
		ticks: ticks.map(([tick, { label, for: forWhom }]) => ({ name: tick, label, for: forWhom ?? "all" })),
		defaultGrants: declaration.defaultGrants ?? {},
		ticksVersion: declaration.ticksVersion ?? 1,
		...(declaration.migrateTicks === undefined ? {} : { migrateTicks: declaration.migrateTicks }),
	};
	// The contract is `remote`'s over the members marked as `ThingContract` spells out; the names are the ticks' own.
	type C = ThingContract<N, V, S, M, E, T>;
	return {
		name,
		info,
		contract: contract as unknown as C,
		all: [...given] as unknown as GrantableName<C>[],
		gives: gives as unknown as ReadonlyMap<string, readonly GrantableName<C>[]>,
	};
}

/**
 * Declaration policy the types state but JavaScript callers can skip (decisions 95, 97, 93): a tick gives only the
 * kind's members and its flag ticks; a flag tick is named unlike every member; a default grant names ticks for its
 * party (`everyone`: people, `agents`: agents).
 */
function checkTicks(
	name: string,
	declaration: {
		readonly state?: States;
		readonly methods?: Methods;
		readonly events?: States;
		readonly ticks: Ticks;
		readonly defaultGrants?: DefaultGrants;
	},
	given: ReadonlySet<string>,
	flags: ReadonlySet<string>,
): void {
	const { state, methods, events, ticks, defaultGrants } = declaration;
	const members = new Set([state, methods, events].flatMap((each) => Object.keys(each ?? {})));
	for (const gives of given) {
		if (!members.has(gives) && !flags.has(gives))
			throw new Error(`${name}.ticks: "${gives}" is no member or flag tick`);
	}
	for (const flag of flags) {
		if (members.has(flag)) throw new Error(`${name}.ticks.${flag}: a flag tick is named like a member`);
	}
	const audiences = [
		["everyone", defaultGrants?.everyone, "people"],
		["agents", defaultGrants?.agents, "agents"],
	] as const;
	for (const [party, named, audience] of audiences) {
		for (const tick of named ?? []) {
			const forWhom = ticks[tick]?.for ?? "all";
			if (ticks[tick] === undefined || (forWhom !== "all" && forWhom !== audience)) {
				throw new Error(`${name}.defaultGrants.${party}: "${tick}" is no tick for ${party}`);
			}
		}
	}
}

/**
 * A flag tick's label as Chord takes it today: a plain string, here the message's `namespace.key`. Flag labels as
 * `MessageData` (decisions 65, 69) are built on Chord's branch `flag-messages` (0f04aee2c, in review); once it lands
 * the message is passed as it is, and this is the one place to change.
 */
function flagLabel({ namespace, key }: MessageData): string {
	return `${namespace}.${key}`;
}

/** The members and flags `ticks` give on `Kind`, each once; a tick the kind does not have gives nothing (R3). */
export function expand<C extends Contract>(Kind: ThingKind<C>, ticks: readonly string[]): GrantableName<C>[] {
	const names = new Set<GrantableName<C>>();
	for (const tick of ticks) for (const name of Kind.gives.get(tick) ?? []) names.add(name);
	return [...names];
}
