// What the page lists about workspaces (`workspace.ts`; ERNDL-1141 §8 and §9): the caller's roots, a workspace's
// children, what is here, who is here, what may be linked here, one thing as it is available here, and who may do what
// with a thing here. Each is computed over the access index as a probe (`access.ts`), live: asked again after every
// commit it can depend on, told only when it changed; names and other display columns are joined from the store by
// named queries. Admitted by the caller's answer on the workspace (anyone present; WhoMay: Manage access, R40;
// ThingInfo: an answer on the thing). No list names a workspace the caller is not present in (item 96). The lists are
// bounded by one workspace (its contents, its people, its children), each read whole: a list has no further pages.

import {
	type Admission,
	type AdmitSelf,
	allow,
	type Context,
	callerKey,
	deny,
	type FacetHost,
	type JsonValue,
	type NamedQuery,
	type P3Principal,
	type Reference,
	type Self,
	until,
	type Watchable,
} from "@earendil-works/p3/v1";
import type { Look, Probe } from "./access.ts";
import { callerOf } from "./admission.ts";
import { AccessHandles, Gives, ThingsStore } from "./contract.server.ts";
import { type Caller, OPEN, type Party, partyKey, partyOf } from "./contract.ts";
import { type KindInfo, ThingKinds } from "./kind.ts";
import { messages } from "./messages.ts";
import { readAll } from "./reader.ts";
import type { ThingHere } from "./rules.ts";
import {
	type Cell,
	Linkable,
	type Origin,
	Roots,
	ThingInfo,
	WhoMay,
	WorkspaceChildren,
	WorkspaceContents,
	WorkspacePeople,
} from "./workspace.ts";

/** The store as the lists read it. */
type Store = Reference<typeof ThingsStore>;

/** A workspace in a list: its id, kind and name. */
type WorkspaceItem = { workspace: string; kind: string; name: string };

/** A thing in a list, before its name is joined. */
type ThingItem = { thing: string; kind: string; from: Origin; hidden: boolean };

/** A party in a list, before its name is joined. */
type PartyItem = { party: Party; from: Origin; hidden: boolean };

/** Serves every list on `host`. */
export function serveLists(host: FacetHost<P3Principal>): void {
	host.serve(Roots, (_params, principal, self) => {
		const store = self.get(ThingsStore, {});
		const caller = callerOf(principal);
		const rows = followProbe(self, () => rootsProbe(store, caller));
		return { list: self.derive([rows], ([items]) => ({ rows: items, moreAfter: false })), more: async () => null };
	});
	host.serve(
		WorkspaceChildren,
		({ workspace }, principal, _admitted, self) => {
			const store = self.get(ThingsStore, {});
			const caller = callerOf(principal);
			const rows = followProbe(self, () => childrenProbe(store, workspace, caller));
			return { list: self.derive([rows], ([items]) => ({ rows: items, moreAfter: false })), more: async () => null };
		},
		{ admit: admitPresent },
	);
	host.serve(
		WorkspaceContents,
		({ workspace }, principal, _admitted, self) => {
			const store = self.get(ThingsStore, {});
			const caller = callerOf(principal);
			const rows = followProbe(self, () => named(store, contentsProbe(workspace, caller)));
			return { list: self.derive([rows], ([items]) => ({ rows: items, moreAfter: false })), more: async () => null };
		},
		{ admit: admitPresent },
	);
	host.serve(
		WorkspacePeople,
		({ workspace }, principal, _admitted, self) => {
			const store = self.get(ThingsStore, {});
			const caller = callerOf(principal);
			const rows = followProbe(self, () => withParties(store, peopleProbe(workspace, caller)));
			return { list: self.derive([rows], ([items]) => ({ rows: items, moreAfter: false })), more: async () => null };
		},
		{ admit: admitPresent },
	);
	host.serve(
		Linkable,
		({ workspace, query }, principal, _admitted, self) => {
			const store = self.get(ThingsStore, {});
			const caller = callerOf(principal);
			const rows = followProbe(self, () => named(store, linkableProbe(workspace, caller)));
			const prefix = query.toLowerCase();
			return {
				list: self.derive([rows], ([items]) => ({
					rows: items
						.filter(({ name }) => name.toLowerCase().startsWith(prefix))
						.map(({ thing, kind, name, from }) => ({ thing, kind, name, from })),
					moreAfter: false,
				})),
				more: async () => null,
			};
		},
		{ admit: admitPresent },
	);
	host.serve(
		ThingInfo,
		({ workspace, thing }, principal, _admitted, self) => {
			const store = self.get(ThingsStore, {});
			const caller = callerOf(principal);
			const found = followProbe(self, () => thingProbe(workspace, thing, caller));
			const row = self.liveQuery(store.things.one, { thing }, { first: 1 });
			return {
				info: self.derive([found, row], ([here, rows]) => {
					const { name = "", view = "" } = rows.rows[0] ?? {};
					return {
						thing,
						kind: here?.kind ?? rows.rows[0]?.kind ?? "",
						name,
						...(view === "" ? {} : { view }),
						from: here?.from ?? HERE,
					};
				}),
			};
		},
		{ admit: admitAnswer },
	);
	host.serve(
		WhoMay,
		({ workspace, thing }, principal, _admitted, self) => {
			const store = self.get(ThingsStore, {});
			const kinds = self.registry(ThingKinds);
			const probe = whoMayProbe(workspace, thing, callerOf(principal), () => kinds.value);
			const table = followProbe(self, () => withRowsNamed(store, probe));
			return { table };
		},
		{ admit: admitManageAccess },
	);
}

