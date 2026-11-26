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
		find: "for (const [thing, kind] of own.links) here.set(thing, linkedHere(thing, kind, own.grants, kinds));",
		put: "for (const [thing, kind] of own.links) if (!here.has(thing)) here.set(thing, linkedHere(thing, kind, own.grants, kinds));",
	},
	{
		name: "a giving grant below the link counts",
		file: "rules.ts",
		find: "if (given === undefined || grant.takenAway.length === 0) continue;",
		put: "if (given !== undefined && grant.gives && !own.links.has(grant.thing)) here.set(grant.thing, { ...given, ticks: new Map(given.ticks).set(grant.party, new Set([...(given.ticks.get(grant.party) ?? []), ...grant.ticks])) });\n\t\tif (given === undefined || grant.takenAway.length === 0) continue;",
	},
	{
		name: "grants of several sources do not add up",
		file: "rules.ts",
		find: "const own = ticks.get(grant.party) ?? new Set<string>();",
		put: "const own = new Set<string>();",
	},
	{
		name: "a take-away changes the set shared with the workspace above",
		file: "rules.ts",
		find: "ticks = new Map(ticks).set(grant.party, new Set([...before].filter((tick) => !grant.takenAway.includes(tick))));",
		put: "for (const tick of grant.takenAway) (before as Set<string>).delete(tick);",
	},
	{
		name: "a take-away removes from every party",
		file: "rules.ts",
		find: "ticks = new Map(ticks).set(grant.party, new Set([...before].filter((tick) => !grant.takenAway.includes(tick))));",
		put: "ticks = new Map([...ticks].map(([party, set]) => [party, new Set([...set].filter((tick) => !grant.takenAway.includes(tick)))]));",
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
		find: "return access.present.has(agent) ? { parties: [agent, AGENTS], self: undefined } : NOBODY;",
		put: "return { parties: [agent, AGENTS], self: undefined };",
	},
	{
		name: "a tick for the other audience, or one the kind lacks, counts",
		file: "rules.ts",
		find: "if (isFor(kinds.tickFor(kind, tick), grant.audience)) own.add(tick);",
		put: "own.add(tick);",
	},
	{
		name: "a giving grant of no tick lets nobody in (R10)",
		file: "rules.ts",
		find: "ticks.set(grant.party, own);",
		put: "if (own.size > 0) ticks.set(grant.party, own);",
	},
	{
		name: "a person's own grant does not replace what groups and everyone give (73)",
		file: "rules.ts",
		find: "if (own !== undefined) return own;",
		put: "",
	},
	{
		name: "a take-away naming a person removes from their own grant only (73)",
		file: "rules.ts",
		find: 'if (!grant.party.startsWith("person/")) return taken;',
		put: "return taken;",
	},
	{
		name: "a people switch hides a person's own party only (73)",
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
		find: "\t\t\t\tif (loaded === undefined) continue;\n\t\t\t\tloaded.entries = await this.#reader.workspace(id, context);",
		put: "\t\t\t\tif (loaded === undefined) continue;",
	},
	{
		name: "a workspace made since it was asked about loads no ancestors",
		file: "access.ts",
		find: "\t\t\t\tawait this.#ensure(id, context);\n",
		put: "",
	},
	{
		name: "a touched person is not read again",
		file: "access.ts",
		find: "if (this.#persons.has(id)) this.#persons.set(id, await this.#reader.person(id, context));",
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
		name: "forgetting drops watched workspaces too",
		file: "access.ts",
		find: "for (const id of this.#workspaces.keys()) if (!keep.has(id)) this.#workspaces.delete(id);",
		put: "for (const id of this.#workspaces.keys()) this.#workspaces.delete(id);",
	},
	{
		name: "the kinds changing reads nothing again (no migration)",
		file: "access.ts",
		find: "\t\t\t\tloaded.entries = await this.#reader.workspace(id, context);\n\t\t\t\tloaded.access = undefined;",
		put: "\t\t\t\tloaded.access = undefined;",
	},
	{
		name: "the queue keeps the last attachment's answers",
		file: "access.ts",
		find: "this.#queue = run.then(\n\t\t\t() => undefined,\n\t\t\t() => undefined,\n\t\t);",
		put: "this.#queue = run.catch(() => undefined);",
	},
	// ---- the store ----
	{
		name: "unlink leaves the link's grants",
		file: "store.ts",
		find: "tx.deleteWhere(this.#t.grants, (g) => and(eq(g.workspace, workspace), eq(g.thing, thing)));",
		put: "",
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
		find: "if (ticks !== undefined)\n",
		put: "if (ticks === null)\n",
	},
	{
		name: "a giving grant is written below a link",
		file: "store.ts",
		find: "if (gives && link === undefined) {",
		put: "if (gives && link === undefined && false) {",
	},
	{
		name: "a tick is given to whom it is not for",
		file: "store.ts",
		find: "if (!isFor(info.ticks.find(({ name }) => name === tick)!.for, audienceOf(party.kind))) {",
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
		find: 'await deleteTold(tx, t.memberships, Memberships, (r) => eq(r.sourceKey, key), touched.persons, "person");',
		put: 'await deleteTold(tx, t.memberships, Memberships, (r) => eq(r.sourceKey, key), new Set(), "person");',
	},
	{
		name: "a grant of an older kind version is read as it is",
		file: "store.ts",
		find: "if (info === undefined || info.version === version) return [{ ...entry, ticks, takenAway }];",
		put: "return [{ ...entry, ticks, takenAway }];",
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
const TESTS = ["access", "rules", "admission", "store", "server"].map((name) => `plugins/things/test/${name}.test.ts`);

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
