// The prompt plugin on the server (`kindServer`: its server facet beside the things plugin's), for each of its kinds.
// Instructions: registered by the plugin, made by people; the session's agent gets Use, the owner nothing (Use is the
// agents'), a person put in is not let in, with `@open` let in with no flag; Pi's seeded one has the default text, a
// new one no text; configure sets some settings and keeps the others, also when two run at once; hidden in a
// workspace: denied there, live; the settings dropped with the thing, its delete safe to run again; a holder's text
// followed across a reload of the plugin; a released hold collected. A set of skills: registered, made by people; the
// agent gets `read` (Use); it lists its folder's skills and reads a skill's text and files, never another set's;
// configure refuses a folder outside the skills root with its message and follows a new folder live; hidden: denied;
// its setting dropped with the thing; one shared read however many hold it, released with its last holder; a new
// skill seen across a reload; a released hold collected.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type Contract, BACKGROUND_CONTEXT as context, type P3Principal, until } from "@earendil-works/p3/v1";
import { collected, eventually, within } from "../../../test/until.ts";
import { OneThing, ThingHooks } from "../../things/contract.server.ts";
import { OPEN } from "../../things/contract.ts";
import { ThingKinds } from "../../things/kind.ts";
import { BY, refused } from "../../things/test/kind-server.ts";
import { type Instructions, InstructionsKind } from "../instructions-kind.ts";
import { type Skills, SkillsKind } from "../skills-kind.ts";
import { PromptStore } from "../store.ts";
import { type PromptServer, promptKind } from "./prompt-server.ts";

/** The session's agent of workspace `s1`. */
const AGENT: P3Principal = { kind: "worker", session: "s1" };

/** Kind `kind`'s configure hook on `n`, as `Workspace.configure` calls it. */
async function configureOf<C extends Contract>(n: PromptServer<C>, kind: string) {
	const hook = (await n.host.registry(ThingHooks, context)).value.get(kind)?.value.configure;
	assert.ok(hook !== undefined);
	return (thing: string, settings: Record<string, unknown>) =>
		n.host.root((ctx) => hook(thing, settings, ctx), context);
}

/** Kind `kind`'s delete hook on `n`, as the things plugin runs it (again after a failure or a restart). */
async function deleteOf<C extends Contract>(n: PromptServer<C>, kind: string) {
	const hook = (await n.host.registry(ThingHooks, context)).value.get(kind)?.value.delete;
	assert.ok(hook !== undefined);
	return (thing: string) => n.host.root((ctx) => hook(thing, ctx), context);
}

