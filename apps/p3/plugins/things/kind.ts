// Kinds of things: `defineThing` declares a kind (its members and ticks, flag ticks among them, who makes its things,
// where they may be linked, how several reaching one workspace combine, what a new link starts with, which state
// members are its settings, how older ticks read) and makes its remote contract, params `{ workspace, thing }`, on the
// server: a member no tick gives is there for everyone admitted, the others are grantable. `expand` turns tick names
// into the members and flags they give. `ThingKinds` is the server's registry of every kind's data, which the things
// plugin's index reads; `ThingKindsView` hands the same data (without code) to workers and pages. Data only: kinds'
// contract files import it.

import {
	arr,
	bool,
	type Contract,
	defineRegistry,
	type Grantable,
	type GrantableName,
	grantable,
	lit,
	type MessageData,
	type Method,
	map,
	nul,
	num,
	obj,
	oneOf,
	opt,
	remote,
	type Schema,
	Server,
	type Static,
	str,
	type TableItem,
	union,
} from "@earendil-works/p3/v1";
import { kindOfMakeTick, RESERVED, THING_PARAMS, ThingAdmission } from "./contract.ts";
import { messages } from "./messages.ts";

/**
 * Whom a tick can be given: the agents (the agents party, one session's agent), people (everyone, groups, persons), or
 * both.
 */
export const TickFor = oneOf("agents", "people", "all");
export type TickFor = Static<typeof TickFor>;

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

/**
 * Whether a kind's things are workspaces (decision 13, item 27): no, plain workspaces (they hold things, people and
 * workspaces), or leaves (session workspaces: things and people, never workspaces).
 */
export type WorkspaceSort = "no" | "plain" | "leaf";

/** A Make tick as a default grant may name it (`MAKE_ANY`, `makeTick(Kind)`; item 114): a workspace kind's only. */
export type MakeTickName = `@make:${string}`;

/**
 * What a new link of a thing of a kind starts with: the ticks of everyone here and of the agents (an empty list lets
 * the party open the thing with no ticks: `OPEN`, item 113); and what a share's guests get under Read (`guests`,
 * decision 100: ticks that change nothing, the author's promise; never written per link, a share applies it, slice 8).
 */
export type DefaultGrants<T extends string = string> = {
	readonly everyone?: readonly T[];
	readonly agents?: readonly T[];
	readonly guests?: readonly T[];
};

/** A kind's data as every host reads it from `ThingKinds`: what the index, the Settings view and the picker need. */
export type KindInfo = {
	readonly name: string;
	readonly workspaces: Workspaces;
	readonly makers: Makers;
	readonly stacking: Stacking;
	/** Whether its things are workspaces, and of which sort. */
	readonly workspace: WorkspaceSort;
	/** Its ticks: a workspace kind's start with the workspace ticks (`WORKSPACE_TICKS`), its own follow. */
	readonly ticks: readonly { readonly name: string; readonly label: MessageData; readonly for: TickFor }[];
	/** Its default grants; a workspace kind's may name Make ticks (written at the workspace itself). */
	readonly defaultGrants: DefaultGrants;
	/**
	 * The state members `Workspace.configure` may set where a thing is linked (items 86, 91; ordinary state members,
	 * set through the kind's `configure` hook); none by default.
	 */
	readonly settings: readonly string[];
	/** The schemas of the `settings` members (server only: what `Workspace.configure` checks values against). */
	readonly settingsSchemas: Readonly<Record<string, Schema>>;
	/** The schema of what a new thing's create step hands over (none: it takes no input). */
	readonly input?: Schema;
	/**
	 * The version of the ticks' meaning (item 105; 1 by default): bumped only when tick names change meaning, apart
	 * from the contract's `version`. Grants record it.
	 */
	readonly ticksVersion: number;
	/**
	 * Tick names written at an older `ticksVersion` `from`, as this one's (as a document's `migrate`): pure; given the
	 * rows of one party, source and `gives` value together. Required once `ticksVersion` is above 1 (`defineThing`
	 * refuses a kind without it); rows it throws for count for nothing (a withheld one withholds every tick) and are
	 * reported once.
	 */
	readonly migrateTicks?: (ticks: readonly string[], from: number) => string[];
};

/** Every kind registered, by name, each with its plugin (the first by plugin name wins a name). */
export const ThingKinds = defineRegistry<KindInfo, ReadonlyMap<string, TableItem<KindInfo>>>("things.kinds", {
	version: 1,
});

/**
 * A kind's data as worker and page read it: `KindInfo` without its migration and its input schema (plain data), with
 * the plugin that contributes it (its package name: the picker groups kinds by it and finds its title in
 * `PluginTitles`).
 */
