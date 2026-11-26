// A stand-in for slice 2's server side, for the page's tests only: `Workspace`, the lists (roots, children, what is
// here, who is here, what may be linked), `ThingInfo` and `WhoMay`, served from the things plugin's real store (slice
// 1) by plain reads, again after each write made through `Workspace` (it is no index: no presence, no visibility rules,
// every person may do everything). It registers the plain workspace kind slice 2 brings and two kinds of its own (a
// note without a view, a wall that takes the whole page), and puts every person who holds a workspace into Pi, so the
// things they make there admit them.

import {
	allow,
	type Ctx,
	constant,
	contribute,
	type DefaultsChoice,
	defineFacet,
	deny,
	type FacetHost,
	invalid,
	type JsonValue,
	Linkable,
	local,
	method,
	num,
	type Origin,
	type P3Principal,
	type Reference,
	Roots,
	type Self,
	ThingInfo,
	WhoMay,
	Workspace,
	WorkspaceChildren,
	WorkspaceContents,
	type WorkspaceInfo,
	WorkspacePeople,
} from "@earendil-works/p3/v1";
import { type KindInfo, KindRegistry, type KindView, ThingKindsView, ThingsStore } from "@earendil-works/p3/v1/server";

/** The plain workspace kind (slice 2 declares it); its ticks as the Settings view shows them. */
const WORKSPACE_KIND: KindInfo = {
	name: "things.workspace",
	workspaces: "one",
	makers: "people",
	stacking: "all",
	ticks: ["link", "hide", "configure", "managePeople", "manageAccess"].map((name) => ({
		name,
		label: { namespace: "workspaces-stub", key: name, params: [] },
		for: "all" as const,
	})),
	defaultGrants: {},
	settings: [],
	ticksVersion: 1,
};

/** A kind without a view, with default grants (the picker's preview, the Settings view's "kind default"). */
const NOTE_KIND: KindInfo = {
	name: "workspaces-stub.note",
	workspaces: "many",
	makers: "anyone",
	stacking: "all",
	ticks: [
		{ name: "read", label: { namespace: "workspaces-stub", key: "read", params: [] }, for: "all" },
		{ name: "write", label: { namespace: "workspaces-stub", key: "write", params: [] }, for: "all" },
	],
	defaultGrants: { everyone: ["read"], agents: ["write"] },
	settings: [],
	ticksVersion: 1,
};

/** A kind whose view takes the whole page (the page's web facet gives it). */
const WALL_KIND: KindInfo = { ...NOTE_KIND, name: "workspaces-stub.wall", defaultGrants: {} };

/** The stub's changes: every list reads again when it moves. */
const Changes = local("workspaces-stub.changes", {
	version: 1,
	params: {},
	members: { revision: num(), bump: method() },
});

type Store = Reference<typeof ThingsStore>;
type Party = Parameters<Store["putParty"]>[0]["party"];

