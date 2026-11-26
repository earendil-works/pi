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
		find: "for (const [thing, kind] of own.links) here.set(thing, linkedHere(kind, giving.get(thing) ?? [], kinds));",
		put: "for (const [thing, kind] of own.links) if (!here.has(thing)) here.set(thing, linkedHere(kind, giving.get(thing) ?? [], kinds));",
	},
	{
		name: "a giving grant below the link counts",
		file: "rules.ts",
		find: "\t\tif (grant.gives) continue;\n\t\tconst thing = grant.thing;\n\t\tconst given = here.get(thing);",
		put: "\t\tconst below = here.get(grant.thing);\n\t\tif (below !== undefined && grant.gives && !own.links.has(grant.thing)) here.set(grant.thing, { ...below, ticks: new Map(below.ticks).set(grant.party, new Set([...(below.ticks.get(grant.party) ?? []), grant.tick])) });\n\t\tif (grant.gives) continue;\n\t\tconst thing = grant.thing;\n\t\tconst given = here.get(thing);",
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
		find: "ticks = new Map(ticks).set(party, new Set([...before].filter((each) => each !== tick)));",
		put: "(before as Set<string>).delete(tick);",
	},
	{
		name: "a withheld tick is withheld from every party",
		file: "rules.ts",
		find: "ticks = new Map(ticks).set(party, new Set([...before].filter((each) => each !== tick)));",
		put: "ticks = new Map([...ticks].map(([each, set]) => [each, new Set([...set].filter((one) => one !== tick))]));",
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
		find: "return access.present.has(agent) ? { parties: [agent, AGENTS], person: undefined } : NOBODY;",
		put: "return { parties: [agent, AGENTS], person: undefined };",
	},
	{
		name: "a tick for the other audience, or one the kind lacks, counts",
		file: "rules.ts",
		find: "if (!open && !isFor(kinds.tickFor(kind, grant.tick), grant.audience)) continue;",
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
		find: "for (const party of counted.parties) {",
		put: "for (const party of counted.person !== undefined && given.ticks.has(counted.person) ? [counted.person] : counted.parties) {",
	},
	{
		name: "a tick withheld from a person is withheld from their own entry only (106)",
		file: "rules.ts",
		find: 'if (!grant.party.startsWith("person/")) return taken;',
		put: "return taken;",
	},
	{
		name: "a tick withheld from a person is not withheld from their answer (106)",
		file: "rules.ts",
		find: "const taken = counted.person === undefined ? undefined : given.takenFromPersons.get(counted.person);",
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
		find: "if (taken?.has(OPEN) === true) return undefined;",
		put: "",
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
		find: "if (!open && !isFor(kinds.tickFor(kind, grant.tick), grant.audience)) continue;",
		put: "if (!open && !isFor(kinds.tickFor(kind, grant.tick), grant.audience)) {\n\t\t\tticks.set(grant.party, ticks.get(grant.party) ?? new Set());\n\t\t\tcontinue;\n\t\t}",
	},
	// ---- the index ----
	{
		name: "the owner flag is ignored",
		file: "access.ts",
		find: 'const owner = caller.kind === "person" && this.#persons.get(caller.person)?.owner === true;',
		put: "const owner = false;",
	},
	{
		name: "a touched workspace's entries are not read again",
		file: "access.ts",
		find: "let entries = await this.#reader.workspace(id, this.#context);",
		put: "let entries = this.#workspaces.get(id)?.entries;",
	},
	{
		name: "a workspace made since it was asked about loads no ancestors",
		file: "access.ts",
		find: 'while (entries !== undefined && entries.parent !== "" && !this.#workspaces.has(entries.parent)) {',
		put: "while (false as boolean) {",
	},
	{
		name: "a touched person is not read again",
		file: "access.ts",
		find: "if (this.#persons.has(id)) read.persons.set(id, await this.#reader.person(id, this.#context));",
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
		find: "if (this.#workspaces.size + this.#persons.size > this.#forgetWhenAbove) this.forgetUnwatched();",
		put: "if (this.#workspaces.size > this.#forgetWhenAbove) this.forgetUnwatched();",
	},
	{
		name: "the kinds changing reads nothing again (no migration)",
		file: "access.ts",
		find: "const read = await this.#reread(new Set(this.#workspaces.keys()), new Set());",
		put: "const read = await this.#reread(new Set(), new Set());",
	},
	{
		name: "the queue keeps the last attachment's answers",
		file: "access.ts",
		find: "this.#queue = run.then(\n\t\t\t() => undefined,\n\t\t\t() => undefined,\n\t\t);",
		put: "this.#queue = run.catch(() => undefined);",
	},
	{
		name: "a commit runs beside the index's loads, not in its queue (Astra 1)",
		file: "access.ts",
		find: "commit<R>(transaction: (touched: Touched) => Promise<R>): Promise<R> {\n\t\treturn this.#run(async () => {",
		put: "commit<R>(transaction: (touched: Touched) => Promise<R>): Promise<R> {\n\t\treturn (async (run: () => Promise<R>) => run())(async () => {",
	},
	{
		name: "an attach that loaded while the index closed registers anyway (Astra 6)",
		file: "access.ts",
		find: "\t\t\t// Closed while it loaded: the close's sweep has passed, nothing may attach behind it.\n\t\t\tif (this.#closed) return undefined;\n",
		put: "",
	},
	{
		name: "a failed re-read keeps what it had in memory (Astra 2)",
		file: "access.ts",
		find: "\t\t\tthis.#recover(error);\n\t\t\treturn undefined;",
		put: "\t\t\treturn undefined;",
	},
	// ---- the store ----
	{
		name: "unlink leaves the link's grants",
		file: "store.ts",
		find: "tx.deleteWhere(this.#t.grants, (g) => and(eq(g.workspace, workspace), eq(g.thing, thing)));",
		put: "",
	},
	{
		name: "unlink of a thing not linked here deletes the rows withheld there (Opus)",
		file: "store.ts",
		find: "\t\tif (link === undefined) return null;\n\t\ttx.deleteWhere(this.#t.grants, (g) => and(eq(g.workspace, workspace), eq(g.thing, thing)));",
		put: "\t\ttx.deleteWhere(this.#t.grants, (g) => and(eq(g.workspace, workspace), eq(g.thing, thing)));\n\t\ttouched.workspaces.add(workspace);\n\t\tif (link === undefined) return null;",
	},
	{
		name: "removeParty does not say which workspace it touched (Opus)",
		file: "store.ts",
		find: "\t\t\t\t\ttx.delete(t.workspaceMembers, { workspace, partyKey: partyKey(party) });\n\t\t\t\t\ttouched.workspaces.add(workspace);",
		put: "\t\t\t\t\ttx.delete(t.workspaceMembers, { workspace, partyKey: partyKey(party) });",
	},
	{
		name: "a kind of one workspace is linked anywhere (Opus)",
		file: "store.ts",
		find: 'if (item.value.workspaces === "one" && elsewhere.items.length > 0) {',
		put: "if (false as boolean) {",
	},
	{
		name: "the maker gets no grant (item 90)",
		file: "store.ts",
		find: "const maker = makerParty(by);",
		put: "const maker = undefined as Party | undefined;",
	},
	{
		name: "a link starts with no default grants",
		file: "store.ts",
		find: "if (ticks !== undefined) this.#give(",
		put: "if (ticks === null) this.#give(",
	},
	{
		name: "a giving grant is written below a link",
		file: "store.ts",
		find: "if (gives === true && link === undefined) {",
		put: "if (gives === true && link === undefined && false) {",
	},
	{
		name: "a tick is given to whom it is not for",
		file: "store.ts",
		find: "if (gives === true && declared !== undefined && !isFor(declared.for, audienceOf(party.kind))) {",
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
		find: "await lifecycle.undo(thing, args.kind);",
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
		find: "if (gives !== undefined && tick !== OPEN && declared === undefined) {",
		put: 'if (gives !== undefined && !tick.startsWith("@") && declared === undefined) {',
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
	// ---- the reader ----
	{
		name: "a grant of an older ticks version is read as it is (item 105)",
		file: "reader.ts",
		find: "if (info === undefined || info.ticksVersion === ticksVersion || tick.startsWith(RESERVED)) {",
		put: "if (true) {",
	},
	{
		name: "a grant that counts for nothing is reported at every read",
		file: "reader.ts",
		find: "if (!reported.has(key)) {",
		put: "if (true) {",
	},
	{
		name: "a migration that throws fails the read instead of refusing the grant (decision 33)",
		file: "reader.ts",
		find: '\t} catch (error) {\n\t\treturn { kind: "refused", why: error };\n\t}',
		put: "\t} finally {\n\t}",
	},
	// ---- kinds ----
	{
		name: "a tick may give a tick that gives of its own (Opus)",
		file: "kind.ts",
		find: "if (!members.has(gives) && !flags.has(gives))",
		put: "if (!members.has(gives) && declaration.ticks[gives] === undefined)",
	},
	// ---- the admission ----
	{
		name: "a caller given nothing is let in with nothing",
		file: "admission.ts",
		find: "if (mine === undefined) return DENIED;",
		put: "if (mine === undefined) return allowed({ granted: [], caller });",
	},
];

/** The plugin's tests every mutation runs. */
const TESTS = ["access", "rules", "admission", "store", "kind", "plans", "server"].map(
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

// Every mutation's text first, so a stale one fails at once.
for (const mutation of MUTATIONS) {
	const text = readFileSync(join(P3, "plugins", "things", mutation.file), "utf8");
	if (text.split(mutation.find).length !== 2)
		throw new Error(`"${mutation.name}": its text is not in ${mutation.file} once`);
}

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
