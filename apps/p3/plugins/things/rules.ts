// The rules of access, without any state: what a workspace ends up with, from what the workspace above ends up with
// and its own entries (rules 1 to 3), who a caller counts as there (rule 4), and their answer for one thing (rule 5),
// as ERNDL-1142 states them. Each decision Mario may still turn is one function: a person's own grant first
// (`precedence`, item 73), a take-away naming a person removing the tick by every route (`takenFromPerson`, 73), and a
// people switch hiding a person by every route (`hiddenHere`, 73). The index (`access.ts`) computes with these and
// nothing else.

/** A party's key (`partyKey`), as the maps in memory are keyed. */
export type PartyKey = string;

/** Whom a grant's ticks are for, by its party: `agents` for the agents and one session's agent, else `people`. */
export type Audience = "agents" | "people";

/** One grant as one source wrote it, as the rules read it. Several sources' grants of one party add up. */
export type GrantEntry = {
	readonly thing: string;
	readonly party: PartyKey;
	readonly audience: Audience;
	/** A grant (perhaps of no tick; R10), or only a take-away. */
	readonly gives: boolean;
	readonly ticks: readonly string[];
	readonly takenAway: readonly string[];
};

/** What is written about one workspace (read from disk when first needed). */
export type WorkspaceEntries = {
	/** The workspace above (`""`: none, the root). */
	readonly parent: string;
	readonly showsThings: boolean;
	readonly showsPeople: boolean;
	/** The things linked here, each with its kind. */
	readonly links: ReadonlyMap<string, string>;
	/** The parties put in here. */
	readonly members: ReadonlySet<PartyKey>;
	/** By item key: whether that thing or party from above is shown here. */
	readonly switches: ReadonlyMap<string, boolean>;
	/** The persons a switch here hides (their party keys). */
	readonly hides: ReadonlySet<PartyKey>;
	readonly grants: readonly GrantEntry[];
};

/** What one thing available in a workspace gives: its kind, the ticks per party, and what is taken from persons. */
export type ThingHere = {
	readonly kind: string;
	readonly ticks: ReadonlyMap<PartyKey, ReadonlySet<string>>;
	/** The ticks take-aways at or below the link remove from a person, whatever route they come by (73). */
	readonly takenFromPersons: ReadonlyMap<PartyKey, ReadonlySet<string>>;
};

/** What a workspace ends up with: the things available, the parties present, the persons hidden by every route. */
export type WorkspaceAccess = {
	readonly things: ReadonlyMap<string, ThingHere>;
	readonly present: ReadonlySet<PartyKey>;
	readonly hidden: ReadonlySet<PartyKey>;
};

/** What the rules need of the kinds: whom a kind's tick is for (`undefined`: no such tick, R3) and all its ticks. */
export type KindsLookup = {
	tickFor(kind: string, tick: string): "agents" | "people" | "all" | undefined;
	ticksOf(kind: string): readonly string[];
};

/** A person's entries: the owner flag, and their groups (party key, outside). */
export type PersonEntries = {
	readonly owner: boolean;
	readonly groups: readonly { readonly party: PartyKey; readonly outside: boolean }[];
};

/** Whom a caller counts as in a workspace: their counted parties, and their own person's key if they count as it. */
export type Counted = { readonly parties: readonly PartyKey[]; readonly self: PartyKey | undefined };

/** What a caller gets for one thing: its ticks, sorted (perhaps none: here without ticks, R10). */
export type Answer = { readonly ticks: string[] };

/** What the workspace above the root ends up with. */
export const ABOVE_THE_ROOT: WorkspaceAccess = { things: new Map(), present: new Set(), hidden: new Set() };

/** Counts as nothing. */
export const NOBODY: Counted = { parties: [], self: undefined };

const EVERYONE = "everyone";
const AGENTS = "agents";
const NO_TICKS: ReadonlyMap<PartyKey, ReadonlySet<string>> = new Map();

/** What a workspace ends up with (rules 1 to 3): shares with `above` whatever its own entries leave as it is. */
export function accessHere(above: WorkspaceAccess, own: WorkspaceEntries, kinds: KindsLookup): WorkspaceAccess {
	const things = thingsHere(above.things, own, kinds);
	const present = partiesHere(above.present, own);
	const hidden = hiddenHere(above.hidden, own);
	if (things === above.things && present === above.present && hidden === above.hidden) return above;
	return { things, present, hidden };
}

/**
 * Rules 1 and 2: the things available here and what each party gets. From above: what is shown here (the switch for
 * it, else the default). Linked here: the giving grants written here, replacing what came from above; sources add up;
 * a tick the kind lacks, or one for the other audience, counts for nothing. Taken away here: removed from that party;
 * a person's take-away also by every route. A map from above is shared, so it is copied, never changed.
 */
function thingsHere(
	above: WorkspaceAccess["things"],
	own: WorkspaceEntries,
	kinds: KindsLookup,
): WorkspaceAccess["things"] {
	if (own.showsThings && own.links.size === 0 && own.grants.length === 0 && own.switches.size === 0) return above;
	const here = new Map<string, ThingHere>();
	for (const [thing, given] of above) {
		if (own.switches.get(`thing/${thing}`) ?? own.showsThings) here.set(thing, given);
	}
	for (const [thing, kind] of own.links) here.set(thing, linkedHere(thing, kind, own.grants, kinds));
	for (const grant of own.grants) {
		const given = here.get(grant.thing);
		if (given === undefined || grant.takenAway.length === 0) continue;
		here.set(grant.thing, takenAway(given, grant));
	}
	return here;
}