export default defineFacet((host, self) => {
	self.contribute(KindRegistry, WORKSPACE_KIND);
	// One contribution per object and registry: the other kinds come from objects of their own.
	for (const kind of [NOTE_KIND, WALL_KIND])
		contribute(host, kind.name, (self) => self.contribute(KindRegistry, kind));
	host.serve(Changes, (_params, self) => {
		const revision = self.writable(0);
		return {
			revision: self.derive([revision], ([value]) => value),
			bump: async () => {
				revision.set(revision.value + 1);
				return null;
			},
		};
	});
	serveWorkspace(host);
	host.serve(Roots, (_params, principal, self) =>
		listOf(self, principal, async (store, ctx) => {
			const pi = await one(store.workspaces.children, { parent: "" }, ctx);
			return pi === undefined ? [] : [await workspaceRow(store, pi.workspace, ctx)];
		}),
	);
	host.serve(WorkspaceChildren, ({ workspace }, principal, self) =>
		listOf(self, principal, async (store, ctx) => {
			const children = await all(store.workspaces.children, { parent: workspace }, ctx);
			return Promise.all(children.map((child) => workspaceRow(store, child.workspace, ctx)));
		}),
	);
	host.serve(WorkspaceContents, ({ workspace }, principal, self) =>
		listOf(self, principal, async (store, ctx) => {
			const hidden = await hiddenHere(store, workspace, ctx);
			return (await reachable(store, workspace, ctx)).map((row) => ({
				...row,
				hidden: hidden.has(`thing/${row.thing}`),
			}));
		}),
	);
	host.serve(WorkspacePeople, ({ workspace }, principal, self) =>
		listOf(self, principal, async (store, ctx) => {
			const hidden = await hiddenHere(store, workspace, ctx);
			const rows = [];
			for (const { workspace: at, from } of await path(store, workspace, ctx)) {
				for (const { party } of await all(store.workspaceMembers.here, { workspace: at }, ctx)) {
					const name = await partyName(store, party, ctx);
					rows.push({ party, name, from, hidden: hidden.has(partyKeyOf(party)), outside: false });
				}
			}
			return rows;
		}),
	);
	host.serve(Linkable, ({ workspace, query }, principal, self) =>
		listOf(self, principal, async (store, ctx) => {
			const here = new Set((await all(store.links.here, { workspace }, ctx)).map(({ thing }) => thing));
			const everything = await everywhere(store, ctx);
			return everything
				.filter(({ thing, name }) => !here.has(thing) && name.toLowerCase().startsWith(query.toLowerCase()))
				.map(({ thing, kind, name, from }) => ({ thing, kind, name, from }));
		}),
	);
	host.serve(ThingInfo, ({ workspace, thing }, principal, self) => {
		const store = self.get(ThingsStore, {});
		const info = self.writable<{ thing: string; kind: string; name: string; from: Origin }>({
			thing,
			kind: "",
			name: "",
			from: { kind: "here" },
		});
		only(principal);
		follow(self, async (ctx) => {
			const found = (await reachable(store, workspace, ctx)).find((row) => row.thing === thing);
			if (found !== undefined) info.set({ thing, kind: found.kind, name: found.name, from: found.from });
		});
		return { info: self.derive([info], ([value]) => value) };
	});
	host.serve(WhoMay, ({ workspace, thing }, principal, self) => {
		const store = self.get(ThingsStore, {});
		const kinds = self.get(ThingKindsView, {});
		const table = self.writable<WhoMayTable>({ ticks: [], linkedIn: { kind: "here" }, rows: [] });
		only(principal);
		follow(self, async (ctx) =>
			table.set(await whoMay(store, Object.values(kinds.kinds.value), workspace, thing, ctx)),
		);
		return { table: self.derive([table], ([value]) => value) };
	});
});

/** The who-may table, as `whoMay` builds it. */
type WhoMayTable = Awaited<ReturnType<typeof whoMay>>;

/** Refuses whoever is no person: the stub serves pages only. */
function only(principal: P3Principal): void {
	if (principal.kind !== "person") throw invalid("args", "workspaces stub: persons only");
}

/** A list's value: rows read again after every stub write (`load` gives them), never more to page. */
function listOf<R extends JsonValue>(
	self: Self<P3Principal>,
	principal: P3Principal,
	load: (store: Store, ctx: Ctx<P3Principal>) => Promise<R[]>,
) {
	only(principal);
	const store = self.get(ThingsStore, {});
	const list = self.writable<{ rows: R[]; moreAfter: boolean }>({
		rows: [],
		moreAfter: false,
	});
	follow(self, async (ctx) => list.set({ rows: await load(store, ctx), moreAfter: false }));
	return { list: self.derive([list], ([value]) => value), more: async () => null };
}

/** Runs `load` once the object is live, and again after every stub write (a failed load keeps the last value). */
function follow(self: Self<P3Principal>, load: (ctx: Ctx<P3Principal>) => Promise<void>): void {
	const changes = self.get(Changes, {});
	self.onLive(async (ctx) => {
		const watch = await changes.revision.watch(ctx);
		watch.start(async () => load(ctx).catch(() => undefined));
		await load(ctx).catch(() => undefined);
	});
}