describe("instructions", () => {
	let n: PromptServer<typeof Instructions>;
	let s1: string;

	beforeEach(async () => {
		n = await promptKind(InstructionsKind, context);
		s1 = await n.workspace("s1");
	});

	afterEach(() => n.close());

	it("are registered by the prompt plugin, made by people", async () => {
		const entry = (await n.host.registry(ThingKinds, context)).value.get(InstructionsKind.name);
		assert.deepEqual([entry?.plugin, entry?.value.makers], ["@earendil-works/p3-prompt", "people"]);
	});

	it("give the agent Use and the owner nothing; a person put in is let in only with @open, with no flag", async () => {
		const thing = await n.thingIn(n.pi);
		assert.deepEqual(await n.granted(AGENT, s1, thing), ["use"]);
		const owner = await n.things.createPerson({ name: "Olga", madeBy: BY }, context);
		await n.things.setOwner({ person: owner, owner: true }, context);
		assert.deepEqual(await n.granted({ kind: "person", id: owner, name: "Olga" }, n.pi, thing), []);
		const ann = await n.person("Ann");
		await refused(n.granted(ann, n.pi, thing));
		await n.tick(n.pi, thing, { kind: "person", person: ann.id }, OPEN, true);
		assert.deepEqual(await n.granted(ann, n.pi, thing), []);
	});

	it("are seeded once in Pi with the default text; new ones have no text, in English", async () => {
		const seeded = await n.host.get(OneThing, { kind: InstructionsKind.name }, context);
		const seed = await until(seeded.thing, (thing) => thing !== "", within("the seed", context));
		seeded.release();
		await n.holding(AGENT, s1, seed, async (instructions, ctx) => {
			await until(instructions.text, (text) => /concise/.test(text), within("the seed's text", ctx));
		});
		const made = await n.thingIn(n.pi);
		await n.holding(AGENT, s1, made, async (instructions) => {
			assert.deepEqual([instructions.text.value, instructions.language.value], ["", "en"]);
		});
	});

	it("configure sets some settings and keeps the others, also when two run at once", async () => {
		const thing = await n.thingIn(n.pi);
		const configure = await configureOf(n, InstructionsKind.name);
		// Two Configures at once, each with one setting: both stay (one merging write each).
		await Promise.all([configure(thing, { language: "de" }), configure(thing, { text: "Sei freundlich." })]);
		await n.holding(AGENT, s1, thing, async (instructions, ctx) => {
			await until(instructions.text, (text) => text === "Sei freundlich.", within("the new text", ctx));
			assert.equal(instructions.language.value, "de");
		});
	});

	it("are denied in a workspace that hides them, live, and still given where they are shown", async () => {
		const thing = await n.thingIn(n.pi);
		const s2 = await n.workspace("s2");
		await n.holding(AGENT, s1, thing, async (instructions, ctx) => {
			await n.things.setSwitch({ workspace: s1, item: { kind: "thing", thing }, shown: false }, context);
			await until(
				instructions.state,
				(state) => state.kind === "failed" && state.cause.kind === "denied",
				within("hidden in s1", ctx),
			);
		});
		assert.deepEqual(await n.granted({ kind: "worker", session: "s2" }, s2, thing), ["use"]);
	});

	it("drop their settings with the thing; the delete may run again", async () => {
		const thing = await n.thingIn(n.pi);
		const store = await n.host.get(PromptStore, {}, context);
		await store.configureInstructions({ thing, text: "Gone soon." }, context);
		await n.things.unlink({ workspace: n.pi, thing }, context);
		await eventually(
			async () => (await store.instructions.of.page({ thing }, 1, context)).items.length,
			(count) => count === 0,
		);
		await (await deleteOf(n, InstructionsKind.name))(thing);
		store.release();
	});

	it("keep a holder's text across a reload of the plugin, and follow a configure after it", async () => {
		const thing = await n.thingIn(n.pi);
		const configure = await configureOf(n, InstructionsKind.name);
		await configure(thing, { text: "Before." });
		await n.holding(AGENT, s1, thing, async (instructions, ctx) => {
			await until(instructions.text, (text) => text === "Before.", within("the text", ctx));
			await n.reload();
			await (await configureOf(n, InstructionsKind.name))(thing, { text: "After." });
			await until(instructions.text, (text) => text === "After.", within("the text after the reload", ctx));
		});
	});

	it("are collected once released", async () => {
		const thing = await n.thingIn(n.pi);
		const refs: WeakRef<object>[] = [];
		await n.holding(AGENT, s1, thing, async (instructions) => {
			refs.push(new WeakRef(instructions), new WeakRef(instructions.text));
		});
		assert.ok(await collected(refs));
	});
});

