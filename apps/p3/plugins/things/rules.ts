// The rules of access, without any state: what a workspace ends up with, from what the workspace above ends up with
// and its own entries (rules 1 to 3), who a caller counts as there (rule 4), and their answer for one thing (rule 5),
// as ERNDL-1142 states them, over grant rows of one tick each (item 112; `OPEN` lets in with no tick, item 113). Ticks
// add up over every party a caller counts as (item 106: no precedence). Two rules keep one caller from something, each
// one function: a tick withheld from a person or one session's agent (`OPEN` too) is withheld from them by every route
// (`takenFromNamed`), and a people switch naming a person hides them by every route (`hiddenHere`). The index
// (`access.ts`) computes with these and nothing else.

import { OPEN } from "./contract.ts";
import type { TickFor } from "./kind.ts";

/** A party's key (`partyKey`), as the maps in memory are keyed. */
export type PartyKey = string;

/** Whom a grant's ticks are for, by its party: `agents` for the agents and one session's agent, else `people`. */
export type Audience = "agents" | "people";

/** The audience of a party of `kind`. */
export function audienceOf(kind: "everyone" | "agents" | "person" | "group" | "agent"): Audience {
	return kind === "agents" || kind === "agent" ? "agents" : "people";
}

/**
 * One grant row as the rules read it (item 112): one tick (of the thing's kind, or `OPEN`) given to a party or
 * withheld from it, as one source wrote it. Several sources' rows of one party add up.
 */
export type GrantEntry = {
	readonly thing: string;
	readonly party: PartyKey;
	readonly audience: Audience;
	readonly tick: string;
	/** Given (counts where the thing is linked), or withheld (there and below). */
	readonly gives: boolean;
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
	readonly grants: readonly GrantEntry[];
};

/**
 * What one thing available in a workspace gives: its kind, the parties let in with their ticks (perhaps none), and
 * what is withheld from persons and named agents.
 */
export type ThingHere = {
	readonly kind: string;
	readonly ticks: ReadonlyMap<PartyKey, ReadonlySet<string>>;
	/**
	 * The ticks rows at or below the link withhold from a person or a named agent by every route (item 106); `OPEN`
	 * among them: denied.
	 */
	readonly takenFromNamed: ReadonlyMap<PartyKey, ReadonlySet<string>>;
};

/** What a workspace ends up with: the things available, the parties present, the persons hidden by every route. */
export type WorkspaceAccess = {
	readonly things: ReadonlyMap<string, ThingHere>;
	readonly present: ReadonlySet<PartyKey>;
	readonly hidden: ReadonlySet<PartyKey>;
};

/**
 * What the rules need of the kinds: whom a kind's tick is for (`undefined`: no such tick, R3), all its ticks, and the
 * ticks version they are read at (0 for a kind no plugin registers).
 */
export type KindsLookup = {
	tickFor(kind: string, tick: string): TickFor | undefined;
	ticksOf(kind: string): readonly string[];
	ticksVersionOf(kind: string): number;
};

/** A person's entries: the owner flag, and their groups (party key, outside). */
export type PersonEntries = {
	readonly owner: boolean;
	readonly groups: readonly { readonly party: PartyKey; readonly outside: boolean }[];
};

/**
 * Whom a caller counts as in a workspace: their counted parties, and their own named party, a person's person or an
 * agent's session agent (the ticks withheld from it apply whatever route they are counted by).
 */
export type Counted = { readonly parties: readonly PartyKey[]; readonly named: PartyKey | undefined };

/**
 * What a caller gets for one thing: its ticks, sorted (perhaps none: here without ticks, R10), with the thing's kind
 * and the ticks version they were read at (what an admission checks before it reads them).
 */
export type Answer = { readonly kind: string; readonly ticksVersion: number; readonly ticks: string[] };

/** What the workspace above the root ends up with. */
export const ABOVE_THE_ROOT: WorkspaceAccess = { things: new Map(), present: new Set(), hidden: new Set() };