/** Serves `Workspace`: every member granted to every person; each write bumps the stub's changes. */
function serveWorkspace(host: FacetHost<P3Principal>): void {
	host.serve(
		Workspace,
		({ workspace }, principal, admitted, self) => {
			only(principal);
			const store = self.get(ThingsStore, {});
			const changes = self.get(Changes, {});
			// `only` let persons alone in.
			const person = principal.kind === "person" ? principal.id : "";
			const by = { kind: "person", person } as const;
			const info = self.writable<WorkspaceInfo>({
				workspace,
				name: "",
				kind: WORKSPACE_KIND.name,
				showsThings: true,
				showsPeople: true,
			});
			follow(self, async (ctx) => info.set(await infoOf(store, workspace, ctx)));
			self.onLive((ctx) => enter(store, person, ctx));
			/** Runs a write, then tells every list to read again. */
			const write = async (ctx: Ctx<P3Principal>, run: () => Promise<unknown>) => {
				await run();
				await changes.bump(ctx);
				return null;
			};
			return {
				info: self.derive([info], ([value]) => value),
				makes: () => constant(admitted.makes),
				make: async ({ kind, name, input, defaults }, ctx) => {
					const made =
						kind === WORKSPACE_KIND.name
							? await store.createWorkspace({ kind, name: name ?? "", parent: workspace, by }, ctx)
							: await store.create({ kind, name: name ?? "", workspace, by, input }, ctx);
					if (defaults !== undefined) await dropDefaults(store, workspace, made, defaults, ctx);
					await changes.bump(ctx);
					return made;
				},
				link: ({ thing }, ctx) => write(ctx, () => store.link({ workspace, thing }, ctx)),
				unlink: ({ thing }, ctx) => write(ctx, () => store.unlink({ workspace, thing }, ctx)),
				hide: ({ thing, shown }, ctx) =>
					write(ctx, () => store.setSwitch({ workspace, item: { kind: "thing", thing }, shown }, ctx)),
				setShowsThings: ({ shown }, ctx) =>
					write(ctx, () => store.setDefaults({ workspace, showsThings: shown }, ctx)),
				configure: ({ thing, name }, ctx) =>
					write(ctx, async () => (name === undefined ? null : store.rename({ thing, name }, ctx))),
				picker: async ({ query }, ctx) => {
					const rows = [];
					for (const { workspace: at } of await path(store, workspace, ctx)) {
						for (const { party } of await all(store.workspaceMembers.here, { workspace: at }, ctx)) {
							const name = await partyName(store, party, ctx);
							if (name.toLowerCase().startsWith(query.toLowerCase())) rows.push({ party, name });
						}
					}
					return rows;
				},
				inviteLink: async ({ as }) => ({ url: `/_p3/invite/stub-${as}-${workspace}` }),
				putParty: ({ party }, ctx) => write(ctx, () => store.putParty({ workspace, party, source: by }, ctx)),
				removeParty: ({ party }, ctx) => write(ctx, () => store.removeParty({ workspace, party }, ctx)),
				makeGroup: async ({ name }, ctx) => {
					const group = await store.makeGroup({ name, managedBy: { kind: "people" }, outside: false }, ctx);
					await write(ctx, () => store.putParty({ workspace, party: { kind: "group", group }, source: by }, ctx));
					return group;
				},
				hideParty: ({ party, shown }, ctx) =>
					write(ctx, () => store.setSwitch({ workspace, item: { kind: "party", party }, shown }, ctx)),
				setShowsPeople: ({ shown }, ctx) =>
					write(ctx, () => store.setDefaults({ workspace, showsPeople: shown }, ctx)),
				// One cell, one row (item 112): every row of this cell goes, whatever wrote it; then the caller's, if any.
				setTick: ({ thing, party, tick, gives }, ctx) =>
					write(ctx, async () => {
						const key = partyKeyOf(party);
						const rows = (await all(store.grants.here, { workspace }, ctx)).filter(
							(row) => row.thing === thing && row.tick === tick && partyKeyOf(row.party) === key,
						);
						for (const { source } of rows) {
							await store.setGrants({ source, grants: [{ workspace, thing, party, tick }] }, ctx);
						}
						if (gives !== undefined) {
							await store.setGrants({ source: by, grants: [{ workspace, thing, party, tick, gives }] }, ctx);
						}
					}),
			};
		},
		{
			admit: (_params, principal, self) => {
				if (principal.kind !== "person") return constant(deny("workspaces stub: persons only"));
				const kinds = self.get(ThingKindsView, {});
				return self.derive([kinds.kinds], ([every]) => allow({ granted: [...GRANTED], makes: Object.keys(every) }));
			},
		},
	);
}

/** Every grantable member of `Workspace`: the stub grants them all. */
const GRANTED = [
	"makes",
	"make",
	"link",
	"unlink",
	"hide",
	"setShowsThings",
	"configure",
	"picker",
	"inviteLink",
	"putParty",
	"removeParty",
	"makeGroup",
	"hideParty",
	"setShowsPeople",
	"setTick",
] as const;

