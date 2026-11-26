// The reference: the rules of ERNDL-1142, deliberately dumb (the prototype's `reference.ts`, ported). It reads the
// store's whole SQLite file for every question, through a connection of its own, and walks from the root with arrays
// and filters: no memory, no sharing, no index, no code of the plugin (it makes its own key texts). The differential
// test compares the things plugin's answers with it.

import { DatabaseSync } from "node:sqlite";

/** A caller as the tests name them. */
export type Caller =
	| { readonly kind: "person"; readonly person: string }
	| { readonly kind: "agent"; readonly session: string };

/** What a caller gets for one thing: its ticks, sorted, or nothing. */
export type Answer = { readonly ticks: string[] } | undefined;

/** Whom each tick of each kind is for. */
export type KindTicks = ReadonlyMap<string, ReadonlyMap<string, "agents" | "people" | "all">>;

/** Every row of every table the rules read. */
export type Everything = {
	readonly workspaces: { id: string; parent: string; showsThings: boolean; showsPeople: boolean }[];
	readonly things: { thing: string; kind: string }[];
	readonly links: { workspace: string; thing: string; of: string }[];
	readonly members: { workspace: string; party: string }[];
	readonly switches: { workspace: string; item: string; person: boolean; shown: boolean }[];
	readonly grants: {
		workspace: string;
		thing: string;
		party: string;
		agents: boolean;
		tick: string;
		gives: boolean;
	}[];
	readonly groups: { id: string; outside: boolean }[];
	readonly memberships: { group: string; person: string }[];
	readonly persons: { id: string; owner: boolean }[];
};

type Json = Record<string, unknown>;

/** A party's text, as the tests compare them. */
function keyOf(party: Json): string {
	switch (party.kind) {
		case "everyone":
		case "agents":
			return String(party.kind);
		case "person":
			return `person/${party.person}`;
		case "group":
			return `group/${party.group}`;
		default:
			return `agent/${party.session}`;
	}
}

/** Reads every table of the store in `path`. */
export function readEverything(path: string): Everything {
	const db = new DatabaseSync(path, { readOnly: true });
	const all = (table: string) => db.prepare(`SELECT * FROM "things.store:things.${table}"`).all();
	const parsed = (value: unknown) => JSON.parse(String(value)) as Json;
	const everything: Everything = {
		workspaces: all("workspaces").map((r) => ({
			id: String(r.workspace),
			parent: String(r.parent),
			showsThings: r.showsThings === 1,
			showsPeople: r.showsPeople === 1,
		})),
		things: all("things").map((r) => ({ thing: String(r.thing), kind: String(r.kind) })),
		links: all("links").map((r) => ({ workspace: String(r.workspace), thing: String(r.thing), of: String(r.of) })),
		members: all("workspace_members").map((r) => ({ workspace: String(r.workspace), party: keyOf(parsed(r.party)) })),
		switches: all("switches").map((r) => {
			const item = parsed(r.item);
			const party = item.party as Json | undefined;
			return {
				workspace: String(r.workspace),
				item: item.kind === "thing" ? `thing/${item.thing}` : keyOf(party!),
				person: party?.kind === "person",
				shown: r.shown === 1,
			};
		}),
		grants: all("grants").map((r) => {
			const party = parsed(r.party);
			return {
				workspace: String(r.workspace),
				thing: String(r.thing),
				party: keyOf(party),
				agents: party.kind === "agents" || party.kind === "agent",
				tick: String(r.tick),
				gives: r.gives === 1,
			};
		}),
		groups: all("groups").map((r) => ({ id: String(r.group), outside: r.outside === 1 })),
		memberships: all("group_members").map((r) => ({ group: String(r.group), person: String(r.person) })),
		persons: all("persons").map((r) => ({ id: String(r.person), owner: r.owner === 1 })),
	};
	db.close();
	return everything;
}

/** What `caller` gets for every thing in `workspace` (nothing omitted), by thing. */
export function answersFrom(
	all: Everything,
	kinds: KindTicks,
	workspace: string,
	caller: Caller,
): Record<string, { ticks: string[] }> {
	const answers: Record<string, { ticks: string[] }> = {};
	for (const { thing } of all.things) {
		const answer = answerFrom(all, kinds, workspace, thing, caller);
		if (answer !== undefined) answers[thing] = answer;
	}
	return answers;
}