/** Counts as nothing. */
export const NOBODY: Counted = { parties: [], named: undefined };

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
 * it, else the default). Linked here: the giving rows written here, replacing what came from above; sources add up; a
 * tick the kind lacks, or one for the other audience, counts for nothing. Withheld here: removed from that party; from
 * a person also by every route. A map from above is shared, so it is copied, never changed.
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
	const giving = new Map<string, GrantEntry[]>();
	for (const grant of own.grants) {
		if (!grant.gives) continue;
		const thing = grant.thing;
		if (!own.links.has(thing)) continue;
		const list = giving.get(thing);
		if (list === undefined) giving.set(thing, [grant]);
		else list.push(grant);
	}
	for (const [thing, kind] of own.links) here.set(thing, linkedHere(kind, giving.get(thing) ?? [], kinds));
	// The withheld rows of each thing applied at once: one copy per thing, however many rows (a wide workspace).
	const withholding = new Map<string, GrantEntry[]>();
	for (const grant of own.grants) {
		if (grant.gives || !here.has(grant.thing)) continue;
		const list = withholding.get(grant.thing);
		if (list === undefined) withholding.set(grant.thing, [grant]);
		else list.push(grant);
	}
	for (const [thing, rows] of withholding) here.set(thing, withheld(here.get(thing)!, rows));
	return here;
}

/**
 * A thing linked here: the parties its giving rows written here (`grants`) let in, each with its ticks (nothing below
 * a link adds). `OPEN` lets its party in with no tick; a tick that counts lets it in with that tick (item 113).
 */
function linkedHere(kind: string, grants: readonly GrantEntry[], kinds: KindsLookup): ThingHere {
	const ticks = new Map<PartyKey, Set<string>>();
	for (const grant of grants) {
		const open = grant.tick === OPEN;
		if (!open && !isFor(kinds.tickFor(kind, grant.tick), grant.audience)) continue;
		const own = ticks.get(grant.party) ?? new Set<string>();
		if (!open) own.add(grant.tick);
		ticks.set(grant.party, own);
	}
	return { kind, ticks: ticks.size === 0 ? NO_TICKS : ticks, takenFromNamed: NO_TICKS };
}

/** Whether a tick for `forWhom` counts for a party of `audience` (an unknown tick counts for nobody). */
export function isFor(forWhom: TickFor | undefined, audience: Audience): boolean {
	return forWhom === "all" || forWhom === audience;
}

/**
 * `given` with the withheld ticks of `rows` applied: each row's party loses its tick (`OPEN`: is let in no more), and
 * a person's or a named agent's also by every route (`withheldFromNamed`); a new value whenever anything changes.
 * The maps of `given` may be shared with the workspace above, so they are copied once, never changed.
 */
function withheld(given: ThingHere, rows: readonly GrantEntry[]): ThingHere {
	let ticks: Map<PartyKey, ReadonlySet<string>> | undefined;
	let named: Map<PartyKey, ReadonlySet<string>> | undefined;
	for (const { party, tick } of rows) {
		const before = (ticks ?? given.ticks).get(party);
		if (before !== undefined && tick === OPEN) {
			ticks ??= new Map(given.ticks);
			ticks.delete(party);
		} else if (before?.has(tick) === true) {
			ticks ??= new Map(given.ticks);
			ticks.set(party, new Set([...before].filter((each) => each !== tick)));
		}
		if (withheldFromNamed(party)) {
			const taken = (named ?? given.takenFromNamed).get(party);
			if (taken?.has(tick) === true) continue;
			named ??= new Map(given.takenFromNamed);
			named.set(party, new Set([...(taken ?? []), tick]));
		}
	}
	if (ticks === undefined && named === undefined) return given;
	return { kind: given.kind, ticks: ticks ?? given.ticks, takenFromNamed: named ?? given.takenFromNamed };
}

