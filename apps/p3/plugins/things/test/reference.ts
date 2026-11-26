// The reference: the rules of ERNDL-1142, deliberately dumb (the prototype's `reference.ts`, ported). It reads the
// store's whole SQLite file for every question, through a connection of its own, and walks from the root with arrays
// and filters: no memory, no sharing, no index, no code of the plugin (it makes its own key texts). The differential
// test compares the things plugin's answers with it.

import { DatabaseSync } from "node:sqlite";

/** A caller as the tests name them. */
export type Caller =
	| { readonly kind: "person"; readonly person: string }
	| { readonly kind: "agent"; readonly session: string };

/**
 * What a caller gets for one thing: its ticks, sorted, with the thing's kind and the ticks version (the differential
 * test runs every kind at ticks version 1), or nothing; on a workspace's own thing also the kinds they may make there
 * and the workspaces above they are present in.
 */
export type Answer =
	| {
			readonly kind: string;
			readonly ticksVersion: number;
			readonly ticks: string[];
			readonly depth: number;
			readonly makes?: string[];
			readonly above?: string[];
	  }
	| undefined;

/**
 * Whom each tick of each kind is for, who makes the kind's things, how several of them reaching one workspace combine,
 * and whether its things are workspaces.
 */
export type KindTicks = ReadonlyMap<
	string,
	{
		readonly ticks: ReadonlyMap<string, "agents" | "people" | "all">;
		readonly makers: "anyone" | "people" | "plugin";
		readonly stacking: "all" | "nearest";
		readonly workspace: "no" | "plain" | "leaf";
	}
>;

/** The reference's data of `kinds` (each kind's ticks, makers, stacking, sort). */
export function kindTicksOf(
	kinds: readonly {
		readonly name: string;
		readonly info: {
			readonly ticks: readonly { readonly name: string; readonly for: "agents" | "people" | "all" }[];
			readonly makers: "anyone" | "people" | "plugin";
			readonly stacking: "all" | "nearest";
			readonly workspace: "no" | "plain" | "leaf";
		};
	}[],
): KindTicks {
	return new Map(
		kinds.map(({ name, info }) => [
			name,
			{
				ticks: new Map(info.ticks.map((tick) => [tick.name, tick.for])),
				makers: info.makers,
				stacking: info.stacking,
				workspace: info.workspace,
			},
		]),
	);
}

/** Every row of every table the rules read. */
export type Everything = {
	readonly workspaces: { id: string; parent: string; showsThings: boolean; showsPeople: boolean }[];
	/** Each workspace's kind (its thing's). */
	readonly workspaceKinds: ReadonlyMap<string, string>;
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
		workspaceKinds: new Map(all("things").map((r) => [String(r.thing), String(r.kind)])),
		links: all("links").map((r) => ({ workspace: String(r.workspace), thing: String(r.thing), of: String(r.of) })),
		members: all("workspace-members").map((r) => ({ workspace: String(r.workspace), party: keyOf(parsed(r.party)) })),
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
		memberships: all("group-members").map((r) => ({ group: String(r.group), person: String(r.person) })),
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
): Record<string, NonNullable<Answer>> {
	const answers: Record<string, NonNullable<Answer>> = {};
	for (const { thing } of all.things) {
		if (thing === workspace) continue;
		const answer = answerFrom(all, kinds, workspace, thing, caller);
		if (answer !== undefined) answers[thing] = answer;
	}
	const own = ownFrom(all, kinds, workspace, caller);
	if (own !== undefined) answers[workspace] = own;
	return answers;
}

/** Whether `caller` is the owner. */
function isOwner(all: Everything, caller: Caller): boolean {
	return caller.kind === "person" && all.persons.some((p) => p.id === caller.person && p.owner);
}

/** The way from the root to `workspace`, root first; none when a workspace on it does not exist. */
function wayTo(all: Everything, workspace: string): Everything["workspaces"] | undefined {
	const way: Everything["workspaces"] = [];
	for (let at: string = workspace; at !== ""; ) {
		const here = all.workspaces.find((w) => w.id === at);
		if (here === undefined) return undefined;
		way.unshift(here);
		at = here.parent;
	}
	return way;
}

