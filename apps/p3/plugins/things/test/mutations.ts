// The test of the things plugin's tests (testing.md, rule 9; the prototype's `mutations.ts`, ported): one deliberate
// bug at a time goes into a copy of p3 under /tmp, and the plugin's tests must fail for each. The copy gets its own
// package links: `/tmp/.../node_modules/@earendil-works/p3` is the copy, every other entry the repository's.
// Run from apps/p3 with Node 26:
//   node --conditions=source --disable-warning=ExperimentalWarning plugins/things/test/mutations.ts [word ...]
// (only the mutations whose name contains a word given).

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Left out as equivalent (no test can see it): a removed group's members not told. Every entry and grant naming the
// group goes in the same commit, so a person's stale membership in it names a party present nowhere.

/** One bug: in `file` (of the plugin), the text to find (exactly once) and what to put there instead. */
type Mutation = { readonly name: string; readonly file: string; readonly find: string; readonly put: string };

const MUTATIONS: readonly Mutation[] = [
	// ---- workspaces, round 2 ----
	{
		name: "a maker put in tells no held list",
		file: "store.ts",
		find: "\t\ttouched.members.add(partyKey(party));\n\t\ttx.put(this.#t.workspaceMembers, {",
		put: "\t\ttx.put(this.#t.workspaceMembers, {",
	},
	{
		name: "No access leaves a person present",
		file: "rules.ts",
		find: "\tfor (const party of out) here.delete(party);\n",
		put: "",
	},
	{
		name: "a workspace may be made under a workspace of a kind not registered",
		file: "rules.ts",
		find: 'if (kinds.sortOf(kind) !== "no" && kinds.sortOf(workspace) !== "plain") return false;',
		put: 'if (kinds.sortOf(kind) !== "no" && kinds.sortOf(workspace) === "leaf") return false;',
	},
	{
		name: "WhoMay's aggregate Make cell ignores the ceiling",
		file: "lists.ts",
		find: "if (value === undefined || !makerMay(value, maker) || !mayHoldHere(look, workspace, kinds, made)) return false;",
		put: "",
	},
	{
		name: "an unknown kind's Make tick is refused",
		file: "store.ts",
		find: "forWhom === undefined && !this.#unknownMake(info, own, tick)) {",
		put: "forWhom === undefined) {",
	},
	{
		name: "No access for everyone is accepted",
		file: "store.ts",
		find: 'if (own && tick === OPEN && gives === false && (party.kind === "everyone" || party.kind === "agents")) {',
		put: "if (false) {",
	},
	{
		name: "a presence list is asked after any write",
		file: "access.ts",
		find: 'const workspaces = view.probe.reads === "presence" ? touched.presence : touched.workspaces;',
		put: "const workspaces = touched.workspaces;",
	},
	// ---- workspaces, round 1 ----
	{
		name: "setTick leaves a migrated row of another source",
		file: "store.ts",
		find: "for (const sourceKey of sources) await this.#upgrade(",
		put: "for (const sourceKey of sources.size > 99 ? sources : []) await this.#upgrade(",
	},
	{
		name: "a child under a leaf of an unregistered kind",
		file: "store.ts",
		find: 'if (aboveKind === undefined || this.#kinds().get(aboveKind)?.value.workspace !== "plain") {',
		put: 'if (aboveKind !== undefined && this.#kinds().get(aboveKind)?.value.workspace === "leaf") {',
	},
	{
		name: "a failing list restarts the whole index",
		file: "access.ts",
		find: '\t\t\t\tthis.#probes.delete(view);\n\t\t\t\treportError("things: a list over the access index failed; it attaches again", error, this.#context);',
		put: '\t\t\t\tthis.#recover(error);\n\t\t\t\treturn;\n\t\t\t\treportError("things: a list over the access index failed; it attaches again", error, this.#context);',
	},
	{
		name: "the hook's people shown beats the maker's private",
		file: "store.ts",
		find: "showsPeople: showsPeople !== false && answer?.showsPeople !== false,",
		put: "showsPeople: answer?.showsPeople ?? showsPeople ?? true,",
	},
	{
		name: "No access on a workspace leaves the person in",
		file: "rules.ts",
		find: '\thides.push(...out.filter((party) => party.startsWith("person/")));\n',
		put: "",
	},
	{
		name: "a rename asks every list again",
		file: "access.ts",
		find: "for (const id of touched.things) if (view.things.has(id)) return true;",
		put: "if (touched.things.size > 0) return true;",
	},
	{
		name: "WhoMay's Make cell reads only the party's own row",
		file: "lists.ts",
		find: 'if (made !== "*") return makes.includes(made);',
		put: 'if (made !== "*") return given.ticks.get(key)?.has(tick) === true;',
	},
	// ---- workspaces (ERNDL-1143) ----
	{
		name: "a workspace's own thing comes down to the workspaces below",
		file: "rules.ts",
		find: "\tconst out = takenOut(own);\n\treturn {",
		put: "\tconst out = takenOut(own);\n\tif (above.own !== undefined) return { things: new Map([...thingsHere(above.things, own, kinds), [above.own.id, above.own]]), present: partiesHere(above.present, own, out), hidden: hiddenHere(above.hidden, own, out), own: ownHere(own, kinds) };\n\treturn {",
	},
	{
		name: "a Make tick's kind's makers are no ceiling",
		file: "rules.ts",
		find: '\treturn makers === "anyone" || (makers === "people" && maker === "person");',
		put: "\treturn makers !== undefined;",
	},
	{
		name: "a leaf may hold workspaces",
		file: "rules.ts",
		find: '\tif (kinds.sortOf(kind) !== "no" && kinds.sortOf(workspace) !== "plain") return false;\n',
		put: "",
	},
	{
		name: "a Make tick withheld from a person leaves MAKE_ANY's kinds",
		file: "rules.ts",
		find: "\t\tif (kindOfMakeTick(tick) !== undefined) for (const kind of madeWith(tick, kinds)) makes.delete(kind);\n",
		put: "",
	},
	{
		name: "stacking nearest drops nothing",
		file: "rules.ts",
		find: "\tif (nearest.size === 0) return;",
		put: "\treturn;",
	},
	{
		name: "a removed ancestor's subtree still gives",
		file: "rules.ts",
		find: "\tif (above === GONE) return GONE;\n",
		put: "",
	},
	{
		name: "depth is always 0",
		file: "access.ts",
		find: "\t\t\tconst depth = depths.get(given.at) ?? 0;\n\t\t\tput(",
		put: "\t\t\tconst depth = 0;\n\t\t\tput(",
	},
	{
		name: "the maker of a workspace is not put in (115)",
		file: "store.ts",
		find: "\t\t\tthis.#member(tx, touched, thing, maker, by);\n",
		put: "",
	},
	{
		name: "a leaf's agent is not put in",
		file: "store.ts",
		find: '\t\tif (item.value.workspace === "leaf") {',
		put: '\t\tif (item.value.workspace === "nothing") {',
	},
	{
		name: "a removal clears no subtree",
		file: "removal.ts",
		find: "\t\t\t\tif (below === undefined) break;",
		put: "\t\t\t\tbreak;",
	},
	{
		name: "workspaceGone is never called",
		file: "removal.ts",
		find: "\t\t\t\t\tawait value.workspaceGone?.(workspace, ctx);",
		put: "\t\t\t\t\tvoid value;",
	},
	{
		name: "linking needs no Link where the thing is linked now (R9)",
		file: "workspace-object.ts",
		find: '\tif (principal.kind === "server") return;\n\tconst caller',
		put: "\treturn;\n\tconst caller",
	},
	{
		name: "hide accepts a thing linked here",
		file: "workspace-object.ts",
		find: "if ((await linkedIn(store, hidden, ctx)).includes(workspace)) {",
		put: "if ((await linkedIn(store, hidden, ctx)).includes(workspace) && false) {",
	},
	{
		name: "make does not check makes",
		file: "workspace-object.ts",
		find: "\t\t\t\t\tif (!admitted.makes.includes(kind)) {",
		put: "\t\t\t\t\tif (false) {",
	},
	{
		name: "setTick keeps other sources' rows of the cell",
		file: "store.ts",
		find: "\t\ttx.deleteWhere(this.#t.grants, (g) =>\n\t\t\tand(eq(g.workspace, workspace), eq(g.thing, thing), eq(g.partyKey, key), eq(g.tick, tick)),\n\t\t);",
		put: "\t\ttx.deleteWhere(this.#t.grants, (g) =>\n\t\t\tand(eq(g.workspace, workspace), eq(g.thing, thing), eq(g.partyKey, key), eq(g.tick, tick), eq(g.sourceKey, sourceKey(source))),\n\t\t);",
	},
	{
		name: "the create hook's view is not written",
		file: "store.ts",
		find: '\t\t\t\t\t\t\tview: answer?.view ?? "",\n\t\t\t\t\t\t\t...(defaults',
		put: '\t\t\t\t\t\t\tview: "",\n\t\t\t\t\t\t\t...(defaults',
	},
	{
		name: "a list's hidden things are shown to everyone",
		file: "lists.ts",
		find: '\t\t\tconst hides = look.answer(workspace, workspace, caller)?.ticks.includes("hide") === true;',
		put: "\t\t\tconst hides = true;",
	},
	{
		name: "roots include a workspace whose parent the caller is present in",
		file: "lists.ts",
		find: "\t\t\t\treturn answer !== undefined && !(answer.above ?? []).includes(parent);",
		put: "\t\t\t\treturn answer !== undefined;",
	},
	{
		name: "an origin names a workspace the caller is not present in (96)",
		file: "lists.ts",
		find: '\tif (!above.includes(at)) return { kind: "aboveUnnamed" };\n',
		put: "",
	},
	// ---- the rules ----
	{
		name: "a thing's switch is ignored when the workspace shows things from above",
		file: "rules.ts",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the text of a template in rules.ts
		find: "if (own.switches.get(`thing/${thing}`) ?? own.showsThings) here.set(thing, given);",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the text of a template in rules.ts
		put: "if (own.showsThings || own.switches.get(`thing/${thing}`) === true) here.set(thing, given);",
	},
	{
		name: "a link does not replace what came from above",
		file: "rules.ts",
		find: "for (const [thing, kind] of own.links) here.set(thing, linkedHere(kind, own.id, giving.get(thing) ?? [], kinds));",
		put: "for (const [thing, kind] of own.links) if (!here.has(thing)) here.set(thing, linkedHere(kind, own.id, giving.get(thing) ?? [], kinds));",
	},
	{
		name: "a giving grant below the link counts",
		file: "rules.ts",
		find: "\t\tif (grant.gives || !here.has(grant.thing)) continue;",
		put: "\t\tconst below = here.get(grant.thing);\n\t\tif (below !== undefined && grant.gives && !own.links.has(grant.thing)) here.set(grant.thing, { ...below, ticks: new Map(below.ticks).set(grant.party, new Set([...(below.ticks.get(grant.party) ?? []), grant.tick])) });\n\t\tif (grant.gives || !here.has(grant.thing)) continue;",
	},
	{
		name: "grants of several sources do not add up",
		file: "rules.ts",
		find: "const own = ticks.get(grant.party) ?? new Set<string>();",
		put: "const own = new Set<string>();",
	},
	{
		name: "a withheld tick changes the set shared with the workspace above",
		file: "rules.ts",
		find: "ticks.set(party, new Set([...before].filter((each) => each !== tick)));",
		put: "(before as Set<string>).delete(tick);",
	},
	{
		name: "a withheld tick is withheld from every party",
		file: "rules.ts",
		find: "ticks.set(party, new Set([...before].filter((each) => each !== tick)));",
		put: "for (const [each, set] of [...ticks]) ticks.set(each, new Set([...set].filter((one) => one !== tick)));",
	},
	{
		name: "a party's switch is ignored",
		file: "rules.ts",
		find: "for (const party of above) if (own.switches.get(party) ?? own.showsPeople) here.add(party);",
		put: "for (const party of above) if (own.showsPeople) here.add(party);",
	},
	{
		name: "an outside group makes its members part of everyone",
		file: "rules.ts",
		find: "if (!group.outside) partOfEveryone = true;",
		put: "partOfEveryone = true;",
	},
	{
		name: "an agent that is not present counts as the agents",
		file: "rules.ts",
		find: "return access.present.has(agent) ? { parties: [agent, AGENTS], named: agent } : NOBODY;",
		put: "return { parties: [agent, AGENTS], named: agent };",
	},
	{
		name: "a tick for the other audience, or one the kind lacks, counts",
		file: "rules.ts",
		find: "if (!open && !isFor(forWhom, grant.audience)) continue;",
		put: "",
	},
	{
		name: "a giving grant of no tick lets nobody in (R10)",
		file: "rules.ts",
		find: "ticks.set(grant.party, own);",
		put: "if (own.size > 0) ticks.set(grant.party, own);",
	},
	{
		name: "a person's own grant replaces what groups and everyone give (precedence, gone with item 106)",
		file: "rules.ts",
		find: "let union: Set<string> | undefined;\n\tfor (const party of counted.parties) {",
		put: "let union: Set<string> | undefined;\n\tfor (const party of counted.named !== undefined && given.ticks.has(counted.named) ? [counted.named] : counted.parties) {",
	},
	{
		name: "a tick withheld from a person is withheld from their own entry only (106)",
		file: "rules.ts",
		find: 'return party.startsWith("person/") || party.startsWith("agent/");',
		put: 'return party.startsWith("agent/");',
	},
	{
		name: "a tick withheld from one session's agent is withheld from its own entry only (106)",
		file: "rules.ts",
		find: 'return party.startsWith("person/") || party.startsWith("agent/");',
		put: 'return party.startsWith("person/");',
	},
	{
		name: "a tick withheld from a person is not withheld from their answer (106)",
		file: "rules.ts",
		find: "const taken = counted.named === undefined ? undefined : given.takenFromNamed.get(counted.named);",
		put: "const taken = undefined as ReadonlySet<string> | undefined;",
	},
	{
		name: "a people switch hides a person's own party only (106)",
		file: "rules.ts",
		find: "if (access.hidden.has(person)) return NOBODY;",
		put: "",
	},
	{
		name: "a person hidden above stays hidden where they are put in",
		file: "rules.ts",
		find: "for (const person of put) hidden.delete(person);",
		put: "",
	},
	{
		name: "`OPEN` withheld from a person keeps them out only by their own entry (113)",
		file: "rules.ts",
		find: "given.takenFromNamed.get(counted.named);\n\tif (taken?.has(OPEN) === true) return undefined;",
		put: "given.takenFromNamed.get(counted.named);",
	},
	{
		name: "`OPEN` withheld lets the party in still (113)",
		file: "rules.ts",
		find: "if (before !== undefined && tick === OPEN) {",
		put: "if (false as boolean) {",
	},
	{
		name: "`OPEN` given lets nobody in (113)",
		file: "rules.ts",
		find: "const open = grant.tick === OPEN;",
		put: "const open = false;",
	},
	{
		name: "a row of a tick that counts for nothing lets its party in (113)",
		file: "rules.ts",
		find: "if (!open && !isFor(forWhom, grant.audience)) continue;",
		put: "if (!open && !isFor(forWhom, grant.audience)) {\n\t\t\tticks.set(grant.party, ticks.get(grant.party) ?? new Set());\n\t\t\tcontinue;\n\t\t}",
	},
	// ---- the index ----
	{
		name: "the owner flag is ignored",
		file: "access.ts",
		find: 'return caller.kind === "server" || (caller.kind === "person" && this.#persons.get(caller.person)?.owner === true);',
		put: 'return caller.kind === "server";',
	},
	{
		name: "a touched workspace's entries are not read again",
		file: "access.ts",
		find: "loaded.entries = await this.#reader.workspace(id, this.#context);",
		put: "",
	},
	{
		name: "a workspace made since it was asked about loads no ancestors",
		file: "access.ts",
		find: "\t\t\t\tawait this.#ensure(id, this.#context);\n",
		put: "",
	},
	{
		name: "a touched person is not read again",
		file: "access.ts",
		find: "if (this.#persons.has(id)) this.#persons.set(id, await this.#reader.person(id, this.#context));",
		put: "",
	},
	{
		name: "only the touched workspace's result is forgotten, not those below",
		file: "access.ts",
		find: "if (!this.#isAtOrBelow(id, touched.workspaces)) continue;",
		put: "if (!touched.workspaces.has(id)) continue;",
	},
	{
		name: "a change forgets the result of every loaded workspace",
		file: "access.ts",
		find: "if (!this.#isAtOrBelow(id, touched.workspaces)) continue;",
		put: "if (touched.workspaces.size === 0) continue;",
	},
	{
		name: "the views of a touched person are not asked again",
		file: "access.ts",
		find: "for (const id of touched.persons) for (const view of this.#viewsOf.get(id) ?? []) asked.add(view);",
		put: "",
	},
	{
		name: "a workspace's entries are read again for every question",
		file: "access.ts",
		find: "\t\t\tif (loaded === undefined) {\n\t\t\t\tloaded = { entries",
		put: "\t\t\tif (loaded === undefined || true) {\n\t\t\t\tloaded = { entries",
	},
	{
		name: "a workspace's result is computed again for every question",
		file: "access.ts",
		find: "if (loaded.access !== undefined) return loaded.access;",
		put: "",
	},
	{
		name: "a view tells the answers it already told",
		file: "access.ts",
		find: "if (answers === view.last) continue;",
		put: "",
	},
	{
		name: "a view detached by another's observer is still told",
		file: "access.ts",
		find: "if (!this.#views.has(view)) continue;",
		put: "",
	},
	{
		name: "forgetting drops watched workspaces too",
		file: "access.ts",
		find: "for (const id of this.#workspaces.keys()) if (!keep.has(id)) this.#workspaces.delete(id);",
		put: "for (const id of this.#workspaces.keys()) this.#workspaces.delete(id);",
	},
	{
		name: "unwatched persons do not count against the budget",
		file: "access.ts",
		find: "const loaded = this.#workspaces.size + this.#persons.size;",
		put: "const loaded = this.#workspaces.size;",
	},
	{
		name: "the kinds changing reads nothing again (no migration)",
		file: "access.ts",
		find: "if (!(await this.#reread(new Set(this.#workspaces.keys()), new Set()))) return;",
		put: "if (!(await this.#reread(new Set(), new Set()))) return;",
	},
	{
		name: "the queue keeps the last attachment's answers",
		file: "access.ts",
		find: "this.#queue = run.then(\n\t\t\t() => undefined,\n\t\t\t() => undefined,\n\t\t);",
		put: "this.#queue = run.catch(() => undefined);",
	},
	{
		name: "a commit runs beside the index's loads, not in its queue",
		file: "access.ts",
		find: "\t\tconst queued = performance.now();\n\t\treturn this.#run(async () => {",
		put: "\t\tconst queued = performance.now();\n\t\treturn (async (run: () => Promise<R>) => run())(async () => {",
	},
	{
		name: "an attach that loaded while the index closed registers anyway",
		file: "access.ts",
		find: "\t\t\t// Closed while it loaded: the close's sweep has passed, nothing may attach behind it.\n\t\t\tif (this.#closed) return undefined;\n",
		put: "",
	},
	{
		name: "a failed re-read keeps what it had in memory",
		file: "access.ts",
		find: "\t\t\tthis.#recover(error);\n\t\t\treturn false;",
		put: "\t\t\treturn false;",
	},
	{
		name: "a reloaded kind's snapshot is installed outside the index's queue",
		file: "store.ts",
		find: "\t\t\tif (index === undefined) install();\n\t\t\telse await index.kindsChanged(install);",
		put: "\t\t\tinstall();\n\t\t\tif (index !== undefined) await index.kindsChanged(() => {});",
	},
	{
		name: "a burst of released views keeps its persons",
		file: "access.ts",
		find: " || this.#views.size * 2 < this.#viewsAtSweep",
		put: "",
	},
	{
		name: "an ending store attempt's index still takes attaches",
		file: "access.ts",
		find: "return !this.#closed && this.#context.abortSignal?.aborted !== true;",
		put: "return !this.#closed;",
	},
	// ---- the store ----
	{
		name: "unlink leaves the link's grants",
		file: "store.ts",
		find: "tx.deleteWhere(this.#t.grants, (g) => and(eq(g.workspace, workspace), eq(g.thing, thing)));",
		put: "",
	},
	{
		name: "unlink of a thing not linked here deletes the rows withheld there",
		file: "store.ts",
		find: "\t\tif (link === undefined) return null;\n\t\ttx.deleteWhere(this.#t.grants, (g) => and(eq(g.workspace, workspace), eq(g.thing, thing)));",
		put: "\t\ttx.deleteWhere(this.#t.grants, (g) => and(eq(g.workspace, workspace), eq(g.thing, thing)));\n\t\ttouched.workspaces.add(workspace);\n\t\tif (link === undefined) return null;",
	},
	{
		name: "removeParty does not say which workspace it touched",
		file: "store.ts",
		find: "\t\t\t\t\ttx.delete(t.workspaceMembers, { workspace, partyKey: partyKey(party) });\n\t\t\t\t\ttouched.workspaces.add(workspace);",
		put: "\t\t\t\t\ttx.delete(t.workspaceMembers, { workspace, partyKey: partyKey(party) });",
	},
	{
		name: "a kind of one workspace is linked anywhere",
		file: "store.ts",
		find: 'if (item.value.workspaces === "one" && elsewhere.items.length > 0) {',
		put: "if (false as boolean) {",
	},
	{
		name: "the maker gets no grant (item 90)",
		file: "store.ts",
		find: "const maker = makerParty(by);\n\t\tif (maker === undefined) return;",
		put: "const maker = undefined as Party | undefined;\n\t\tif (maker === undefined) return;",
	},
	{
		name: "a link starts with no default grants",
		file: "store.ts",
		find: "for (const tick of written) {",
		put: "for (const tick of written.slice(written.length)) {",
	},
	{
		name: "a giving grant is written below a link",
		file: "store.ts",
		find: "if (gives === true && link === undefined && !own) {",
		put: "if (gives === true && link === undefined && false) {",
	},
	{
		name: "a tick is given to whom it is not for",
		file: "store.ts",
		find: "if (gives === true && forWhom !== undefined && !isFor(forWhom, audienceOf(party.kind))) {",
		put: "if (false) {",
	},
	{
		name: "deleteEverythingFrom does not say which workspaces its grants were in",
		file: "store.ts",
		find: 'await deleteTold(tx, t.grants, Grants, (r) => eq(r.sourceKey, key), touched.workspaces, "workspace");',
		put: 'await deleteTold(tx, t.grants, Grants, (r) => eq(r.sourceKey, key), new Set(), "workspace");',
	},
	{
		name: "deleteEverythingFrom does not say which persons it touched",
		file: "store.ts",
		find: 'await deleteTold(tx, t.groupMembers, GroupMembers, (r) => eq(r.sourceKey, key), touched.persons, "person");',
		put: 'await deleteTold(tx, t.groupMembers, GroupMembers, (r) => eq(r.sourceKey, key), new Set(), "person");',
	},
	{
		name: "a commit that fails after the create hook leaves what the hook made (item 34)",
		file: "store.ts",
		find: "if (create !== undefined) await lifecycle.undo(thing, args.kind, ctx);",
		put: "",
	},
	{
		name: "an empty default grant lets nobody in (no `OPEN` row, 113)",
		file: "store.ts",
		find: "for (const tick of ticks.length === 0 ? [OPEN] : ticks) {",
		put: "for (const tick of ticks) {",
	},
	{
		name: "a reserved tick other than `OPEN` is written (113)",
		file: "store.ts",
		find: "if (gives !== undefined && tick !== OPEN && forWhom === undefined && !this.#unknownMake(info, own, tick)) {",
		put: 'if (gives !== undefined && !tick.startsWith("@") && forWhom === undefined) {',
	},
	{
		name: "a plugin's one thing is made again by every ensure",
		file: "store.ts",
		find: "return (await tx.page(this.#t.things, mine, 1)).items[0]?.thing;",
		put: "return undefined;",
	},
	{
		name: "a seeded thing that does not stand keeps its hook's work",
		file: "store.ts",
		find: "if (made !== thing && create !== undefined) await lifecycle.undo(thing, args.kind, ctx);",
		put: "",
	},
	{
		name: "a kind's `one` is not seeded",
		file: "store.ts",
		find: "if (value.one === undefined || !kinds.value.has(kind)) continue;",
		put: "continue;",
	},
	{
		name: "the create hook is not told who makes the thing",
		file: "store.ts",
		find: "create?.({ thing, input: args.input, by: args.by, workspace: args.workspace }, ctx)",
		put: 'create?.({ thing, input: args.input, by: { kind: "plugin", plugin: "?" }, workspace: args.workspace }, ctx)',
	},
	{
		name: "a write of a party's rows leaves their older rows as they are",
		file: "store.ts",
		find: "await this.#upgrade(tx, key, info);",
		put: "",
	},
	{
		name: "a retired seeded thing is not made again",
		file: "store.ts",
		find: "if (hooks.value.get(kind)?.value.one !== undefined && live !== undefined) {",
		put: "if (false) {",
	},
	{
		name: "a given output wins over a withheld one at one tick on write-back",
		file: "store.ts",
		find: "if (before === undefined || (before.gives && !first.gives))",
		put: "if (before === undefined || (!before.gives && first.gives))",
	},
	{
		name: "a row at the version now stays under a migrated withheld one on write-back",
		file: "store.ts",
		find: "if (there !== undefined && (row.gives || !there.gives)) continue;",
		put: "if (there !== undefined) continue;",
	},
	{
		name: "a group of reserved ticks only goes through the migration on write-back",
		file: "store.ts",
		find: "now = named.length === 0 ? [] : ticksNow(info, named, first.ticksVersion);",
		put: "now = ticksNow(info, named, first.ticksVersion);",
	},
	{
		name: "each older group's rows are deleted and put in turn, not all deleted first",
		file: "store.ts",
		find: "\t\t\t\t\toutputs.set(tick, { ...first, tick, ticksVersion: info.ticksVersion });",
		put: "\t\t\t\t\ttx.put(this.#t.grants, { ...first, tick, ticksVersion: info.ticksVersion });",
	},
	{
		name: "a missing create input is not checked against the kind's schema",
		file: "store.ts",
		find: "const failed = checkValue(schema, args.input);",
		put: "const failed = args.input === undefined ? undefined : checkValue(schema, args.input);",
	},
	{
		name: "create's input is checked against the index's kinds, not the hook's registry",
		file: "store.ts",
		find: "const schema = kinds.value.get(args.kind)?.value.input;",
		put: "const schema = kindTable().get(args.kind)?.value.input;",
	},
	{
		name: "OneThing names a plugin-made thing of a kind that asks for none",
		file: "one.ts",
		find: 'table.get(kind)?.value.one === undefined ? "" : (page.rows[0]?.thing ?? "")',
		put: 'page.rows[0]?.thing ?? ""',
	},
	{
		name: "the start's seed runs before the lifecycle serves",
		file: "store.ts",
		find: "await Promise.all([lifecycle.serve(ctx), removal.serve(ctx), seed(ctx)]);",
		put: "await seed(ctx);\n\t\t\tawait Promise.all([lifecycle.serve(ctx), removal.serve(ctx)]);",
	},
	{
		name: "a withheld row of a tick the kind lacks is written",
		file: "store.ts",
		find: "if (gives !== undefined && tick !== OPEN && forWhom === undefined && !this.#unknownMake(info, own, tick)) {",
		put: "if (gives === true && tick !== OPEN && forWhom === undefined && !this.#unknownMake(info, own, tick)) {",
	},
	// ---- the lifecycle ----
	{
		name: "a failed delete hook is tried again only at the next start",
		file: "lifecycle.ts",
		find: "\t\t\treturn false;",
		put: "\t\t\treturn true;",
	},
	{
		name: "a delete whose kind no plugin contributes is taken as done",
		file: "lifecycle.ts",
		find: "if (entry === undefined) return true;",
		put: "if (entry === undefined) {\n\t\t\tawait this.#store.write(async (tx) => {\n\t\t\t\ttx.delete(this.#store.table, { thing });\n\t\t\t\treturn null;\n\t\t\t}, ctx);\n\t\t\treturn true;\n\t\t}",
	},
	{
		name: "a create's cleanup is not kept when its kind's plugin went",
		file: "lifecycle.ts",
		find: "\t\t\t\ttx.put(this.#store.table, { thing, kind });\n\t\t\t\treturn null;\n\t\t\t}, own);",
		put: "\t\t\t\treturn null;\n\t\t\t}, own);\n\t\t\tawait this.#store.hooks().get(kind)?.value.delete?.(thing, own);",
	},
	{
		name: "one thing's delete is tried twice at once",
		file: "lifecycle.ts",
		find: "\t\tif (this.#retiring.has(thing)) return;\n",
		put: "",
	},
	{
		name: "an ending store attempt does not wait for its delete hooks",
		file: "lifecycle.ts",
		find: "\t\tawait Promise.all(this.#retiring.values());\n",
		put: "",
	},
	// ---- the reader ----
	{
		name: "a row of an older ticks version is read as it is (item 105)",
		file: "reader.ts",
		find: "if (info === undefined || grant.ticksVersion === info.ticksVersion || grant.tick.startsWith(RESERVED)) {",
		put: "if (true as boolean) {",
	},
	{
		name: "a grant that counts for nothing is reported at every read",
		file: "reader.ts",
		find: "if (!reported.has(report)) {",
		put: "if (true as boolean) {",
	},
	{
		name: "a migration that throws fails the read instead of refusing the grant (decision 33)",
		file: "reader.ts",
		find: "\t\t} catch (error) {\n\t\t\tconst report",
		put: '\t\t} catch (error) {\n\t\t\tif (!String(error).includes("ticks version")) throw error;\n\t\t\tconst report',
	},
	{
		name: "a withheld row its kind cannot read withholds nothing",
		file: "reader.ts",
		find: "\t\t\tif (!first.gives) for (const tick of kinds.ticksOf(first.kind)) entries.push(entryOf(first, tick));\n",
		put: "",
	},
	{
		name: "`OPEN` rows go through the migration",
		file: "reader.ts",
		find: " || grant.tick.startsWith(RESERVED)) {",
		put: ") {",
	},
	{
		name: "older rows migrate one by one, not as one list",
		file: "reader.ts",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the text of a template in reader.ts
		find: "\t\tconst key = `${grant.thing}\\n${partyKey(grant.party)}\\n${sourceKey(grant.source)}\\n${grant.gives}\\n${grant.ticksVersion}`;",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the text of a template in reader.ts
		put: "\t\tconst key = `${grant.thing}\\n${partyKey(grant.party)}\\n${sourceKey(grant.source)}\\n${grant.gives}\\n${grant.ticksVersion}\\n${grant.tick}`;",
	},
	// ---- kinds ----
	{
		name: "a tick may give a tick that gives of its own",
		file: "kind.ts",
		find: "if (!members.has(gives) && !flags.has(gives))",
		put: "if (!members.has(gives) && declaration.ticks[gives] === undefined)",
	},
	{
		name: "a ticks version above 1 without migrateTicks is accepted",
		file: "kind.ts",
		find: "\tif ((declaration.ticksVersion ?? 1) > 1 && declaration.migrateTicks === undefined) {",
		put: "\tif (false as boolean) {",
	},
	// ---- the admission ----
	{
		name: "a caller given nothing is let in with nothing",
		file: "admission.ts",
		find: "if (mine === undefined || mine.kind !== Kind.name) return DENIED;",
		put: "if (mine === undefined) return allow({ granted: [], caller });",
	},
	{
		name: "a thing of another kind is admitted by its ticks' names",
		file: "admission.ts",
		find: "if (mine === undefined || mine.kind !== Kind.name) return DENIED;",
		put: "if (mine === undefined) return DENIED;",
	},
	{
		name: "an answer read at another ticks version is expanded as it is",
		file: "admission.ts",
		find: "if (mine.ticksVersion !== Kind.info.ticksVersion) return CATCHING_UP;",
		put: "",
	},
];