/**
 * Item 106: whether a tick withheld from `party` is withheld from it by every route: a person (their own entry, their
 * groups', everyone's), whether or not they are put in by name, and one session's agent (its own entry, the agents').
 * Answering false would withhold it from their own entry only.
 */
function withheldFromNamed(party: PartyKey): boolean {
	return party.startsWith("person/") || party.startsWith("agent/");
}

/** Rule 3: the parties present here: its members, and those present above that are shown here. */
function partiesHere(above: ReadonlySet<PartyKey>, own: WorkspaceEntries): ReadonlySet<PartyKey> {
	if (own.showsPeople && own.members.size === 0 && own.switches.size === 0) return above;
	const here = new Set(own.members);
	for (const party of above) if (own.switches.get(party) ?? own.showsPeople) here.add(party);
	return here;
}

/**
 * Item 106: a people switch naming a person hides them here and below by every route (their own entry, their groups,
 * everyone), until a workspace below puts them in again. Returning `above` as it is would make the switch hide only
 * their own party (rule 3).
 */
function hiddenHere(above: ReadonlySet<PartyKey>, own: WorkspaceEntries): ReadonlySet<PartyKey> {
	const put = [...above].filter((person) => own.members.has(person));
	const hides = [...own.switches]
		.filter(([item, shown]) => !shown && item.startsWith("person/") && !own.members.has(item) && !above.has(item))
		.map(([person]) => person);
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
	const self = access.present.has(person);
	const parties: PartyKey[] = self ? [person] : [];
	let partOfEveryone = self;
	for (const group of entries.groups) {
		if (!access.present.has(group.party)) continue;
		parties.push(group.party);
		if (!group.outside) partOfEveryone = true;
	}
	if (partOfEveryone) parties.push(EVERYONE);
	return parties.length === 0 ? NOBODY : { parties, named: person };
}

/** Rule 4 for an agent: its named party and the agents, if its named party is present. */
export function agentCounts(access: WorkspaceAccess, agent: PartyKey): Counted {
	return access.present.has(agent) ? { parties: [agent, AGENTS], named: agent } : NOBODY;
}

/**
 * Rule 5 (not for an owner): the union of the ticks of every counted party let in here, less what is withheld from
 * the caller's named party; `undefined` when no counted party is let in, or `OPEN` is withheld from their named party.
 */
export function answerOf(given: ThingHere, counted: Counted, kinds: KindsLookup): Answer | undefined {
	const taken = counted.named === undefined ? undefined : given.takenFromNamed.get(counted.named);
	if (taken?.has(OPEN) === true) return undefined;
	let union: Set<string> | undefined;
	for (const party of counted.parties) {
		const ticks = given.ticks.get(party);
		if (ticks === undefined) continue;
		union ??= new Set();
		for (const tick of ticks) union.add(tick);
	}
	if (union === undefined) return undefined;
	const kept = taken === undefined ? [...union] : [...union].filter((tick) => !taken.has(tick));
	return { kind: given.kind, ticksVersion: kinds.ticksVersionOf(given.kind), ticks: kept.sort() };
}

/**
 * Rule 5 for an owner (items 78, 99): every tick of the kind meant for people (`people` or `all`), none for agents
 * only.
 */
export function ownerAnswer(kind: string, kinds: KindsLookup): Answer {
	return {
		kind,
		ticksVersion: kinds.ticksVersionOf(kind),
		ticks: kinds
			.ticksOf(kind)
			.filter((tick) => kinds.tickFor(kind, tick) !== "agents")
			.sort(),
	};
}

/** Whether two answers say the same: field by field. */
export function sameAnswer(a: Answer | undefined, b: Answer | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined || a.kind !== b.kind || a.ticksVersion !== b.ticksVersion) return false;
	if (a.ticks.length !== b.ticks.length) return false;
	return a.ticks.every((tick, i) => tick === b.ticks[i]);
}
