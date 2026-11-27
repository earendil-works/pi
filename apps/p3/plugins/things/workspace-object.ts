// The `Workspace` object (R4, `workspace.ts`): what a page or an agent holds of a workspace, one per workspace and
// caller, admitted by the caller's answer on the workspace's own thing (item 88: its own grants, written at itself,
// count there only): anyone present is let in and sees its info; each workspace tick they have grants its members
// (Link: link and unlink; Hide: hide and the things default; Configure: configure; Manage people: the people calls;
// Manage access: setTick), and a non-empty `makes` (the kinds their Make ticks name, within each kind's `makers`, item
// 114) grants `make`. Every change is one write of the things store with the caller as its source.

import {
	type Admission,
	type AdmitSelf,
	allow,
	type Ctx,
	callerKey,
	constant,
	deny,
	type FacetHost,
	type GrantableName,
	invalid,
	type P3Principal,
	type Reference,
	type Watchable,
} from "@earendil-works/p3/v1";
import { callerOf } from "./admission.ts";
import { Gives, ThingsStore, type WorkspaceRow } from "./contract.server.ts";
import type { Source } from "./contract.ts";
import { ThingKinds, WORKSPACE_TICKS, type WorkspaceTick } from "./kind.ts";
import { messages } from "./messages.ts";
import { readWhole } from "./reader.ts";
import type { Answer } from "./rules.ts";
import { Workspace, type WorkspaceInfo } from "./workspace.ts";
import { THINGS_PLUGIN } from "./workspaces.ts";

/** What a holder of `Workspace` is admitted with: the members granted, and the kinds they may make here. */
type WorkspaceAdmitted = { readonly granted: GrantableName<typeof Workspace>[]; readonly makes: string[] };

/** The members of `Workspace` each workspace tick gives (decision 80). */
const GIVES: Readonly<Record<WorkspaceTick, readonly GrantableName<typeof Workspace>[]>> = {
	link: ["link", "unlink"],
	hide: ["hide", "setShowsThings"],
	configure: ["configure"],
	managePeople: ["picker", "inviteLink", "putParty", "removeParty", "makeGroup", "hideParty", "setShowsPeople"],
	manageAccess: ["setTick"],
};