/** The kinds a Make tick names (`@make:*`: every kind of `kinds`). */
function madeWith(kinds: KindTicks, tick: string): string[] {
	const kind = tick.slice("@make:".length);
	if (kind === "*") return [...kinds.keys()];
	return kinds.has(kind) ? [kind] : [];
}

/**
 * Rule 5 on workspace `workspace`'s own thing (item 88): its grants written at itself, its presence; anyone counted is
 * let in; Make ticks become `makes` within each kind's makers (114); the workspaces above the caller is present in.
 */
export function ownFrom(all: Everything, kinds: KindTicks, workspace: string, caller: Caller): Answer {
	const way = wayTo(all, workspace);
	if (way === undefined) return undefined;
	const kind = all.workspaceKinds.get(workspace)!;
	const ticksOf = kinds.get(kind)?.ticks ?? new Map();
	const makeable = (made: string) => {
		// Only a plain workspace of a registered kind holds workspaces (a leaf never, decision 13).
		if (kinds.get(made)?.workspace !== "no" && kinds.get(kind)?.workspace !== "plain") return false;
		const makers = kinds.get(made)?.makers;
		return makers === "anyone" || (makers === "people" && caller.kind === "person");
	};
	const above: string[] = [];
	for (const step of way.slice(0, -1).reverse()) {
		const state = walk(all, kinds, step.id, step.id);
		if (isOwner(all, caller) || counted(all, caller, state).length > 0) above.push(step.id);
	}
	if (isOwner(all, caller)) {
		return {
			kind,
			ticksVersion: 1,
			ticks: [...ticksOf]
				.filter(([, forWhom]) => forWhom !== "agents")
				.map(([tick]) => tick)
				.sort(),
			depth: 0,
			makes: [...kinds.keys()].filter(makeable).sort(),
			above,
		};
	}
	const state = walk(all, kinds, workspace, workspace);
	const parties = counted(all, caller, state);
	if (parties.length === 0) return undefined;
	const named = caller.kind === "person" ? `person/${caller.person}` : `agent/${caller.session}`;
	const grants = all.grants.filter((g) => g.workspace === workspace && g.thing === workspace);
	if (grants.some((g) => !g.gives && g.party === named && g.tick === "@open")) return undefined;
	const forOf = (tick: string): string | undefined => {
		if (!tick.startsWith("@")) return ticksOf.get(tick);
		if (!tick.startsWith("@make:")) return undefined;
		const made = tick.slice("@make:".length);
		if (made === "*") return "all";
		const makers = kinds.get(made)?.makers;
		return makers === "anyone" ? "all" : makers === "people" ? "people" : undefined;
	};
	const ticks = new Set<string>();
	const makes = new Set<string>();
	for (const party of parties) {
		const rows = grants.filter((g) => g.party === party);
		const given = rows
			.filter((g) => g.gives && (forOf(g.tick) === "all" || forOf(g.tick) === (g.agents ? "agents" : "people")))
			.map((g) => g.tick);
		const withheld = rows.filter((g) => !g.gives).map((g) => g.tick);
		const kept = given.filter((tick) => !withheld.includes(tick));
		for (const tick of kept) if (!tick.startsWith("@")) ticks.add(tick);
		const partyMakes = new Set(
			kept.filter((tick) => tick.startsWith("@make:")).flatMap((tick) => madeWith(kinds, tick)),
		);
		for (const tick of withheld.filter((t) => t.startsWith("@make:")))
			for (const made of madeWith(kinds, tick)) partyMakes.delete(made);
		for (const made of partyMakes) makes.add(made);
	}
	for (const g of grants.filter((g) => !g.gives && g.party === named)) {
		ticks.delete(g.tick);
		if (g.tick.startsWith("@make:")) for (const made of madeWith(kinds, g.tick)) makes.delete(made);
	}
	return {
		kind,
		ticksVersion: 1,
		ticks: [...ticks].sort(),
		depth: 0,
		makes: [...makes].filter(makeable).sort(),
		above,
	};
}

