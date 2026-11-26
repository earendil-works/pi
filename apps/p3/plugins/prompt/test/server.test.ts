// The prompt plugin on the server (`testPlugin`, beside the things plugin's server facet). Instructions: the agents get
// Use by the kind's default grants, a person let in with `@open` gets no flag (Use is for agents); the default text
// before anyone set it; Pi's seeded one; configure sets some settings and keeps the others, also when two run at once;
// hidden in a workspace: denied there; the settings dropped with the thing, the clear safe to run twice. Skills: a set
// lists its folder's skills and follows the folder live, one watcher per set, closed with its last holder; the agent
// reads a skill's text and files, never another set's; a folder outside the Pi's skills root is refused with its
// message; the setting dropped with the thing.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type Contract,
	type Ctx,
	BACKGROUND_CONTEXT as context,
	isChordError,
	type P3Principal,
	type Reference,
	until,
} from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { type TestedPlugin, testPlugin } from "@earendil-works/p3/v1/testing";
import { eventually, within } from "../../../test/until.ts";
import { OneThing, ThingHooks, ThingsStore } from "../../things/contract.server.ts";
import { OPEN, type Source } from "../../things/contract.ts";
import thingsServer from "../../things/server.ts";
import { folderPath, skillsRoot } from "../folder.ts";
import { Instructions, InstructionsKind } from "../instructions-kind.ts";
import { SkillSet } from "../set.ts";
import { Skills, SkillsKind } from "../skills-kind.ts";
import { PromptStore } from "../store.ts";

/** Who sets things up in the tests. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** The session whose agent the tests hold as. */
const SESSION = "s1";

/** The session's worker: the agent. */
const AGENT: P3Principal = { kind: "worker", session: SESSION };

let t: TestedPlugin<P3Principal>;
let things: Reference<typeof ThingsStore>;
let store: Reference<typeof PromptStore>;
let pi: string;
let root: string;

beforeEach(async () => {
	t = await testPlugin(
		fileURLToPath(new URL("../", import.meta.url)),
		{ kind: "server", stubs: [{ name: "@earendil-works/p3-things", facet: thingsServer }] },
		context,
	);
	things = await t.host.get(ThingsStore, {}, context);
	store = await t.host.get(PromptStore, {}, context);
	pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	await things.putParty({ workspace: pi, party: { kind: "agent", session: SESSION }, source: BY }, context);
	root = skillsRoot((await t.host.registry(ServerRuntime, context)).value.dataDir);
});

afterEach(() => t.close(context));

/** Runs `fn` with `principal`'s reference to thing `thing` of `Type` in `workspace`. */
function holding<C extends Contract, T>(
	Type: C,
	thing: string,
	fn: (ref: Reference<C>, ctx: Ctx<P3Principal>) => Promise<T>,
	{ principal = AGENT, workspace = pi }: { principal?: P3Principal; workspace?: string } = {},
) {
	return t.root(
		async (ctx) => fn(await ctx.get(Type, { workspace, thing } as never, { readyTimeout: 500 }), ctx),
		context,
		{ principal },
	);
}

/** Whether `promise` rejects with a ChordError of `code`, carrying the message `key` when given. */
async function refused(promise: Promise<unknown>, code: string, key?: string): Promise<void> {
	await assert.rejects(
		promise,
		(error: unknown) =>
			isChordError(error) &&
			error.code === code &&
			(key === undefined || JSON.stringify(error.details ?? null).includes(`"${key}"`)),
	);
}

/** Kind `kind`'s configure hook, as `Workspace.configure` calls it. */
async function configureOf(kind: string) {
	const hook = (await t.host.registry(ThingHooks, context)).value.get(kind)?.value.configure;
	assert.ok(hook !== undefined);
	return (thing: string, settings: Record<string, unknown>) => t.root((ctx) => hook(thing, settings, ctx), context);
}

describe("instructions", () => {
	/** Makes instructions in Pi, by the test; linked with the kind's default grants. */
	const make = () => things.create({ kind: InstructionsKind.name, name: "Coding", workspace: pi, by: BY }, context);

	it("give the agent Use and the default text before anyone set them; a person with @open gets no flag", async () => {
		const thing = await make();
		await holding(Instructions, thing, async (instructions) => {
			assert.deepEqual([...instructions.granted], ["use"]);
			assert.equal(instructions.language.value, "en");
			assert.match(instructions.text.value, /concise/);
		});
		const person = await things.createPerson({ name: "Ann", madeBy: BY }, context);
		const party = { kind: "person", person } as const;
		await things.putParty({ workspace: pi, party, source: BY }, context);
		await things.setGrants(
			{ source: BY, grants: [{ workspace: pi, thing, party, tick: OPEN, gives: true }] },
			context,
		);
		const ann: P3Principal = { kind: "person", id: person, name: "Ann" };
		await holding(Instructions, thing, async (instructions) => assert.deepEqual([...instructions.granted], []), {
			principal: ann,
		});
	});

	it("are seeded once in Pi with the default text", async () => {
		const seeded = await t.host.get(OneThing, { kind: InstructionsKind.name }, context);
		const seed = await until(seeded.thing, (thing) => thing !== "", within("the seed", context));
		await holding(Instructions, seed, async (instructions) => assert.match(instructions.text.value, /concise/));
	});

	it("configure sets some settings and keeps the others, also when two run at once", async () => {
		const thing = await make();
		const configure = await configureOf(InstructionsKind.name);
		// Two Configures at once, each with one setting: both stay (one merging write each).
		await Promise.all([configure(thing, { language: "de" }), configure(thing, { text: "Sei freundlich." })]);
		await holding(Instructions, thing, async (instructions, ctx) => {
			await until(instructions.text, (text) => text === "Sei freundlich.", within("the new text", ctx));
			assert.equal(instructions.language.value, "de");
		});
	});

	it("are denied in a workspace that hides them", async () => {
		const thing = await make();
		const team = await things.createWorkspace(
			{ kind: "things.workspace", name: "team", parent: pi, by: BY },
			context,
		);
		await things.putParty({ workspace: team, party: { kind: "agent", session: SESSION }, source: BY }, context);
		await holding(Instructions, thing, async (instructions) => assert.ok(instructions.granted.has("use")), {
			workspace: team,
		});
		await things.setSwitch({ workspace: team, item: { kind: "thing", thing }, shown: false }, context);
		await refused(
			holding(Instructions, thing, async () => {}, { workspace: team }),
			"forbidden",
		);
	});

	it("drop their settings with the thing; the clear may run again", async () => {
		const thing = await make();
		await store.configureInstructions({ thing, text: "Gone soon." }, context);
		await things.unlink({ workspace: pi, thing }, context);
		await eventually(
			async () => (await store.instructions.of.page({ thing }, 1, context)).items.length,
			(count) => count === 0,
		);
		await store.clearInstructions({ thing }, context);
	});
});