const HERE: Origin = { kind: "here" };

/**
 * Follows the probe `make` builds over the store's index: one per attachment, attached again to each store attempt's
 * index (as `Gives` does).
 */
function followProbe<T extends JsonValue>(self: Self<P3Principal>, make: () => Probe<T>): Watchable<T> {
	const handles = self.registry(AccessHandles);
	self.retryOn(handles);
	return self.follow<T>(async (observer, ctx) => {
		for (;;) {
			const handle = await until(handles, (found) => found?.open === true, ctx);
			const attached = await handle!.probe(make(), observer, ctx);
			if (attached !== undefined) return attached;
		}
	});
}

/** Admits anyone present in the workspace: who has an answer on its own thing (item 88). */
function admitPresent(
	{ workspace }: { readonly workspace: string },
	principal: P3Principal,
	self: AdmitSelf,
): Watchable<Admission<Record<never, never>>> {
	const gives = self.get(Gives, { workspace, caller: callerKey(principal) }).answers;
	return self.derive([gives], ([answers]) => (answers[workspace] === undefined ? NOT_PRESENT : ALLOWED));
}

/** Admits whoever has an answer on `thing` in `workspace` (one with no tick too). */
function admitAnswer(
	{ workspace, thing }: { readonly workspace: string; readonly thing: string },
	principal: P3Principal,
	self: AdmitSelf,
): Watchable<Admission<Record<never, never>>> {
	const gives = self.get(Gives, { workspace, caller: callerKey(principal) }).answers;
	return self.derive([gives], ([answers]) => (answers[thing] === undefined ? NOT_PRESENT : ALLOWED));
}

/** Admits whoever has Manage access in the workspace (R40): its own answer names the tick. */
function admitManageAccess(
	{ workspace }: { readonly workspace: string },
	principal: P3Principal,
	self: AdmitSelf,
): Watchable<Admission<Record<never, never>>> {
	const gives = self.get(Gives, { workspace, caller: callerKey(principal) }).answers;
	return self.derive([gives], ([answers]) =>
		answers[workspace]?.ticks.includes("manageAccess") === true ? ALLOWED : NOT_PRESENT,
	);
}