/** Rule 5 for one thing. */
export function answerFrom(
	all: Everything,
	kinds: KindTicks,
	workspace: string,
	thing: string,
	caller: Caller,
): Answer {
	if (wayTo(all, workspace) === undefined) return undefined;
	const state = walk(all, kinds, workspace, thing);
	if (state.kind === undefined) return undefined;
	if (isOwner(all, caller)) {
		const forPeople = [...(kinds.get(state.kind)?.ticks ?? [])].filter(([, forWhom]) => forWhom !== "agents");
		return { kind: state.kind, ticksVersion: 1, ticks: forPeople.map(([tick]) => tick).sort(), depth: state.depth };
	}
	// A tick withheld from the caller's person or session agent applies whatever route they count by (item 106);
	// `@open`: denied.
	const named = caller.kind === "person" ? `person/${caller.person}` : `agent/${caller.session}`;
	const taken = state.taken.get(named) ?? [];
	if (taken.includes("@open")) return undefined;
	const parties = counted(all, caller, state);
	let ticks: string[] | undefined;
	for (const party of parties) {
		const own = state.ticks.get(party);
		if (own !== undefined) ticks = [...(ticks ?? []), ...own.filter((tick) => !(ticks ?? []).includes(tick))];
	}
	if (ticks === undefined) return undefined;
	return {
		kind: state.kind,
		ticksVersion: 1,
		ticks: ticks.filter((tick) => !taken.includes(tick)).sort(),
		depth: state.depth,
	};
}

/**
 * What one thing is at `workspace`: its kind if available, the parties let in with their ticks, what is withheld
 * from persons; who is present and hidden.
 */
type State = {
	kind: string | undefined;
	/** How many steps above the asked workspace its nearest link is. */
	depth: number;
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
	const state: State = { kind: undefined, depth: 0, ticks: new Map(), taken: new Map(), present: [], hidden: [] };
	for (const [step, here] of way.entries()) {
		const switchFor = (item: string) => all.switches.find((s) => s.workspace === here.id && s.item === item)?.shown;
		const grantsHere = all.grants.filter((g) => g.workspace === here.id && g.thing === thing);
		const link = all.links.find((l) => l.workspace === here.id && l.thing === thing);
		if (link !== undefined) {
			state.kind = link.of;
			state.depth = way.length - 1 - step;
			state.ticks = new Map();
			state.taken = new Map();
			for (const grant of grantsHere.filter((g) => g.gives)) {
				const forWhom = kinds.get(link.of)?.ticks.get(grant.tick);
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
		} else if (
			state.kind !== undefined &&
			kinds.get(state.kind)?.stacking === "nearest" &&
			all.links.some((l) => l.workspace === here.id && l.of === state.kind)
		) {
			// Decision 75: another thing of a `nearest` kind linked here replaces this one here and below.
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
				if (grant.party.startsWith("person/") || grant.party.startsWith("agent/")) {
					state.taken.set(grant.party, [...(state.taken.get(grant.party) ?? []), grant.tick]);
				}
			}
		}
		const members = all.members.filter((m) => m.workspace === here.id).map((m) => m.party);
		const hides = all.switches.filter((s) => s.workspace === here.id && s.person && !s.shown).map((s) => s.item);
		state.hidden = [...state.hidden, ...hides].filter((person) => !members.includes(person));
		state.present = [...state.present.filter((party) => switchFor(party) ?? here.showsPeople), ...members];
		// "No access" on the workspace itself: who it is withheld from is out of it entirely (a person by every route).
		const out = all.grants
			.filter((g) => g.workspace === here.id && g.thing === here.id && g.tick === "@open" && !g.gives)
			.map((g) => g.party);
		state.hidden = [...state.hidden, ...out.filter((party) => party.startsWith("person/"))];
		state.present = state.present.filter((party) => !out.includes(party));
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