/** Rule 5 for one thing. */
export function answerFrom(
	all: Everything,
	kinds: KindTicks,
	workspace: string,
	thing: string,
	caller: Caller,
): Answer {
	const state = walk(all, kinds, workspace, thing);
	if (state.kind === undefined) return undefined;
	if (caller.kind === "person" && all.persons.some((p) => p.id === caller.person && p.owner)) {
		const forPeople = [...(kinds.get(state.kind) ?? [])].filter(([, forWhom]) => forWhom !== "agents");
		return { ticks: forPeople.map(([tick]) => tick).sort() };
	}
	// A tick withheld from the caller's person applies whatever route they count by (item 106); `@open`: denied.
	const taken = caller.kind === "person" ? (state.taken.get(`person/${caller.person}`) ?? []) : [];
	if (taken.includes("@open")) return undefined;
	const parties = counted(all, caller, state);
	let ticks: string[] | undefined;
	for (const party of parties) {
		const own = state.ticks.get(party);
		if (own !== undefined) ticks = [...(ticks ?? []), ...own.filter((tick) => !(ticks ?? []).includes(tick))];
	}
	if (ticks === undefined) return undefined;
	return { ticks: ticks.filter((tick) => !taken.includes(tick)).sort() };
}

/**
 * What one thing is at `workspace`: its kind if available, the parties let in with their ticks, what is withheld
 * from persons; who is present and hidden.
 */
type State = {
	kind: string | undefined;
	ticks: Map<string, string[]>;
	taken: Map<string, string[]>;
	present: string[];
	hidden: string[];
};

/** Rules 1 to 3 along the way from the root to `workspace`, for one thing. */
function walk(all: Everything, kinds: KindTicks, workspace: string, thing: string): State {
	const way: Everything["workspaces"] = [];
	for (
		let at = all.workspaces.find((w) => w.id === workspace);
		at;
		at = all.workspaces.find((w) => w.id === at?.parent)
	)
		way.unshift(at);
	const state: State = { kind: undefined, ticks: new Map(), taken: new Map(), present: [], hidden: [] };
	for (const here of way) {
		const switchFor = (item: string) => all.switches.find((s) => s.workspace === here.id && s.item === item)?.shown;
		const grantsHere = all.grants.filter((g) => g.workspace === here.id && g.thing === thing);
		const link = all.links.find((l) => l.workspace === here.id && l.thing === thing);
		if (link !== undefined) {
			state.kind = link.of;
			state.ticks = new Map();
			state.taken = new Map();
			for (const grant of grantsHere.filter((g) => g.gives)) {
				const forWhom = kinds.get(link.of)?.get(grant.tick);
				const counts = forWhom === "all" || forWhom === (grant.agents ? "agents" : "people");
				if (grant.tick !== "@open" && !counts) continue;
				const had = state.ticks.get(grant.party) ?? [];
				state.ticks.set(
					grant.party,
					grant.tick === "@open" || had.includes(grant.tick) ? had : [...had, grant.tick],
				);
			}
		} else if (state.kind !== undefined && !(switchFor(`thing/${thing}`) ?? here.showsThings)) {
			state.kind = undefined;
		}
		if (state.kind !== undefined) {
			for (const grant of grantsHere.filter((g) => !g.gives)) {
				const has = state.ticks.get(grant.party);
				if (has && grant.tick === "@open") state.ticks.delete(grant.party);
				else if (has)
					state.ticks.set(
						grant.party,
						has.filter((tick) => tick !== grant.tick),
					);
				if (grant.party.startsWith("person/")) {
					state.taken.set(grant.party, [...(state.taken.get(grant.party) ?? []), grant.tick]);
				}
			}
		}
		const members = all.members.filter((m) => m.workspace === here.id).map((m) => m.party);
		const hides = all.switches.filter((s) => s.workspace === here.id && s.person && !s.shown).map((s) => s.item);
		state.hidden = [...state.hidden, ...hides].filter((person) => !members.includes(person));
		state.present = [...state.present.filter((party) => switchFor(party) ?? here.showsPeople), ...members];
	}
	return state;
}

/** Rule 4: whom the caller counts as. */
function counted(all: Everything, caller: Caller, state: State): string[] {
	if (caller.kind === "agent") {
		const self = `agent/${caller.session}`;
		return state.present.includes(self) ? [self, "agents"] : [];
	}
	const self = `person/${caller.person}`;
	if (state.hidden.includes(self)) return [];
	const parties: string[] = [];
	let everyone = false;
	if (state.present.includes(self)) {
		parties.push(self);
		everyone = true;
	}
	for (const group of all.groups) {
		const key = `group/${group.id}`;
		if (!all.memberships.some((m) => m.group === group.id && m.person === caller.person)) continue;
		if (!state.present.includes(key)) continue;
		parties.push(key);
		if (!group.outside) everyone = true;
	}
	if (everyone) parties.push("everyone");
	return parties;
}
