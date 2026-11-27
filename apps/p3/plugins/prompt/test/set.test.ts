// One set of skills on the server (`SkillSet`, held directly as server code holds it): it follows its folder (a skill
// added appears without a reload), and a folder configured later that is made only after that; `read` opens a skill
// by its listed name from its folder (a name of its front matter, not the folder's); a change of another file keeps
// its list for a read that finds the same skills (no new value for its holders); a folder installed by one rename
// while it waited is seen; without a folder it
// has no skills and refuses `read`; a folder linked out of the root gives no skill to `read`.

import assert from "node:assert/strict";
import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, type Reference, until } from "@earendil-works/p3/v1";
import { eventually, within } from "../../../test/until.ts";
import { refused } from "../../things/test/kind-server.ts";
import { SkillSet } from "../set.ts";
import { type Skills, SkillsKind } from "../skills-kind.ts";
import { PromptStore } from "../store.ts";
import { type PromptServer, promptKind } from "./prompt-server.ts";

/** How long a wait for what a folder watch sees may take (a loaded machine delays its events). */
const WATCHED = 10_000;

let n: PromptServer<typeof Skills>;
let store: Reference<typeof PromptStore>;

beforeEach(async () => {
	n = await promptKind(SkillsKind, context);
	store = await n.host.get(PromptStore, {}, context);
});

afterEach(async () => {
	store.release();
	await n.close();
});

/** Writes skill `name` into `folder` under the root, with `description`. */
async function writeSkill(folder: string, name: string, description: string): Promise<void> {
	await mkdir(join(n.root, folder, name), { recursive: true });
	await writeFile(join(n.root, folder, name, "SKILL.md"), `---\ndescription: ${description}\n---\n`);
}

/** Makes a set in Pi with folder `folder` (none: never configured); its id. */
async function setIn(folder?: string): Promise<string> {
	const thing = await n.thingIn(n.pi, folder ?? "none");
	if (folder !== undefined) await store.configureSkills({ thing, folder }, context);
	return thing;
}

describe("a set", () => {
	it("follows its folder: a skill added appears without a reload", async () => {
		await writeSkill("coding", "release", "Cut a release");
		const set = await n.host.get(SkillSet, { thing: await setIn("coding") }, context);
		try {
			await until(set.skills, (list) => list.length === 1, within("the folder's skills", context, WATCHED));
			await writeSkill("coding", "review", "Review a change");
			await until(set.skills, (list) => list.length === 2, within("the new skill", context, WATCHED));
		} finally {
			set.release();
		}
	});

	it("reads a skill by its listed name, from its folder, also where the name is not the folder's", async () => {
		await mkdir(join(n.root, "coding", "cut-release"), { recursive: true });
		await writeFile(
			join(n.root, "coding", "cut-release", "SKILL.md"),
			"---\nname: release\ndescription: Cut a release\n---\nThe steps.\n",
		);
		const set = await n.host.get(SkillSet, { thing: await setIn("coding") }, context);
		try {
			await until(set.skills, (list) => list[0]?.name === "release", within("the skill", context, WATCHED));
			assert.match((await set.read({ name: "release" }, context)).text, /The steps\./);
			await refused(set.read({ name: "cut-release" }, context), "invalid");
		} finally {
			set.release();
		}
	});

	it("follows a folder configured later, made after that (Astra, round 1)", async () => {
		await writeSkill("existing", "old", "before");
		const thing = await setIn("existing");
		const set = await n.host.get(SkillSet, { thing }, context);
		try {
			await until(set.skills, (list) => list.length === 1, within("loaded", context, WATCHED));
			await store.configureSkills({ thing, folder: "later" }, context);
			await until(set.skills, (list) => list.length === 0, within("the new folder, missing", context, WATCHED));
			await writeSkill("later", "new", "after");
			await until(set.skills, (list) => list[0]?.name === "new", within("its first skill", context, WATCHED));
		} finally {
			set.release();
		}
	});

	it("sees a folder installed by one rename while it waited for it (Astra, review of the cleanup)", async () => {
		await writeSkill("old", "old-skill", "old");
		const staged = join(n.root, "..", "staged");
		await mkdir(join(staged, "child", "new-skill"), { recursive: true });
		await writeFile(join(staged, "child", "new-skill", "SKILL.md"), "---\ndescription: new\n---\n");
		const thing = await setIn("old");
		const set = await n.host.get(SkillSet, { thing }, context);
		try {
			await until(set.skills, (list) => list.length === 1, within("the old folder", context, WATCHED));
			await store.configureSkills({ thing, folder: "later/child" }, context);
			await until(set.skills, (list) => list.length === 0, within("the missing folder", context, WATCHED));
			// One rename, no other write: the set's watch was armed after its read of the missing folder.
			await rename(staged, join(n.root, "later"));
			await until(set.skills, (list) => list[0]?.name === "new-skill", within("the install", context, WATCHED));
		} finally {
			set.release();
		}
	});

	it("keeps its list for a read that finds the same skills: no new value for its holders (Astra, review)", async () => {
		for (const folder of ["one", "two"]) {
			await mkdir(join(n.root, folder, "release"), { recursive: true });
			await writeFile(join(n.root, folder, "release", "SKILL.md"), `---\ndescription: Same\n---\n${folder}\n`);
		}
		const thing = await setIn("one");
		const set = await n.host.get(SkillSet, { thing }, context);
		try {
			const listed = await until(set.skills, (list) => list.length === 1, within("the skills", context, WATCHED));
			assert.match((await set.read({ name: "release" }, context)).text, /one\n$/);
			await store.configureSkills({ thing, folder: "two" }, context);
			// `read` answers the other folder's text once its read is in: the list it found was the same.
			await eventually(
				() => set.read({ name: "release" }, context),
				(read) => /two\n$/.test(read.text),
			);
			assert.equal(set.skills.value, listed);
		} finally {
			set.release();
		}
	});

	it("has no skills and refuses `read` without a folder (Opus, round 1)", async () => {
		await writeSkill("", "root-level", "at the root");
		const set = await n.host.get(SkillSet, { thing: await setIn() }, context);
		try {
			assert.deepEqual([set.folder.value, set.skills.value], ["", []]);
			await refused(set.read({ name: "root-level" }, context), "invalid");
		} finally {
			set.release();
		}
	});

	it("reads no skill of a folder linked out of the root (Astra, round 2)", async () => {
		const outside = join(n.root, "..", "elsewhere");
		await mkdir(join(outside, "secret"), { recursive: true });
		await writeFile(join(outside, "secret", "SKILL.md"), "---\ndescription: outside\n---\n");
		await mkdir(n.root, { recursive: true });
		await symlink(outside, join(n.root, "linked"));
		const set = await n.host.get(SkillSet, { thing: await setIn("linked") }, context);
		try {
			await refused(set.read({ name: "secret" }, context), "invalid");
		} finally {
			set.release();
		}
	});
});