/** The who-may table of `thing` in `workspace`. */
async function whoMay(
	store: Store,
	kinds: readonly KindView[],
	workspace: string,
	thing: string,
	ctx: Ctx<P3Principal>,
) {
	const row = await one(store.things.one, { thing }, ctx);
	const kind = row?.kind === WORKSPACE_KIND.name ? WORKSPACE_KIND : kinds.find(({ name }) => name === row?.kind);
	const ticks = (kind?.ticks ?? []).map(({ name, label, for: forWhom }) => ({ name, label, for: forWhom }));
	const names = [...ticks.map(({ name }) => name)];
	if (thing === workspace) names.push("@make:*", ...kinds.map(({ name }) => `@make:${name}`));
	const steps = await path(store, workspace, ctx);
	const grants = [];
	for (const { workspace: at } of steps) grants.push(...(await all2(store, at, ctx)));
	const mine = grants.filter((grant) => grant.thing === thing);
	const parties: Party[] = [{ kind: "everyone" }, { kind: "agents" }];
	for (const { workspace: at } of steps) {
		for (const { party } of await all(store.workspaceMembers.here, { workspace: at }, ctx)) parties.push(party);
	}
	for (const { party } of mine) parties.push(party);
	const seen = new Set<string>();
	const rows = [];
	for (const party of parties) {
		const key = partyKeyOf(party);
		if (seen.has(key)) continue;
		seen.add(key);
		const cell = (tick: string) => {
			const here = mine
				.filter((grant) => grant.workspace === workspace && grant.tick === tick && partyKeyOf(grant.party) === key)
				.map(({ gives, source }) => ({ gives, source, kindDefault: source.kind === "plugin", inEffect: true }));
			const withheld = mine.some((grant) => grant.tick === tick && !grant.gives && partyKeyOf(grant.party) === key);
			const given = mine.some(
				(grant) =>
					grant.tick === tick &&
					grant.gives &&
					(partyKeyOf(grant.party) === key || (party.kind !== "agents" && grant.party.kind === "everyone")),
			);
			return { here, has: given && !withheld };
		};
		rows.push({
			party,
			name: await partyName(store, party, ctx),
			open: cell("@open"),
			ticks: Object.fromEntries(names.map((name) => [name, cell(name)])),
		});
	}
	const linked = (await reachable(store, workspace, ctx)).find((entry) => entry.thing === thing);
	return {
		ticks,
		linkedIn: thing === workspace ? ({ kind: "here" } as Origin) : (linked?.from ?? { kind: "here" }),
		rows,
	};
}

/** Every grant row written in `workspace`. */
async function all2(store: Store, workspace: string, ctx: Ctx<P3Principal>) {
	return all(store.grants.here, { workspace }, ctx);
}

/** Drops the default grants the person unticked in the add-thing dialog (the kind's plugin wrote them). */
async function dropDefaults(
	store: Store,
	workspace: string,
	thing: string,
	defaults: DefaultsChoice,
	ctx: Ctx<P3Principal>,
): Promise<void> {
	const written = (await all(store.grants.here, { workspace }, ctx)).filter(
		(grant) => grant.thing === thing && grant.source.kind === "plugin",
	);
	for (const grant of written) {
		const kept = grant.party.kind === "everyone" ? defaults.everyone : defaults.agents;
		if (grant.party.kind !== "everyone" && grant.party.kind !== "agents") continue;
		if (kept.includes(grant.tick)) continue;
		await store.setGrants(
			{ source: grant.source, grants: [{ workspace, thing, party: grant.party, tick: grant.tick }] },
			ctx,
		);
	}
}

/** Puts `person` into Pi once, so the things they make there count them as here. */
async function enter(store: Store, person: string, ctx: Ctx<P3Principal>): Promise<void> {
	const pi = await one(store.workspaces.children, { parent: "" }, ctx);
	if (pi === undefined || person === "") return;
	const members = await all(store.workspaceMembers.here, { workspace: pi.workspace }, ctx);
	if (members.some(({ party }) => party.kind === "person" && party.person === person)) return;
	await store.putParty(
		{ workspace: pi.workspace, party: { kind: "person", person }, source: { kind: "person", person } },
		ctx,
	);
}

/** `workspace` and the workspaces above it, nearest first, each with how its things reach `workspace`. */
async function path(store: Store, workspace: string, ctx: Ctx<P3Principal>) {
	const steps: { workspace: string; from: Origin }[] = [];
	let at: string | undefined = workspace;
	while (at !== undefined && at !== "") {
		const here: string = at;
		const row: { readonly parent: string } | undefined = await one(store.workspaces.one, { workspace: here }, ctx);
		const name = (await one(store.things.one, { thing: here }, ctx))?.name ?? "";
		steps.push({
			workspace: here,
			from: here === workspace ? { kind: "here" } : { kind: "above", workspace: here, name },
		});
		at = row?.parent;
	}
	return steps;
}