/** Serves `Workspace` on `host`. */
export function serveWorkspace(host: FacetHost<P3Principal>): void {
	host.serve(
		Workspace,
		({ workspace }, principal, admitted, self) => {
			const store = self.get(ThingsStore, {});
			const gives = self.get(Gives, { workspace, caller: callerKey(principal) }).answers;
			// The caller's own answer here: the index keeps its object while it is unchanged, so the info is not computed
			// again when another thing's answer changes.
			const own = self.derive([gives], ([answers]) => answers[workspace] ?? null);
			const line = self.liveQuery(store.workspaces.one, { workspace }, { first: 1 });
			const thing = self.liveQuery(store.things.one, { thing: workspace }, { first: 1 });
			const parentArgs = self.derive([line], ([{ rows }]) => ({ workspace: rows[0]?.parent ?? "" }));
			const parent = self.liveQuery(store.workspaces.one, parentArgs, { first: 1 });
			const by = sourceOf(principal);
			const kinds = self.registry(ThingKinds);
			return {
				info: self.derive([line, thing, parent, own], ([lines, things, parents, answer]) =>
					infoOf(workspace, lines.rows[0], things.rows[0]?.view ?? "", parents.rows[0], answer ?? undefined),
				),
				makes: () => constant(admitted.makes),
				make: async ({ kind, name, input, defaults, private: secret }, ctx) => {
					if (!admitted.makes.includes(kind)) {
						throw invalid("args", `things: ${kind} is not made here by this caller`, {
							message: messages.message("mayNotMake", kind),
						});
					}
					const args = { kind, name: name ?? "", by, input, defaults };
					return kinds.value.get(kind)?.value.workspace === "no"
						? store.create({ ...args, workspace }, ctx)
						: store.createWorkspace({ ...args, parent: workspace, showsPeople: secret !== true }, ctx);
				},
				link: async ({ thing: linked, defaults }, ctx) => {
					await mayLink(store, linked, principal, ctx);
					await store.link({ workspace, thing: linked, defaults }, ctx);
					return null;
				},
				unlink: async ({ thing: unlinked }, ctx) => {
					if ((await linkedIn(store, unlinked, ctx)).includes(workspace)) {
						await store.unlink({ workspace, thing: unlinked }, ctx);
						return null;
					}
					const child = (await store.workspaces.one.page({ workspace: unlinked }, 1, ctx)).items[0];
					if (child?.parent !== workspace) throw notLinkedHere(unlinked, workspace);
					await store.removeWorkspace({ workspace: unlinked }, ctx);
					return null;
				},
				hide: async ({ thing: hidden, shown }, ctx) => {
					if ((await linkedIn(store, hidden, ctx)).includes(workspace)) {
						throw invalid("args", `things: ${hidden} is linked in ${workspace}, not from above`, {
							message: messages.message("fromAboveOnly"),
						});
					}
					await store.setSwitch({ workspace, item: { kind: "thing", thing: hidden }, shown }, ctx);
					return null;
				},
				setShowsThings: async ({ shown }, ctx) => {
					await store.setDefaults({ workspace, showsThings: shown }, ctx);
					return null;
				},
				configure: async ({ thing: configured, name, view, settings }, ctx) => {
					await mustBeHere(store, workspace, configured, ctx);
					await store.configure({ thing: configured, name, view, settings }, ctx);
					return null;
				},
				// Manage people (ERNDL-1144): the picker, invite links, groups; a caller but the owner and server code names
				// only whom the picker offers them (checked with the write, in the store).
				picker: async ({ query }, ctx) => store.picker({ workspace, caller: callerOf(principal), query }, ctx),
				inviteLink: async (args, ctx) => {
					const secret = await store.createInvite({ ...args, workspace, by }, ctx);
					// Its page is the base's invite route (the people plugin's until ERNDL-1144 push B moves it here).
					return { url: `/_p3/invite#${secret}` };
				},
				makeGroup: async ({ name }, ctx) => {
					const managers = principal.kind === "person" ? [{ kind: "person", person: principal.id } as const] : [];
					const group = await store.makeGroup(
						{ name, managedBy: { kind: "people" }, outside: false, managers },
						ctx,
					);
					await store.putParty({ workspace, party: { kind: "group", group }, source: by }, ctx);
					return group;
				},
				putParty: async ({ party }, ctx) => {
					await store.putParty({ workspace, party, source: by, caller: callerOf(principal) }, ctx);
					return null;
				},
				removeParty: async ({ party }, ctx) => {
					await store.removeParty({ workspace, party }, ctx);
					return null;
				},
				hideParty: async ({ party, shown }, ctx) => {
					await store.setSwitch({ workspace, item: { kind: "party", party }, shown }, ctx);
					return null;
				},
				setShowsPeople: async ({ shown }, ctx) => {
					await store.setDefaults({ workspace, showsPeople: shown }, ctx);
					return null;
				},
				setTick: async ({ thing: ticked, party, tick, gives: given }, ctx) => {
					await store.setTick({ workspace, thing: ticked, party, tick, gives: given, source: by }, ctx);
					return null;
				},
			};
		},
		{ admit: admitWorkspace() },
	);
}

/**
 * The admission of `Workspace`: the caller's answer on the workspace's own thing (through `Gives`, live); none denies
 * with `notGiven`. Each answer's decision is made once and kept while the answer object lives.
 */