export const KindView = obj({
	name: str(),
	plugin: str(),
	workspaces: union([lit("one"), lit("many")]),
	makers: union([lit("anyone"), lit("people"), lit("plugin")]),
	stacking: union([lit("all"), lit("nearest")]),
	workspace: union([lit("no"), lit("plain"), lit("leaf")]),
	ticks: arr(
		obj({
			name: str(),
			// A message as data (Chord's `MessageSchema`, which `/v1` does not export).
			label: obj({ namespace: str(), key: str(), params: arr(union([str(), num(), bool(), nul()])) }),
			for: TickFor,
		}),
	),
	defaultGrants: obj({ everyone: opt(arr(str())), agents: opt(arr(str())), guests: opt(arr(str())) }),
	settings: arr(str()),
	ticksVersion: num(),
});

/** A kind's data as worker and page read it (see `KindView`). */
export type KindView = Static<typeof KindView>;

/**
 * Every registered kind's data, by name, for workers and pages (R36: `ThingKinds` is the server's registry; a page's
 * Settings view and picker and a worker's harness parts read this). Plain data, for anyone connected.
 */
export const ThingKindsView = remote("things.kinds", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	state: { kinds: map(KindView) },
});

/**
 * `info`, contributed by `plugin`, as worker and page read it: its plain data (copied once per registry change:
 * Chord's are mutable types).
 */
export function kindView(info: KindInfo, plugin: string): KindView {
	const { name, workspaces, makers, stacking, workspace, ticks, defaultGrants, settings, ticksVersion } = info;
	return {
		name,
		plugin,
		workspaces,
		makers,
		stacking,
		workspace,
		ticks: ticks.map((tick) => ({
			name: tick.name,
			label: { ...tick.label, params: [...tick.label.params] },
			for: tick.for,
		})),
		defaultGrants: {
			...(defaultGrants.everyone === undefined ? {} : { everyone: [...defaultGrants.everyone] }),
			...(defaultGrants.agents === undefined ? {} : { agents: [...defaultGrants.agents] }),
			...(defaultGrants.guests === undefined ? {} : { guests: [...defaultGrants.guests] }),
		},
		settings: [...settings],
		ticksVersion,
	};
}

/**
 * A kind: its data, its remote contract, its ticks as the names of members and flags they give, the names of its
 * settings (`St`) and the schema of what its create step hands over (`I`; none: no input).
 */
export type ThingKind<C extends Contract = Contract, St extends string = string, I = unknown> = {
	readonly name: string;
	readonly info: KindInfo;
	readonly contract: C;
	/** The state members `Workspace.configure` may set (`info.settings`, typed). */
	readonly settings: readonly St[];
	/** The schema of a new thing's input (`create.input`): what `ThingsStore.create` checks it against. */
	readonly input: Schema<I> | undefined;
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
type Marked<D, G> = { [K in keyof D]: K extends G ? Grantable<Extract<D[K], Schema | Method>> : D[K] };

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
	flags: { [K in FlagTicks<T>]: MessageData };
}>;

/** What `defineThing` and `defineWorkspace` take, with the default grants' tick names `G`. */
type Declaration<
	V extends number,
	T extends Ticks,
	S extends States,
	M extends Methods,
	E extends States,
	St extends string,
	I,
	G extends string,
> = {
	readonly version: V;
	readonly state?: S;
	readonly methods?: M;
	readonly events?: E;
	readonly ticks: T & {
		readonly [K in keyof T]: K extends `${typeof RESERVED}${string}`
			? never
			: TickDeclaration<(keyof (S & M & E) & string) | FlagTicks<T>>;
	};
	readonly defaultGrants?: DefaultGrants<G>;
	readonly settings?: readonly St[];
	/** What a new thing's create step hands over (its kind's `create` hook gets it), checked against `input`. */
	readonly create?: { readonly input: Schema<I> };
	readonly makers?: Makers;
	readonly workspaces?: Workspaces;
	readonly stacking?: Stacking;
	readonly ticksVersion?: number;
	readonly migrateTicks?: (ticks: readonly string[], from: number) => string[];
};

/**
 * Declares kind `name` (its plugin's, `<plugin>.<kind>`): its members (`state`, `methods`, `events`), its `ticks` (a
 * tick gives members and flag ticks; a tick without `gives` is a flag of its own name, decision 97; a member no tick
 * gives is there for everyone admitted), whom its ticks are for, its default grants (its maker gets every tick, item
 * 90), who makes its things (`plugin` by default), in how many workspaces one may be linked (`many`), how several
 * combine (`all`), the state members `Workspace.configure` may set (`settings`), the version of its ticks' meaning
 * (`ticksVersion`) and how older ticks read now (`migrateTicks`).
 */