/** A thing linked here: what the giving grants written here give each party (nothing below a link ever adds). */
function linkedHere(thing: string, kind: string, grants: readonly GrantEntry[], kinds: KindsLookup): ThingHere {
	const ticks = new Map<PartyKey, Set<string>>();
	for (const grant of grants) {
		if (grant.thing !== thing || !grant.gives) continue;
		const own = ticks.get(grant.party) ?? new Set<string>();
		for (const tick of grant.ticks) if (isFor(kinds.tickFor(kind, tick), grant.audience)) own.add(tick);
		ticks.set(grant.party, own);
	}
	return { kind, ticks: ticks.size === 0 ? NO_TICKS : ticks, takenFromPersons: NO_TICKS };
}

/** Whether a tick for `forWhom` counts for a party of `audience` (an unknown tick counts for nobody). */
function isFor(forWhom: "agents" | "people" | "all" | undefined, audience: Audience): boolean {
	return forWhom === "all" || forWhom === audience;
}

/** `given` with `grant`'s take-away applied: a new value whenever anything changes. */
function takenAway(given: ThingHere, grant: GrantEntry): ThingHere {
	const before = given.ticks.get(grant.party);
	let ticks = given.ticks;
	if (before !== undefined && grant.takenAway.some((tick) => before.has(tick))) {
		ticks = new Map(ticks).set(grant.party, new Set([...before].filter((tick) => !grant.takenAway.includes(tick))));
	}
	const takenFromPersons = takenFromPerson(given.takenFromPersons, grant);
	if (ticks === given.ticks && takenFromPersons === given.takenFromPersons) return given;
	return { kind: given.kind, ticks, takenFromPersons };
}

/**
 * Item 73: a take-away naming a person removes the tick from them by every route (their groups', everyone's), for a
 * caller who counts as that person. Returning `taken` as it is would make it remove from the person's own grant only.
 */
function takenFromPerson(taken: ThingHere["takenFromPersons"], grant: GrantEntry): ThingHere["takenFromPersons"] {
	if (!grant.party.startsWith("person/")) return taken;
	const before = taken.get(grant.party);
	return new Map(taken).set(grant.party, new Set([...(before ?? []), ...grant.takenAway]));
}

/** Rule 3: the parties present here: its members, and those present above that are shown here. */
function partiesHere(above: ReadonlySet<PartyKey>, own: WorkspaceEntries): ReadonlySet<PartyKey> {
	if (own.showsPeople && own.members.size === 0 && own.switches.size === 0) return above;
	const here = new Set(own.members);
	for (const party of above) if (own.switches.get(party) ?? own.showsPeople) here.add(party);
	return here;
}

/**
 * Item 73: a people switch naming a person hides them here and below by every route (their own entry, their groups,
 * everyone), until a workspace below puts them in again. Returning `above` as it is would make the switch hide only
 * their own party (rule 3).
 */
function hiddenHere(above: ReadonlySet<PartyKey>, own: WorkspaceEntries): ReadonlySet<PartyKey> {
	const put = [...above].filter((person) => own.members.has(person));
	const hides = [...own.hides].filter((person) => !own.members.has(person) && !above.has(person));
	if (put.length === 0 && hides.length === 0) return above;
	const hidden = new Set(above);
	for (const person of put) hidden.delete(person);
	for (const person of hides) hidden.add(person);
	return hidden;
}

/**
 * Rule 4 for a person: themself if their person is present, each of their groups present, and everyone if present as
 * themself or through a group that is not outside. A person hidden here counts as nothing.
 */
export function personCounts(access: WorkspaceAccess, person: PartyKey, entries: PersonEntries): Counted {
	if (access.hidden.has(person)) return NOBODY;
	const self = access.present.has(person) ? person : undefined;
	const parties: PartyKey[] = self === undefined ? [] : [self];
	let partOfEveryone = self !== undefined;
	for (const group of entries.groups) {
		if (!access.present.has(group.party)) continue;
		parties.push(group.party);
		if (!group.outside) partOfEveryone = true;
	}
	if (partOfEveryone) parties.push(EVERYONE);
	return parties.length === 0 ? NOBODY : { parties, self };
}

/** Rule 4 for an agent: its named party and the agents, if its named party is present. */
export function agentCounts(access: WorkspaceAccess, agent: PartyKey): Counted {
	return access.present.has(agent) ? { parties: [agent, AGENTS], self: undefined } : NOBODY;
}

/** Rule 5 (not for an owner): the answer for one thing, `undefined` when no counted party is given anything. */
export function answerOf(given: ThingHere, counted: Counted): Answer | undefined {
	const ticks = precedence(given, counted);
	if (ticks === undefined) return undefined;
	const taken = counted.self === undefined ? undefined : given.takenFromPersons.get(counted.self);
	const kept = taken === undefined ? [...ticks] : [...ticks].filter((tick) => !taken.has(tick));
	return { ticks: kept.sort() };
}

/**
 * Item 73: a person's own grant replaces what their groups and everyone give; groups among themselves add up. Without
 * it, the union of every counted party's ticks. `undefined`: no counted party has a grant here.
 */
function precedence(given: ThingHere, counted: Counted): ReadonlySet<string> | undefined {
	const own = counted.self === undefined ? undefined : given.ticks.get(counted.self);
	if (own !== undefined) return own;
	let union: Set<string> | undefined;
	for (const party of counted.parties) {
		const ticks = given.ticks.get(party);
		if (ticks === undefined) continue;
		union ??= new Set();
		for (const tick of ticks) union.add(tick);
	}
	return union;
}

/** Whether two answers say the same: field by field. */
export function sameAnswer(a: Answer | undefined, b: Answer | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined || a.ticks.length !== b.ticks.length) return false;
	return a.ticks.every((tick, i) => tick === b.ticks[i]);
}