/** Every thing linked anywhere in the tree (the stub lets everyone link everything). */
async function everywhere(store: Store, ctx: Ctx<P3Principal>) {
	const rows: { thing: string; kind: string; name: string; from: Origin }[] = [];
	const seen = new Set<string>();
	const pi = await one(store.workspaces.children, { parent: "" }, ctx);
	const queue = pi === undefined ? [] : [pi.workspace];
	for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
		const name = (await one(store.things.one, { thing: at }, ctx))?.name ?? "";
		for (const { thing } of await all(store.links.here, { workspace: at }, ctx)) {
			const row = await one(store.things.one, { thing }, ctx);
			if (row === undefined || seen.has(thing)) continue;
			seen.add(thing);
			if (row.kind === WORKSPACE_KIND.name) queue.push(thing);
			else rows.push({ thing, kind: row.kind, name: row.name, from: { kind: "above", workspace: at, name } });
		}
		for (const child of await all(store.workspaces.children, { parent: at }, ctx)) {
			if (!seen.has(child.workspace)) queue.push(child.workspace);
			seen.add(child.workspace);
		}
	}
	return rows;
}

/** Every thing linked in `workspace` or above, nearest first, with its kind and name. */
async function reachable(store: Store, workspace: string, ctx: Ctx<P3Principal>) {
	const rows: { thing: string; kind: string; name: string; from: Origin }[] = [];
	const seen = new Set<string>();
	for (const { workspace: at, from } of await path(store, workspace, ctx)) {
		for (const { thing } of await all(store.links.here, { workspace: at }, ctx)) {
			if (seen.has(thing) || thing === workspace) continue;
			seen.add(thing);
			const row = await one(store.things.one, { thing }, ctx);
			if (row === undefined || row.kind === WORKSPACE_KIND.name) continue;
			rows.push({ thing, kind: row.kind, name: row.name, from });
		}
	}
	return rows;
}

/** The item keys a switch hides in `workspace`. */
async function hiddenHere(store: Store, workspace: string, ctx: Ctx<P3Principal>): Promise<ReadonlySet<string>> {
	const switches = await all(store.switches.here, { workspace }, ctx);
	return new Set(
		switches
			.filter(({ shown }) => !shown)
			.map(({ item }) => (item.kind === "thing" ? `thing/${item.thing}` : partyKeyOf(item.party))),
	);
}

/** A workspace's row in a list. */
async function workspaceRow(store: Store, workspace: string, ctx: Ctx<P3Principal>) {
	const row = await one(store.things.one, { thing: workspace }, ctx);
	return { workspace, kind: row?.kind ?? WORKSPACE_KIND.name, name: row?.name ?? "" };
}

/** A workspace's info: its row, and its parent's name. */
async function infoOf(store: Store, workspace: string, ctx: Ctx<P3Principal>) {
	const row = await one(store.workspaces.one, { workspace }, ctx);
	const thing = await one(store.things.one, { thing: workspace }, ctx);
	if (row === undefined || thing === undefined) throw invalid("args", `workspaces stub: no workspace ${workspace}`);
	const parent = row.parent === "" ? undefined : await one(store.things.one, { thing: row.parent }, ctx);
	return {
		workspace,
		name: thing.name,
		kind: thing.kind,
		showsThings: row.showsThings,
		showsPeople: row.showsPeople,
		...(parent === undefined ? {} : { parent: { workspace: parent.thing, name: parent.name } }),
	};
}

/** How the page names a party. */
async function partyName(store: Store, party: Party, ctx: Ctx<P3Principal>): Promise<string> {
	switch (party.kind) {
		case "everyone":
			return "everyone here";
		case "agents":
			return "agents";
		case "person":
			return (await one(store.persons.one, { person: party.person }, ctx))?.name ?? party.person;
		case "group":
			return `group ${party.group.slice(0, 8)}`;
		case "agent":
			return `agent of ${party.session.slice(0, 8)}`;
	}
}

/** A party's key, as the things plugin's `partyKey`. */
function partyKeyOf(party: Party): string {
	switch (party.kind) {
		case "everyone":
		case "agents":
			return party.kind;
		case "person":
			return `person/${party.person}`;
		case "group":
			return `group/${party.group}`;
		case "agent":
			return `agent/${party.session}`;
	}
}

/** A named query's rows (the stub's worlds are small: one page of 500). */
async function all<A, R>(
	query: { page(args: A, first: number, ctx: Ctx<P3Principal>): Promise<{ readonly items: readonly R[] }> },
	args: A,
	ctx: Ctx<P3Principal>,
): Promise<readonly R[]> {
	return (await query.page(args, 500, ctx)).items;
}

/** A named query's first row. */
async function one<A, R>(
	query: { page(args: A, first: number, ctx: Ctx<P3Principal>): Promise<{ readonly items: readonly R[] }> },
	args: A,
	ctx: Ctx<P3Principal>,
): Promise<R | undefined> {
	return (await query.page(args, 1, ctx)).items[0];
}