export function defineThing<
	const N extends string,
	const V extends number,
	const T extends Ticks,
	const S extends States = Record<never, never>,
	const M extends Methods = Record<never, never>,
	const E extends States = Record<never, never>,
	const St extends keyof NoInfer<S> & string = never,
	I = undefined,
>(
	name: N,
	declaration: Declaration<V, T, S, M, E, St, I, keyof T & string>,
): ThingKind<ThingContract<N, V, S, M, E, T>, St, I> {
	return declareKind(name, declaration, "no");
}

/** The names of the workspace ticks every workspace kind has (decision 80): see `WORKSPACE_TICKS`. */
export type WorkspaceTick = "link" | "hide" | "configure" | "managePeople" | "manageAccess";

/**
 * The ticks every workspace kind has before its own (decision 80; Make is the reserved `@make:` ticks, item 114), each
 * for people and agents (a setup agent may hold them, decision 81). They give members of `Workspace`
 * (`workspace-object.ts`), not of the kind's own object.
 */
export const WORKSPACE_TICKS: readonly { readonly name: WorkspaceTick; readonly label: MessageData }[] = [
	{ name: "link", label: messages.message("tickLink") },
	{ name: "hide", label: messages.message("tickHide") },
	{ name: "configure", label: messages.message("tickConfigure") },
	{ name: "managePeople", label: messages.message("tickManagePeople") },
	{ name: "manageAccess", label: messages.message("tickManageAccess") },
];

const WORKSPACE_TICK_NAMES: ReadonlySet<string> = new Set(WORKSPACE_TICKS.map(({ name }) => name));

/**
 * Declares a workspace kind (item 27): a kind as `defineThing` declares it (its own members and ticks: a session's
 * Read, Send), whose things are workspaces, plain or leaves (`leaf`: a session workspace holds no workspaces,
 * decision 13). Its things have the workspace ticks first (`WORKSPACE_TICKS`; they give members of `Workspace`, not of
 * the kind's own object) and its own after; its default grants, written at each new workspace itself, may name them
 * and Make ticks (`MAKE_ANY`, `makeTick(Kind)`): the session kind gives the agents `MAKE_ANY` (R6). One is linked in
 * one workspace, its parent.
 */
export function defineWorkspace<
	const N extends string,
	const V extends number,
	const T extends Ticks,
	const S extends States = Record<never, never>,
	const M extends Methods = Record<never, never>,
	const E extends States = Record<never, never>,
	const St extends keyof NoInfer<S> & string = never,
	I = undefined,
>(
	name: N,
	declaration: Omit<
		Declaration<V, T, S, M, E, St, I, (keyof T & string) | WorkspaceTick | MakeTickName>,
		"workspaces"
	> & {
		readonly leaf: boolean;
	},
): ThingKind<ThingContract<N, V, S, M, E, T>, St, I> {
	for (const { name: tick } of WORKSPACE_TICKS) {
		if (tick in declaration.ticks)
			throw new Error(`${name}.ticks.${tick}: a workspace tick, every workspace kind has it`);
	}
	return declareKind(name, { ...declaration, workspaces: "one" }, declaration.leaf ? "leaf" : "plain");
}

/** A kind of sort `workspace` (`defineThing`'s and `defineWorkspace`'s one body). */
function declareKind<
	const N extends string,
	const V extends number,
	const T extends Ticks,
	const S extends States,
	const M extends Methods,
	const E extends States,
	const St extends string,
	I,
	G extends string,