const ALLOWED = allow({});
const NOT_PRESENT = deny("things: nothing given here", messages.message("notGiven"));

/** Where `at` is, as `caller` may see it from `workspace` (item 96): here, a workspace above they are present in, or above. */
function originOf(look: Look, workspace: string, at: string, above: readonly string[]): Origin {
	if (at === workspace) return HERE;
	if (!above.includes(at)) return { kind: "aboveUnnamed" };
	return { kind: "above", workspace: at, name: look.entries(at)?.name ?? "" };
}

/** The workspaces above `workspace` `caller` is present in (their own answer's `above`). */
function aboveOf(look: Look, workspace: string, caller: Caller): readonly string[] {
	return look.answer(workspace, workspace, caller)?.above ?? [];
}

/** Whether two lists are the same, item by item, by `same`. */
function sameList<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean): boolean {
	return a.length === b.length && a.every((item, i) => same(item, b[i]!));
}

/** Whether two origins are the same. */
function sameOrigin(a: Origin, b: Origin): boolean {
	if (a.kind !== b.kind) return false;
	return a.kind !== "above" || b.kind !== "above" || (a.workspace === b.workspace && a.name === b.name);
}

const sameWorkspaces = (a: WorkspaceItem[], b: WorkspaceItem[]) =>
	sameList(a, b, (x, y) => x.workspace === y.workspace && x.kind === y.kind && x.name === y.name);

const sameThings = (a: ThingItem[], b: ThingItem[]) =>
	sameList(
		a,
		b,
		(x, y) => x.thing === y.thing && x.kind === y.kind && x.hidden === y.hidden && sameOrigin(x.from, y.from),
	);

/** A workspace in a list, from what the index loaded of it. */
function itemOf(look: Look, workspace: string): WorkspaceItem {
	const entries = look.entries(workspace);
	return { workspace, kind: entries?.kind ?? "", name: entries?.name ?? "" };
}

/** Sorts workspace items by name, then id. */
function byName(a: WorkspaceItem, b: WorkspaceItem): number {
	return a.name.localeCompare(b.name) || a.workspace.localeCompare(b.workspace);
}

/**
 * R34: the caller's topmost present workspaces: those they are present in whose parent they are not present in
 * (item 96); an owner's (and the server's) is Pi. The candidates are the workspaces a party of theirs is put in (their
 * person or agent, their groups); presence comes only from there, so every root is among them.
 */
function rootsProbe(store: Store, caller: Caller): Probe<WorkspaceItem[]> {
	let root = "";
	let candidates: readonly string[] = [];
	return {
		workspace: "",
		scope: "any",
		prepare: async (load, _look, ctx) => {
			root = (await readAll(store.workspaces.children, { parent: "" }, ctx))[0]?.workspace ?? "";
			const keys = [partyKey(caller.kind === "server" ? { kind: "everyone" } : caller)];
			if (caller.kind === "person") {
				await load.person(caller.person);
				for (const { group } of await readAll(store.groupMembers.ofPerson, { person: caller.person }, ctx))
					keys.push(partyKey({ kind: "group", group }));
			}
			const found = new Set<string>();
			for (const key of keys) {
				for (const { workspace } of await readAll(store.workspaceMembers.where, { partyKey: key }, ctx))
					found.add(workspace);
			}
			candidates = [...found];
			for (const workspace of [root, ...candidates]) await load.workspace(workspace);
		},
		compute: (look) => {
			const everything =
				caller.kind === "server" || (caller.kind === "person" && look.person(caller.person)?.owner === true);
			if (everything) return root === "" ? [] : [itemOf(look, root)];
			const roots = candidates.filter((workspace) => {
				const answer = look.answer(workspace, workspace, caller);
				const parent = look.entries(workspace)?.parent ?? "";
				return answer !== undefined && !(answer.above ?? []).includes(parent);
			});
			return [...new Set(roots)].map((workspace) => itemOf(look, workspace)).sort(byName);
		},
		same: sameWorkspaces,
		watched: () => [root, ...candidates],
		persons: () => (caller.kind === "person" ? [caller.person] : []),
	};
}