describe("a set of skills", () => {
	let n: PromptServer<typeof Skills>;
	let s1: string;

	beforeEach(async () => {
		n = await promptKind(SkillsKind, context);
		s1 = await n.workspace("s1");
	});

	afterEach(() => n.close());

	/** Writes skill `name` into `folder` under the root, with `description` and the extra `files`. */
	async function writeSkill(folder: string, name: string, description: string, files: string[] = []): Promise<void> {
		const at = join(n.root, folder, name);
		await mkdir(at, { recursive: true });
		await writeFile(join(at, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
		for (const file of files) {
			await mkdir(join(at, file, ".."), { recursive: true });
			await writeFile(join(at, file), "echo hi\n");
		}
	}

	/** Makes a set in Pi with folder `folder`, configured as Configure does; its id. */
	async function setIn(folder: string): Promise<string> {
		const thing = await n.thingIn(n.pi, folder);
		await (await configureOf(n, SkillsKind.name))(thing, { folder });
		return thing;
	}

	it("is registered by the prompt plugin, made by people", async () => {
		const entry = (await n.host.registry(ThingKinds, context)).value.get(SkillsKind.name);
		assert.deepEqual([entry?.plugin, entry?.value.makers], ["@earendil-works/p3-prompt", "people"]);
	});

	it("lists its folder's skills; the agent reads a skill's text and files, never another set's", async () => {
		await writeSkill("coding", "release", "Cut a release", ["scripts/run.sh"]);
		await writeSkill("other", "secret", "Not this set's");
		const thing = await setIn("coding");
		await n.holding(AGENT, s1, thing, async (skills, ctx) => {
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

	it("refuses a folder outside the skills root with its message, and follows a new folder live", async () => {
		await writeSkill("family", "recipes", "Cook");
		const thing = await setIn("coding");
		const configure = await configureOf(n, SkillsKind.name);
		await refused(configure(thing, { folder: "../elsewhere" }), "invalid", "outsideRoot");
		await n.holding(AGENT, s1, thing, async (skills, ctx) => {
			await configure(thing, { folder: "family" });
			await until(skills.folder, (folder) => folder === "family", within("the new folder", ctx));
			await until(skills.skills, (list) => list[0]?.name === "recipes", within("its skills", ctx));
		});
	});

	it("is denied in a workspace that hides it, live", async () => {
		const thing = await setIn("coding");
		await n.holding(AGENT, s1, thing, async (skills, ctx) => {
			await n.things.setSwitch({ workspace: s1, item: { kind: "thing", thing }, shown: false }, context);
			await until(
				skills.state,
				(state) => state.kind === "failed" && state.cause.kind === "denied",
				within("hidden in s1", ctx),
			);
		});
	});

	it("drops its setting with the thing; the delete may run again", async () => {
		const thing = await setIn("coding");
		const store = await n.host.get(PromptStore, {}, context);
		await n.things.unlink({ workspace: n.pi, thing }, context);
		await eventually(
			async () => (await store.skills.of.page({ thing }, 1, context)).items.length,
			(count) => count === 0,
		);
		await (await deleteOf(n, SkillsKind.name))(thing);
		store.release();
	});

	it("is one read however many hold it, released with its last holder", async () => {
		await writeSkill("coding", "release", "Cut a release");
		const thing = await setIn("coding");
		const [ann, ben, cy] = [await n.person("Ann"), await n.person("Ben"), await n.person("Cy")];
		await n.tick(n.pi, thing, { kind: "everyone" }, OPEN, true);
		const first = await n.holders([ann, ben], n.pi, thing);
		await until(first.held[0]!.ref.skills, (list) => list.length === 1, within("the skills", context));
		// Another holder joins the set's open read (one object per set, one watcher): it reads nothing.
		const joined = n.count("chord.query.runs");
		const third = await n.holders([cy], n.pi, thing);
		assert.deepEqual(third.held[0]!.ref.skills.value, [{ name: "release", description: "Cut a release" }]);
		assert.equal(n.count("chord.query.runs"), joined);
		await third.release();
		await first.release();
		// With every holder gone the set closes (its watcher with it); a new holder opens it again.
		await eventually(
			async () => {
				const before = n.count("chord.query.runs");
				await n.holding(ann, n.pi, thing, async (skills) => skills.skills.value);
				return n.count("chord.query.runs") - before;
			},
			(runs) => runs > 0,
			5000,
		);
	});

	it("shows a skill added after a reload of the plugin to a holder from before it", async () => {
		await writeSkill("coding", "release", "Cut a release");
		const thing = await setIn("coding");
		await n.holding(AGENT, s1, thing, async (skills, ctx) => {
			await until(skills.skills, (list) => list.length === 1, within("the skills", ctx));
			await n.reload();
			await writeSkill("coding", "review", "Review a change");
			await until(skills.skills, (list) => list.length === 2, within("the new skill", ctx));
		});
	});

	it("is collected once released", async () => {
		const thing = await setIn("coding");
		const refs: WeakRef<object>[] = [];
		await n.holding(AGENT, s1, thing, async (skills) => {
			refs.push(new WeakRef(skills), new WeakRef(skills.skills));
		});
		assert.ok(await collected(refs));
	});
});