function admitWorkspace() {
	const decisions = new WeakMap<Answer, Admission<WorkspaceAdmitted>>();
	return (
		{ workspace }: { readonly workspace: string },
		principal: P3Principal,
		self: AdmitSelf,
	): Watchable<Admission<WorkspaceAdmitted>> => {
		const gives = self.get(Gives, { workspace, caller: callerKey(principal) }).answers;
		return self.derive([gives], ([answers]) => {
			const mine = answers[workspace];
			if (mine === undefined) return DENIED;
			let decision = decisions.get(mine);
			if (decision === undefined) {
				const makes = mine.makes ?? [];
				const granted = WORKSPACE_TICKS.filter(({ name }) => mine.ticks.includes(name)).flatMap(
					({ name }) => GIVES[name],
				);
				decision = allow({ granted: makes.length === 0 ? granted : [...granted, "makes", "make"], makes });
				decisions.set(mine, decision);
			}
			return decision;
		});
	};
}

/** A workspace's info as its holder sees it (item 96: its parent only if they are present there). */
function infoOf(
	workspace: string,
	line: WorkspaceRow | undefined,
	view: string,
	parent: WorkspaceRow | undefined,
	answer: { readonly above?: readonly string[] } | undefined,
): WorkspaceInfo {
	const seen = parent !== undefined && answer?.above?.includes(parent.workspace) === true;
	return {
		workspace,
		name: line?.name ?? "",
		kind: line?.kind ?? "",
		...(view === "" ? {} : { view }),
		showsThings: line?.showsThings ?? true,
		showsPeople: line?.showsPeople ?? true,
		...(seen ? { parent: { workspace: parent.workspace, name: parent.name } } : {}),
	};
}

/**
 * R9: linking an existing thing needs Link here (the member) and Link in a workspace where it is linked now, so a
 * switch above cannot be undone by linking the thing again below it; `invalid` with `mayNotLink` otherwise.
 */
async function mayLink(
	store: Reference<typeof ThingsStore>,
	thing: string,
	principal: P3Principal,
	ctx: Ctx<P3Principal>,
): Promise<void> {
	if (principal.kind === "server") return;
	const caller = callerKey(principal);
	for (const workspace of await linkedIn(store, thing, ctx)) {
		const answer = await store.answerOf({ workspace, thing: workspace, caller }, ctx);
		if (answer?.ticks.includes("link") === true) return;
	}
	throw invalid("args", `things: no Link where ${thing} is linked now`, { message: messages.message("mayNotLink") });
}

/** The workspaces `thing` is linked in, read whole (what "linked here" and R9 are decided by). */
async function linkedIn(store: Reference<typeof ThingsStore>, thing: string, ctx: Ctx<P3Principal>): Promise<string[]> {
	return (await readWhole(store.links.where, { thing }, ctx)).map(({ workspace }) => workspace);
}

/** Throws unless `thing` is `workspace` itself, linked in it, or a workspace right below it. */
async function mustBeHere(
	store: Reference<typeof ThingsStore>,
	workspace: string,
	thing: string,
	ctx: Ctx<P3Principal>,
): Promise<void> {
	if (thing === workspace) return;
	if ((await linkedIn(store, thing, ctx)).includes(workspace)) return;
	if ((await store.workspaces.one.page({ workspace: thing }, 1, ctx)).items[0]?.parent === workspace) return;
	throw notLinkedHere(thing, workspace);
}

/** The refusal of a thing that is not linked in `workspace`. */
function notLinkedHere(thing: string, workspace: string) {
	return invalid("args", `things: ${thing} is not linked in ${workspace}`, {
		message: messages.message("notLinkedHere"),
	});
}

/** The denial of a caller not present in the workspace: one value, so an unchanged denial is the same decision. */
const DENIED = deny("things: not present in the workspace", messages.message("notGiven"));

/** Who writes as `principal`: a person, a session's agent, or (the server) the things plugin. */
function sourceOf(principal: P3Principal): Source {
	switch (principal.kind) {
		case "person":
			return { kind: "person", person: principal.id };
		case "worker":
			return { kind: "agent", session: principal.session };
		case "server":
			return { kind: "plugin", plugin: THINGS_PLUGIN };
	}
}