/** The workspaces right below `workspace` that `caller` is present in. */
function childrenProbe(store: Store, workspace: string, caller: Caller): Probe<WorkspaceItem[]> {
	let children: readonly string[] = [];
	return {
		workspace,
		scope: "any",
		prepare: async (load, _look, ctx) => {
			if (caller.kind === "person") await load.person(caller.person);
			children = (await readAll(store.workspaces.children, { parent: workspace }, ctx)).map((row) => row.workspace);
			for (const child of children) await load.workspace(child);
		},
		compute: (look) =>
			children
				.filter((child) => look.answer(child, child, caller) !== undefined)
				.map((child) => itemOf(look, child))
				.sort(byName),
		same: sameWorkspaces,
		watched: () => children,
		persons: () => (caller.kind === "person" ? [caller.person] : []),
	};
}

/**
 * What is here for `caller`: every thing available here they get an answer for, and, for whoever has Hide here, every
 * thing from above a switch or the default hides here.
 */
function contentsProbe(workspace: string, caller: Caller): Probe<ThingItem[]> {
	return {
		workspace,
		scope: "here",
		prepare: async (load) => {
			if (caller.kind === "person") await load.person(caller.person);
		},
		compute: (look) => {
			const above = aboveOf(look, workspace, caller);
			const access = look.access(workspace);
			const rows: ThingItem[] = [];
			const row = (thing: string, given: ThingHere, hidden: boolean) =>
				rows.push({ thing, kind: given.kind, from: originOf(look, workspace, given.at, above), hidden });
			for (const [thing, given] of access.things) {
				if (look.answer(workspace, thing, caller) !== undefined) row(thing, given, false);
			}
			// What is hidden here is listed for whoever may show it again: Hide here (an owner has it).
			const entries = look.entries(workspace);
			const hides = look.answer(workspace, workspace, caller)?.ticks.includes("hide") === true;
			if (hides && entries !== undefined && entries.parent !== "") {
				for (const [thing, given] of look.access(entries.parent).things) {
					if (access.things.has(thing) || entries.links.has(thing)) continue;
					if (!(entries.switches.get(`thing/${thing}`) ?? entries.showsThings)) row(thing, given, true);
				}
			}
			return rows.sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.thing.localeCompare(b.thing));
		},
		same: sameThings,
		watched: () => [],
		persons: () => (caller.kind === "person" ? [caller.person] : []),
	};
}

/**
 * Who is here: every party present here (put in here, or from above and shown), and every party present above that
 * a switch or the default hides here, each with where it was put in.
 */
function peopleProbe(workspace: string, caller: Caller): Probe<PartyItem[]> {
	return {
		workspace,
		scope: "here",
		prepare: async (load) => {
			if (caller.kind === "person") await load.person(caller.person);
		},
		compute: (look) => {
			const above = aboveOf(look, workspace, caller);
			const entries = look.entries(workspace);
			const present = look.access(workspace).present;
			const rows: PartyItem[] = [];
			const putIn = (key: string): Origin => {
				for (let at = workspace; at !== ""; at = look.entries(at)?.parent ?? "") {
					if (look.entries(at)?.members.has(key) === true) return originOf(look, workspace, at, above);
				}
				return { kind: "aboveUnnamed" };
			};
			for (const key of present) rows.push({ party: partyOf(key), from: putIn(key), hidden: false });
			if (entries !== undefined && entries.parent !== "") {
				for (const key of look.access(entries.parent).present) {
					if (!present.has(key)) rows.push({ party: partyOf(key), from: putIn(key), hidden: true });
				}
			}
			return rows.sort(
				(a, b) => Number(a.hidden) - Number(b.hidden) || partyKey(a.party).localeCompare(partyKey(b.party)),
			);
		},
		same: (a, b) =>
			sameList(
				a,
				b,
				(x, y) => partyKey(x.party) === partyKey(y.party) && x.hidden === y.hidden && sameOrigin(x.from, y.from),
			),
		watched: () => [],
		persons: () => (caller.kind === "person" ? [caller.person] : []),
	};
}