/** The plugin's tests every mutation runs. */
const TESTS = ["access", "rules", "admission", "store", "kind", "plans", "server", "migration", "workspaces"].map(
	(name) => `plugins/things/test/${name}.test.ts`,
);

const P3 = resolve(import.meta.dirname, "../../..");
const REPOSITORY = resolve(P3, "../..");

/** A copy of p3 in a directory of its own, linked to the repository's packages, with `mutation` applied. */
function copyWith(mutation: Mutation): string {
	const root = mkdtempSync(join(tmpdir(), "p3-things-mutation-"));
	const p3 = join(root, "apps", "p3");
	cpSync(P3, p3, { recursive: true, filter: (path) => !path.includes("/.git") });
	const modules = join(root, "node_modules");
	mkdirSync(join(modules, "@earendil-works"), { recursive: true });
	for (const entry of readdirSync(join(REPOSITORY, "node_modules"))) {
		if (entry !== "@earendil-works") symlinkSync(join(REPOSITORY, "node_modules", entry), join(modules, entry));
	}
	for (const entry of readdirSync(join(REPOSITORY, "node_modules", "@earendil-works"))) {
		const target = entry === "p3" ? p3 : join(REPOSITORY, "node_modules", "@earendil-works", entry);
		symlinkSync(target, join(modules, "@earendil-works", entry));
	}
	const file = join(p3, "plugins", "things", mutation.file);
	const original = readFileSync(file, "utf8");
	if (original.split(mutation.find).length !== 2)
		throw new Error(`"${mutation.name}": its text is not in ${mutation.file} once`);
	writeFileSync(
		file,
		original.replace(mutation.find, () => mutation.put),
	);
	return root;
}