describe("a set of skills", () => {
	/** Writes skill `name` into `folder` under the root, with `description` and the extra `files`. */
	async function writeSkill(folder: string, name: string, description: string, files: string[] = []): Promise<void> {
		const at = join(root, folder, name);
		await mkdir(at, { recursive: true });
		await writeFile(join(at, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
		for (const file of files) {
			await mkdir(join(at, file, ".."), { recursive: true });
			await writeFile(join(at, file), "echo hi\n");
		}
	}

	/** Makes a set in Pi with folder `folder` (as `configure` writes it); its id. */
	async function setIn(folder: string): Promise<string> {
		const thing = await things.create({ kind: SkillsKind.name, name: folder, workspace: pi, by: BY }, context);
		await store.configureSkills({ thing, folder }, context);
		return thing;
	}

	/** The process's file watch handles (a set's watcher has one per folder it watches). */
	const watchers = () => process.getActiveResourcesInfo().filter((kind) => kind === "FSEventWrap").length;

	it("lists its folder's skills; the agent reads a skill's text and files, never another set's", async () => {
		await writeSkill("coding", "release", "Cut a release", ["scripts/run.sh"]);
		await writeSkill("other", "secret", "Not this set's");
		const thing = await setIn("coding");
		await holding(Skills, thing, async (skills, ctx) => {
			assert.deepEqual([...skills.granted], ["read"]);
			await until(skills.skills, (list) => list.length === 1, within("the folder's skills", ctx));
			assert.deepEqual(skills.skills.value, [{ name: "release", description: "Cut a release" }]);
			assert.equal(skills.folder.value, "coding");
			const read = await skills.read!({ name: "release" }, ctx);
			assert.match(read.text, /description: Cut a release/);
			assert.deepEqual(read.files, ["scripts/run.sh"]);
			await refused(skills.read!({ name: "../other/secret" }, ctx), "invalid");
		});
	});

	it("follows its folder: a skill added appears without a reload", async () => {
		await writeSkill("coding", "release", "Cut a release");
		const thing = await setIn("coding");
		// The set's own object, held throughout: the watcher's, not a new object's first read.
		const set = await t.host.get(SkillSet, { thing }, context);
		await until(set.skills, (list) => list.length === 1, within("the folder's skills", context));
		await writeSkill("coding", "review", "Review a change");
		await until(set.skills, (list) => list.length === 2, within("the new skill", context));
		set.release();
	});

	it("watches its folder once however many hold it, and stops with its last holder", async () => {
		await writeSkill("coding", "release", "Cut a release");
		const thing = await setIn("coding");
		const before = watchers();
		const first = await t.host.get(SkillSet, { thing }, context);
		await until(first.skills, (list) => list.length === 1, within("the folder's skills", context));
		// Node watches a folder tree with one handle per folder on Linux: count them for one holder, then for two.
		const one = watchers();
		assert.ok(one > before);
		const second = await t.host.get(SkillSet, { thing }, context);
		assert.equal(watchers(), one, "a second holder adds no watcher");
		first.release();
		second.release();
		await eventually(watchers, (count) => count === before);
	});

	it("refuses a folder outside the skills root with its message, through configure too", async () => {
		const thing = await setIn("coding");
		const configure = await configureOf(SkillsKind.name);
		await refused(configure(thing, { folder: "../elsewhere" }), "invalid", "outsideRoot");
		await configure(thing, { folder: "family" });
		await holding(Skills, thing, async (skills, ctx) => {
			await until(skills.folder, (folder) => folder === "family", within("the new folder", ctx));
		});
		assert.equal(folderPath(root, "coding"), join(root, "coding"));
		assert.equal(folderPath(root, ""), root);
		for (const outside of ["/etc", "..", "../other", "coding/../../x"]) {
			assert.throws(() => folderPath(root, outside), /outside the Pi's skills root/);
		}
	});

	it("drops its setting with the thing; the clear may run again", async () => {
		const thing = await setIn("coding");
		await things.unlink({ workspace: pi, thing }, context);
		await eventually(
			async () => (await store.skills.of.page({ thing }, 1, context)).items.length,
			(count) => count === 0,
		);
		await store.clearSkills({ thing }, context);
	});
});