/**
 * R37 with R9: the things `caller` may link into `workspace`: those linked in a workspace above where they have Link,
 * not linked here already.
 */
function linkableProbe(workspace: string, caller: Caller): Probe<ThingItem[]> {
	return {
		workspace,
		scope: "here",
		prepare: async (load) => {
			if (caller.kind === "person") await load.person(caller.person);
		},
		compute: (look) => {
			const above = aboveOf(look, workspace, caller);
			const here = look.entries(workspace)?.links;
			const rows: ThingItem[] = [];
			for (let at = look.entries(workspace)?.parent ?? ""; at !== ""; at = look.entries(at)?.parent ?? "") {
				if (look.answer(at, at, caller)?.ticks.includes("link") !== true) continue;
				for (const [thing, kind] of look.entries(at)?.links ?? []) {
					if (here?.has(thing) === true || rows.some((row) => row.thing === thing)) continue;
					rows.push({ thing, kind, from: originOf(look, workspace, at, above), hidden: false });
				}
			}
			return rows.sort((a, b) => a.thing.localeCompare(b.thing));
		},
		same: sameThings,
		watched: () => [],
		persons: () => (caller.kind === "person" ? [caller.person] : []),
	};
}

/** One thing as `caller` has it in `workspace`: its kind and where it is linked (`null`: no answer). */
function thingProbe(workspace: string, thing: string, caller: Caller): Probe<{ kind: string; from: Origin } | null> {
	return {
		workspace,
		scope: "here",
		prepare: async (load) => {
			if (caller.kind === "person") await load.person(caller.person);
		},
		compute: (look) => {
			const access = look.access(workspace);
			if (thing === workspace) return access.own === undefined ? null : { kind: access.own.kind, from: HERE };
			const given = access.things.get(thing);
			if (given === undefined || look.answer(workspace, thing, caller) === undefined) return null;
			return { kind: given.kind, from: originOf(look, workspace, given.at, aboveOf(look, workspace, caller)) };
		},
		same: (a, b) => a === b || (a !== null && b !== null && a.kind === b.kind && sameOrigin(a.from, b.from)),
		watched: () => [],
		persons: () => (caller.kind === "person" ? [caller.person] : []),
	};
}

/** The who-may table of one thing, before party names are joined. */
type WhoMayValue = {
	ticks: {
		name: string;
		label: { namespace: string; key: string; params: (string | number | boolean | null)[] };
		for: "agents" | "people" | "all";
	}[];
	linkedIn: Origin;
	rows: { party: Party; name: string; open: Cell; ticks: Record<string, Cell> }[];
};

/**
 * Who may do what with `thing` in `workspace` (R38, R40, item 112): the kind's ticks (on a workspace also the Make
 * cells, `@make:*` and one per registered kind and per stored Make tick), where its grants are written, and a row per
 * party (everyone, the agents, each party present here, each party a row here names): per tick its rows written here
 * and whether the party has it here by every route. Persons present here are loaded to answer the last.
 */