/** The test files that fail with `mutation` (`["a hang"]` when they never end). */
function failing(mutation: Mutation): Promise<string[]> {
	const root = copyWith(mutation);
	const args = [
		"--conditions=source",
		"--disable-warning=ExperimentalWarning",
		"--test",
		"--test-reporter=spec",
		...TESTS,
	];
	return new Promise((done) => {
		const child = spawn(process.execPath, args, { cwd: join(root, "apps", "p3"), detached: true });
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		const tooLong = setTimeout(() => process.kill(-(child.pid as number), "SIGKILL"), 300_000);
		child.on("close", (code) => {
			clearTimeout(tooLong);
			rmSync(root, { recursive: true, force: true });
			if (code === null) return done(["a hang"]);
			if (process.env.P3_MUTATION_OUTPUT) console.log(output);
			const files = TESTS.filter((test) => output.includes(`test at ${test}`));
			done(code === 0 ? [] : files.length > 0 ? files.map((file) => file.split("/").at(-1)!) : ["(failed)"]);
		});
	});
}

// Every mutation's text first, so a stale one fails at once (all of them named).
const stale = MUTATIONS.filter(
	(mutation) => readFileSync(join(P3, "plugins", "things", mutation.file), "utf8").split(mutation.find).length !== 2,
);
if (stale.length > 0)
	throw new Error(stale.map((mutation) => `"${mutation.name}": its text is not in ${mutation.file} once`).join("\n"));

const words = process.argv.slice(2);
const chosen = MUTATIONS.filter((mutation) => words.length === 0 || words.some((word) => mutation.name.includes(word)));
const waiting = [...chosen];
const outcomes = new Map<Mutation, string[]>();
const worker = async (): Promise<void> => {
	for (let next = waiting.shift(); next !== undefined; next = waiting.shift()) outcomes.set(next, await failing(next));
};
await Promise.all(Array.from({ length: 8 }, worker));
console.log("| Bug | Caught by |\n| --- | --- |");
for (const mutation of chosen)
	console.log(`| ${mutation.name} | ${outcomes.get(mutation)!.join(", ") || "**MISSED**"} |`);
const missed = chosen.filter((mutation) => outcomes.get(mutation)!.length === 0);
console.log(`\n${chosen.length - missed.length} of ${chosen.length} caught.`);
process.exitCode = missed.length === 0 ? 0 : 1;