>(
	name: N,
	declaration: Declaration<V, T, S, M, E, St, I, G>,
	workspace: WorkspaceSort,
): ThingKind<ThingContract<N, V, S, M, E, T>, St, I> {
	const declared: Ticks = declaration.ticks;
	const ticks = Object.entries(declared);
	const flags = ticks.filter(([, tick]) => tick.gives === undefined);
	const gives = new Map<string, readonly string[]>(ticks.map(([tick, { gives: names }]) => [tick, names ?? [tick]]));
	const given = new Set([...gives.values()].flat());
	checkTicks(name, declaration, given, new Set(flags.map(([flag]) => flag)), workspace);
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
		// A flag's label is its tick's message (decisions 65, 69).
		flags: Object.fromEntries(flags.map(([flag, { label }]) => [flag, label])),
	});
	const own = ticks.map(([tick, { label, for: forWhom }]) => ({
		name: tick,
		label,
		for: forWhom ?? ("all" as const),
	}));
	const settings: readonly string[] = declaration.settings ?? [];
	const info: KindInfo = {
		name,
		workspaces: declaration.workspaces ?? "many",
		makers: declaration.makers ?? "plugin",
		stacking: declaration.stacking ?? "all",
		workspace,
		ticks:
			workspace === "no"
				? own
				: [...WORKSPACE_TICKS.map(({ name, label }) => ({ name, label, for: "all" as const })), ...own],
		defaultGrants: declaration.defaultGrants ?? {},
		settings,
		settingsSchemas: Object.fromEntries(settings.map((setting) => [setting, declaration.state![setting]!])),
		...(declaration.create === undefined ? {} : { input: declaration.create.input }),
		ticksVersion: declaration.ticksVersion ?? 1,
		...(declaration.migrateTicks === undefined ? {} : { migrateTicks: declaration.migrateTicks }),
	};
	// The contract is `remote`'s over the members marked as `ThingContract` spells out; the names are the ticks' own.
	type C = ThingContract<N, V, S, M, E, T>;
	return {
		name,
		info,
		contract: contract as unknown as C,
		settings: declaration.settings ?? [],
		input: declaration.create?.input,
		all: [...given] as unknown as GrantableName<C>[],
		gives: gives as unknown as ReadonlyMap<string, readonly GrantableName<C>[]>,
	};
}

/**
 * Declaration policy the types state but JavaScript callers can skip (decisions 95, 97, 93, item 113): a tick gives
 * only the kind's members and its flag ticks; a flag tick is named unlike every member; no tick name is reserved; a
 * default grant names ticks for its party (`everyone` and `guests`: people, `agents`: agents); a setting is a state
 * member; a ticks version above 1 has `migrateTicks` (API C6).
 */
function checkTicks(
	name: string,
	declaration: {
		readonly state?: States;
		readonly methods?: Methods;
		readonly events?: States;
		readonly ticks: Ticks;
		readonly defaultGrants?: DefaultGrants;
		readonly settings?: readonly string[];
		readonly ticksVersion?: number;
		readonly migrateTicks?: unknown;
	},
	given: ReadonlySet<string>,
	flags: ReadonlySet<string>,
	workspace: WorkspaceSort,
): void {
	const { state, methods, events, ticks, defaultGrants, settings } = declaration;
	if ((declaration.ticksVersion ?? 1) > 1 && declaration.migrateTicks === undefined) {
		throw new Error(`${name}: ticksVersion ${declaration.ticksVersion} needs migrateTicks (the older grants' ticks)`);
	}
	for (const setting of settings ?? []) {
		if (state?.[setting] === undefined) throw new Error(`${name}.settings: "${setting}" is no state member`);
	}
	const members = new Set([state, methods, events].flatMap((each) => Object.keys(each ?? {})));
	for (const gives of given) {
		if (!members.has(gives) && !flags.has(gives))
			throw new Error(`${name}.ticks: "${gives}" is no member or flag tick`);
	}
	for (const flag of flags) {
		if (members.has(flag)) throw new Error(`${name}.ticks.${flag}: a flag tick is named like a member`);
	}
	for (const tick of Object.keys(ticks)) {
		if (tick.startsWith(RESERVED))
			throw new Error(`${name}.ticks.${tick}: names starting with ${RESERVED} are reserved`);
	}
	const audiences = [
		["everyone", defaultGrants?.everyone, "people"],
		["agents", defaultGrants?.agents, "agents"],
		["guests", defaultGrants?.guests, "people"],
	] as const;
	for (const [party, named, audience] of audiences) {
		for (const tick of named ?? []) {
			// A workspace kind's defaults may name the workspace ticks (for all) and Make ticks (whose kind's `makers`
			// decides at each answer, item 114).
			if (workspace !== "no" && (kindOfMakeTick(tick) !== undefined || WORKSPACE_TICK_NAMES.has(tick))) continue;
			const forWhom = ticks[tick]?.for ?? "all";
			if (ticks[tick] === undefined || (forWhom !== "all" && forWhom !== audience)) {
				throw new Error(`${name}.defaultGrants.${party}: "${tick}" is no tick for ${party}`);
			}
		}
	}
}

/** The members and flags `ticks` give on `Kind`, each once; a tick the kind does not have gives nothing (R3). */
export function expand<C extends Contract>(Kind: ThingKind<C>, ticks: readonly string[]): GrantableName<C>[] {
	const names = new Set<GrantableName<C>>();
	for (const tick of ticks) for (const name of Kind.gives.get(tick) ?? []) names.add(name);
	return [...names];
}