function whoMayProbe(
	workspace: string,
	thing: string,
	caller: Caller,
	kindTable: () => ReadonlyMap<string, { readonly plugin: string; readonly value: KindInfo }>,
): Probe<WhoMayValue> {
	let persons: readonly string[] = [];
	return {
		workspace,
		scope: "here",
		prepare: async (load, look) => {
			if (caller.kind === "person") await load.person(caller.person);
			// The persons whose cells say "has": those present here and those a row here names, loaded so their answers
			// can be computed.
			const entries = look.entries(workspace);
			const named = [...look.access(workspace).present, ...(entries?.grants ?? []).map((row) => row.party)];
			persons = [
				...new Set(named.filter((key) => key.startsWith("person/")).map((key) => key.slice("person/".length))),
			];
			for (const person of persons) await load.person(person);
		},
		compute: (look) => {
			const kinds = kindTable();
			const access = look.access(workspace);
			const entries = look.entries(workspace);
			const own = thing === workspace;
			const given: ThingHere | undefined = own ? access.own : access.things.get(thing);
			const kind = given === undefined ? undefined : kinds.get(given.kind);
			const rowsHere = (own ? entries?.ownGrants : entries?.grants.filter((g) => g.thing === thing)) ?? [];
			const ticks = (kind?.value.ticks ?? []).map(({ name, label, for: forWhom }) => ({
				name,
				label: { namespace: label.namespace, key: label.key, params: [...label.params] },
				for: forWhom,
			}));
			const tickNames = ticks.map(({ name }) => name);
			if (own) {
				const makes = new Set(["@make:*", ...[...kinds.keys()].map((name) => `@make:${name}`)]);
				for (const row of rowsHere) if (row.tick.startsWith("@make:")) makes.add(row.tick);
				tickNames.push(...makes);
			}
			const parties = new Map<string, Party>([
				["everyone", { kind: "everyone" }],
				["agents", { kind: "agents" }],
			]);
			for (const key of access.present) parties.set(key, partyOf(key));
			for (const row of rowsHere) parties.set(row.party, row.who);
			const above = aboveOf(look, workspace, caller);
			const cellOf = (key: string, tick: string): Cell => {
				const here = rowsHere
					.filter((row) => row.party === key && row.tick === tick)
					.map((row) => ({
						gives: row.gives,
						source: row.source,
						kindDefault: row.source.kind === "plugin" && row.source.plugin === kind?.plugin,
						// A giving row counts only where the thing is linked; a withholding one while the thing is here.
						inEffect: given !== undefined && (!row.gives || given.at === workspace),
					}));
				return { here, has: hasTick(look, workspace, thing, given, key, tick) };
			};
			const rows = [...parties].map(([key, party]) => ({
				party,
				name: "",
				open: cellOf(key, OPEN),
				ticks: Object.fromEntries(tickNames.map((tick) => [tick, cellOf(key, tick)])),
			}));
			return {
				ticks,
				linkedIn: given === undefined ? HERE : originOf(look, workspace, given.at, above),
				rows,
			};
		},
		same: sameJson,
		watched: () => [],
		persons: () => (caller.kind === "person" ? [...persons, caller.person] : persons),
	};
}

/**
 * Whether party `key` has `tick` on `thing` here by every route: a person or a session's agent as their answer says
 * (when loaded), any other party as the thing's ticks for it say (a Make tick: given directly).
 */
function hasTick(
	look: Look,
	workspace: string,
	thing: string,
	given: ThingHere | undefined,
	key: string,
	tick: string,
): boolean {
	if (given === undefined) return false;
	const party = partyOf(key);
	if (party.kind === "person" || party.kind === "agent") {
		const caller: Caller =
			party.kind === "person" ? { kind: "person", person: party.person } : { kind: "agent", session: party.session };
		const answer = look.answer(workspace, thing, caller);
		if (tick === OPEN) return answer !== undefined;
		if (tick.startsWith("@make:")) return given.ticks.get(key)?.has(tick) === true;
		return answer?.ticks.includes(tick) === true;
	}
	if (tick === OPEN) return given.ticks.has(key);
	return given.ticks.get(key)?.has(tick) === true;
}

/** Whether two JSON values are the same, field by field. */
function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
	const keys = Object.keys(a);
	if (Array.isArray(b) || keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * `probe` with each row's thing named: the names are read before each computation (a rename touches the things it
 * renames, which asks every probe again), so a list shows them live.
 */
