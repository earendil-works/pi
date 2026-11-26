// What the page lists about workspaces (`workspace.ts`; ERNDL-1141 §8 and §9): the caller's roots, a workspace's
// children, what is here, who is here, what may be linked here, one thing as it is available here, and who may do what
// with a thing here. Each is computed over the access index as a probe (`access.ts`), live: asked again after every
// commit it can depend on, told only when it changed; names and other display columns are joined from the store by
// named queries. Admitted by the caller's answer on the workspace (anyone present; ThingInfo: an answer on the thing;
// WhoMay too is read by anyone present, only `Workspace.setTick` needs Manage access). No list names a workspace the
// caller is not present in (item 96). The lists are bounded by one workspace (its contents, its people, its children),
// each read whole: a list has no further pages.

import {
	type Admission,
	type AdmitSelf,
	allow,
	type Context,
	callerKey,
	deny,
	type FacetHost,
	type JsonValue,
	type P3Principal,
	type Reference,
	type Self,
	until,
	type Watchable,
} from "@earendil-works/p3/v1";
import type { Answers, Look, Probe } from "./access.ts";
import { callerOf } from "./admission.ts";
import { AccessHandles, Gives, ThingsStore } from "./contract.server.ts";
import { type Caller, kindOfMakeTick, MAKE_ANY, makeTick, OPEN, type Party, partyKey, partyOf } from "./contract.ts";
import { type KindInfo, ThingKinds } from "./kind.ts";
import { messages } from "./messages.ts";
import { readAll, readWhole } from "./reader.ts";
import type { OwnHere, ThingHere } from "./rules.ts";
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
		return listOf(self, () => rootsProbe(store, callerOf(principal)));
	});
	host.serve(
		WorkspaceChildren,
		({ workspace }, principal, _admitted, self) => {
			const store = self.get(ThingsStore, {});
			return listOf(self, () => childrenProbe(store, workspace, callerOf(principal)));
		},
		{ admit: admitPresent },
	);
	host.serve(
		WorkspaceContents,
		({ workspace }, principal, _admitted, self) => {
			const store = self.get(ThingsStore, {});
			return listOf(self, () => named(store, contentsProbe(workspace, callerOf(principal))));
		},
		{ admit: admitPresent },
	);
	host.serve(
		WorkspacePeople,
		({ workspace }, principal, _admitted, self) => {
			const store = self.get(ThingsStore, {});
			return listOf(self, () => withParties(store, peopleProbe(workspace, callerOf(principal))));
		},
		{ admit: admitPresent },
	);
	host.serve(
		Linkable,
		({ workspace, query }, principal, _admitted, self) => {
			const store = self.get(ThingsStore, {});
			return listOf(self, () => named(store, linkableProbe(workspace, callerOf(principal))), query.toLowerCase());
		},
		{ admit: admitPresent },
	);
	host.serve(
		ThingInfo,
		({ workspace, thing }, principal, _admitted, self) => {
			const store = self.get(ThingsStore, {});
			const found = followProbe(self, () => thingProbe(workspace, thing, callerOf(principal)));
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
		{ admit: admitWhen((answers, { thing }) => answers[thing] !== undefined) },
	);
	host.serve(
		WhoMay,
		({ workspace, thing }, principal, _admitted, self) => {
			const store = self.get(ThingsStore, {});
			const kinds = self.registry(ThingKinds);
			const probe = whoMayProbe(workspace, thing, callerOf(principal), () => kinds.value);
			return { table: followProbe(self, () => withRowsNamed(store, probe)) };
		},
		{ admit: admitPresent },
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

/**
 * A list's members over the probe `make` builds: its rows whole (a list is bounded by one workspace: no further pages),
 * those whose name starts with `prefix` (lower case; a list of named rows).
 */
function listOf<T extends JsonValue & { readonly name?: string }>(
	self: Self<P3Principal>,
	make: () => Probe<T[]>,
	prefix = "",
) {
	const rows = followProbe(self, make);
	return {
		list: self.derive([rows], ([items]) => ({
			rows: prefix === "" ? items : items.filter(({ name }) => name?.toLowerCase().startsWith(prefix) === true),
			moreAfter: false,
		})),
		more: async () => null,
	};
}

/** An admission by what the workspace gives the caller: `lets` says whether its answers let them in. */
function admitWhen<P extends { readonly workspace: string }>(lets: (answers: Answers, params: P) => boolean) {
	return (params: P, principal: P3Principal, self: AdmitSelf): Watchable<Admission<Record<never, never>>> => {
		const gives = self.get(Gives, { workspace: params.workspace, caller: callerKey(principal) }).answers;
		return self.derive([gives], ([answers]) => (lets(answers, params) ? ALLOWED : NOT_PRESENT));
	};
}

/** Admits anyone present in the workspace: who has an answer on its own thing (item 88). */
const admitPresent = admitWhen((answers, { workspace }) => answers[workspace] !== undefined);

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
	return {
		workspace: "",
		caller,
		compute: async (look, load, ctx) => {
			const root = (await readAll(store.workspaces.children, { parent: "" }, ctx))[0]?.workspace ?? "";
			const keys = [partyKey(caller.kind === "server" ? { kind: "everyone" } : caller)];
			if (caller.kind === "person") {
				for (const { group } of await readAll(store.groupMembers.ofPerson, { person: caller.person }, ctx))
					keys.push(partyKey({ kind: "group", group }));
			}
			load.parties(keys);
			const candidates = new Set<string>();
			for (const key of keys) {
				for (const { workspace } of await readAll(store.workspaceMembers.where, { partyKey: key }, ctx))
					candidates.add(workspace);
			}
			for (const workspace of [root, ...candidates]) await load.workspace(workspace);
			const everything =
				caller.kind === "server" || (caller.kind === "person" && look.person(caller.person)?.owner === true);
			if (everything) return root === "" ? [] : [itemOf(look, root)];
			const roots = [...candidates].filter((workspace) => {
				const answer = look.answer(workspace, workspace, caller);
				const parent = look.entries(workspace)?.parent ?? "";
				return answer !== undefined && !(answer.above ?? []).includes(parent);
			});
			return roots.map((workspace) => itemOf(look, workspace)).sort(byName);
		},
	};
}

/** The workspaces right below `workspace` that `caller` is present in. */
function childrenProbe(store: Store, workspace: string, caller: Caller): Probe<WorkspaceItem[]> {
	return {
		workspace,
		caller,
		compute: async (look, load, ctx) => {
			const children = await readAll(store.workspaces.children, { parent: workspace }, ctx);
			for (const child of children) await load.workspace(child.workspace);
			return children
				.filter((child) => look.answer(child.workspace, child.workspace, caller) !== undefined)
				.map((child) => itemOf(look, child.workspace))
				.sort(byName);
		},
	};
}

/**
 * What is here for `caller`: every thing available here they get an answer for, and, for whoever has Hide here, every
 * thing from above a switch or the default hides here.
 */
function contentsProbe(workspace: string, caller: Caller): Probe<ThingItem[]> {
	return {
		workspace,
		caller,
		compute: async (look) => {
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
	};
}

/**
 * Who is here: every party present here (put in here, or from above and shown), and every party present above that
 * a switch or the default hides here, each with where it was put in.
 */
function peopleProbe(workspace: string, caller: Caller): Probe<PartyItem[]> {
	return {
		workspace,
		caller,
		compute: async (look) => {
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
	};
}

/**
 * R37 with R9: the things `caller` may link into `workspace`: those linked in a workspace above where they have Link,
 * not linked here already.
 */
function linkableProbe(workspace: string, caller: Caller): Probe<Omit<ThingItem, "hidden">[]> {
	return {
		workspace,
		caller,
		compute: async (look) => {
			const above = aboveOf(look, workspace, caller);
			const here = look.entries(workspace)?.links;
			const rows: Omit<ThingItem, "hidden">[] = [];
			for (let at = look.entries(workspace)?.parent ?? ""; at !== ""; at = look.entries(at)?.parent ?? "") {
				if (look.answer(at, at, caller)?.ticks.includes("link") !== true) continue;
				for (const [thing, kind] of look.entries(at)?.links ?? []) {
					if (here?.has(thing) === true || rows.some((row) => row.thing === thing)) continue;
					rows.push({ thing, kind, from: originOf(look, workspace, at, above) });
				}
			}
			return rows.sort((a, b) => a.thing.localeCompare(b.thing));
		},
	};
}

/** One thing as `caller` has it in `workspace`: its kind and where it is linked (`null`: no answer). */
function thingProbe(workspace: string, thing: string, caller: Caller): Probe<{ kind: string; from: Origin } | null> {
	return {
		workspace,
		caller,
		compute: async (look) => {
			const access = look.access(workspace);
			if (thing === workspace) return access.own === undefined ? null : { kind: access.own.kind, from: HERE };
			const given = access.things.get(thing);
			if (given === undefined || look.answer(workspace, thing, caller) === undefined) return null;
			return { kind: given.kind, from: originOf(look, workspace, given.at, aboveOf(look, workspace, caller)) };
		},
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
	return {
		workspace,
		caller,
		compute: async (look, load) => {
			const kinds = kindTable();
			const access = look.access(workspace);
			const entries = look.entries(workspace);
			const own = thing === workspace;
			const given: ThingHere | undefined = own ? access.own : access.things.get(thing);
			const kind = given === undefined ? undefined : kinds.get(given.kind);
			const rowsHere = (own ? entries?.ownGrants : entries?.grants.filter((g) => g.thing === thing)) ?? [];
			// The persons whose cells say "has": those present here and those a row of this thing here names (present
			// or not), loaded so their answers can be computed.
			for (const key of [...access.present, ...rowsHere.map((row) => row.party)]) {
				const party = partyOf(key);
				if (party.kind === "person") await load.person(party.person);
			}
			const ticks = (kind?.value.ticks ?? []).map(({ name, label, for: forWhom }) => ({
				name,
				label: { namespace: label.namespace, key: label.key, params: [...label.params] },
				for: forWhom,
			}));
			const tickNames = ticks.map(({ name }) => name);
			if (own) {
				const makes = new Set([MAKE_ANY, ...[...kinds.keys()].map((name) => makeTick({ name }))]);
				for (const row of rowsHere) if (kindOfMakeTick(row.tick) !== undefined) makes.add(row.tick);
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
				return { here, has: hasTick(look, workspace, thing, given, key, tick, kinds) };
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
	};
}

/**
 * Whether party `key` has `tick` on `thing` here by every route (`Cell.has`): a person or a session's agent as their
 * answer says (a Make cell: the kinds in its `makes`; `MAKE_ANY`: every kind they could make here), any other party as
 * the thing's ticks for it say (a Make cell: its row of that kind or of `MAKE_ANY`, less what is withheld from it).
 */
function hasTick(
	look: Look,
	workspace: string,
	thing: string,
	given: ThingHere | undefined,
	key: string,
	tick: string,
	kinds: ReadonlyMap<string, { readonly value: KindInfo }>,
): boolean {
	if (given === undefined) return false;
	const made = kindOfMakeTick(tick);
	const party = partyOf(key);
	if (party.kind === "person" || party.kind === "agent") {
		const caller: Caller =
			party.kind === "person" ? { kind: "person", person: party.person } : { kind: "agent", session: party.session };
		const answer = look.answer(workspace, thing, caller);
		if (tick === OPEN) return answer !== undefined;
		if (made === undefined) return answer?.ticks.includes(tick) === true;
		const makes = answer?.makes ?? [];
		if (made !== "*") return makes.includes(made);
		const could = [...kinds].filter(([, { value }]) => makerMay(value, party.kind === "agent" ? "agent" : "person"));
		return (
			could.length > 0 && could.every(([name]) => makes.includes(name) || !mayHoldHere(look, workspace, kinds, name))
		);
	}
	if (tick === OPEN) return given.ticks.has(key);
	const ticks = given.ticks.get(key);
	if (made === undefined) return ticks?.has(tick) === true;
	// A Make cell exists only on a workspace's own thing, which the index keeps as an `OwnHere` (with what is withheld).
	const withheld = (given as Partial<OwnHere>).makesWithheld?.get(key);
	const any = ticks?.has(MAKE_ANY) === true && withheld?.has(MAKE_ANY) !== true;
	if (made === "*") return any;
	return (ticks?.has(tick) === true || any) && withheld?.has(tick) !== true;
}

/** Whether a kind's `makers` lets `maker` make its things through a workspace (item 114). */
function makerMay(kind: KindInfo, maker: "person" | "agent"): boolean {
	return kind.makers === "anyone" || (kind.makers === "people" && maker === "person");
}

/** Whether a thing of kind `name` may be made in `workspace` at all: a leaf holds no workspace kinds (decision 13). */
function mayHoldHere(
	look: Look,
	workspace: string,
	kinds: ReadonlyMap<string, { readonly value: KindInfo }>,
	name: string,
): boolean {
	const here = look.entries(workspace)?.kind;
	return !(kinds.get(here ?? "")?.value.workspace === "leaf" && kinds.get(name)?.value.workspace !== "no");
}

/**
 * `probe` with each row's thing named and the rows in reading order: the names are read at each computation (a rename
 * of a thing it shows asks it again).
 */
function named<T extends { readonly thing: string; readonly hidden?: boolean }>(
	store: Store,
	probe: Probe<T[]>,
): Probe<(T & { name: string })[]> {
	return {
		...probe,
		compute: async (look, load, ctx) => {
			const rows = await probe.compute(look, load, ctx);
			const things = rows.map(({ thing }) => thing);
			load.things(things);
			const names = new Map(
				(await readWhole(store.things.ofIds, { things }, ctx)).map(({ thing, name }) => [thing, name]),
			);
			// In the order a person reads them: what is here before what is hidden, then by name (then id).
			return rows
				.map((row) => ({ ...row, name: names.get(row.thing) ?? "" }))
				.sort(
					(a, b) =>
						Number(a.hidden === true) - Number(b.hidden === true) ||
						a.name.localeCompare(b.name) ||
						a.thing.localeCompare(b.thing),
				);
		},
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

/** `rows` with each one's party named and marked outside (a group's). */
async function withNames<T extends { readonly party: Party }>(
	store: Store,
	rows: readonly T[],
	ctx: Context,
): Promise<(T & { name: string; outside: boolean })[]> {
	const names = await partiesNamed(
		store,
		rows.map(({ party }) => party),
		ctx,
	);
	return rows.map((row) => {
		const found = names.get(partyKey(row.party));
		return { ...row, name: found?.name ?? "", outside: found?.outside ?? false };
	});
}

/** `probe` with each row's party named and marked outside, read at each computation. */
function withParties<T extends { readonly party: Party }>(
	store: Store,
	probe: Probe<T[]>,
): Probe<(T & { name: string; outside: boolean })[]> {
	return {
		...probe,
		compute: async (look, load, ctx) => withNames(store, await probe.compute(look, load, ctx), ctx),
	};
}

/** The who-may `probe` with each row's party named, read at each computation. */
function withRowsNamed(store: Store, probe: Probe<WhoMayValue>): Probe<WhoMayValue> {
	return {
		...probe,
		compute: async (look, load, ctx) => {
			const value = await probe.compute(look, load, ctx);
			const rows = await withNames(store, value.rows, ctx);
			return { ...value, rows: rows.map(({ outside: _outside, ...row }) => row) };
		},
	};
}