function named<T extends { readonly thing: string }>(store: Store, probe: Probe<T[]>): Probe<(T & { name: string })[]> {
	let names: ReadonlyMap<string, string> = new Map();
	return {
		...probe,
		prepare: async (load, look, ctx) => {
			await probe.prepare(load, look, ctx);
			const things = probe.compute(look).map(({ thing }) => thing);
			names = new Map(
				(await readWhole(store.things.ofIds, { things }, ctx)).map(({ thing, name }) => [thing, name]),
			);
		},
		compute: (look) => probe.compute(look).map((row) => ({ ...row, name: names.get(row.thing) ?? "" })),
		same: (a, b) => probe.same(a, b) && a.every((row, i) => row.name === b[i]!.name),
	};
}

/** The names of the persons and groups `parties` name (and whether a group is outside), by party key. */
async function partiesNamed(
	store: Store,
	parties: readonly Party[],
	ctx: Context,
): Promise<ReadonlyMap<string, { readonly name: string; readonly outside: boolean }>> {
	const persons = parties.flatMap((party) => (party.kind === "person" ? [party.person] : []));
	const groups = parties.flatMap((party) => (party.kind === "group" ? [party.group] : []));
	return new Map([
		...(await readWhole(store.persons.ofIds, { persons }, ctx)).map(
			({ person, name }) => [partyKey({ kind: "person", person }), { name, outside: false }] as const,
		),
		...(await readWhole(store.groups.ofIds, { groups }, ctx)).map(
			({ group, name, outside }) => [partyKey({ kind: "group", group }), { name, outside }] as const,
		),
	]);
}

/** `probe` with each row's party named and marked outside (a group's), read before each computation. */
function withParties<T extends { readonly party: Party }>(
	store: Store,
	probe: Probe<T[]>,
): Probe<(T & { name: string; outside: boolean })[]> {
	let names: ReadonlyMap<string, { readonly name: string; readonly outside: boolean }> = new Map();
	return {
		...probe,
		prepare: async (load, look, ctx) => {
			await probe.prepare(load, look, ctx);
			names = await partiesNamed(
				store,
				probe.compute(look).map(({ party }) => party),
				ctx,
			);
		},
		compute: (look) =>
			probe.compute(look).map((row) => {
				const found = names.get(partyKey(row.party));
				return { ...row, name: found?.name ?? "", outside: found?.outside ?? false };
			}),
		same: (a, b) => probe.same(a, b) && a.every((row, i) => row.name === b[i]!.name && row.outside === b[i]!.outside),
	};
}

/** The who-may `probe` with each row's party named, read before each computation. */
function withRowsNamed(store: Store, probe: Probe<WhoMayValue>): Probe<WhoMayValue> {
	let names: ReadonlyMap<string, { readonly name: string }> = new Map();
	return {
		...probe,
		prepare: async (load, look, ctx) => {
			await probe.prepare(load, look, ctx);
			names = await partiesNamed(
				store,
				probe.compute(look).rows.map(({ party }) => party),
				ctx,
			);
		},
		compute: (look) => {
			const value = probe.compute(look);
			return {
				...value,
				rows: value.rows.map((row) => ({ ...row, name: names.get(partyKey(row.party))?.name ?? "" })),
			};
		},
	};
}

/** Every item of `named` for `args`, which the list it names bounds: past `WHOLE` it fails closed. */
async function readWhole<T, A>(query: NamedQuery<T, A>, args: A, ctx: Context): Promise<T[]> {
	const page = await query.page(args, WHOLE, ctx);
	if (page.next !== undefined) throw new Error(`things: more than ${WHOLE} rows in one list`);
	return page.items;
}

/** How many rows one list's names are read in at most: the list is bounded by one workspace. */
const WHOLE = 5000;
