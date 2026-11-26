// The skills plugin on the server (`testPlugin`, beside the things plugin's server facet): a set lists the skills of
// its folder under the Pi's skills root (`<data directory>/skills`), with their descriptions, and follows the folder
// live (a skill added appears for a holder without a reload; one watcher per set); the agent gets Use, which gives
// `read`: a skill's text and its other files; a folder setting outside the root is refused; the setting goes with the
// thing.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
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
import { ThingsStore } from "../../things/contract.server.ts";
import type { Source } from "../../things/contract.ts";
import thingsServer from "../../things/server.ts";
import { Skills, SkillsKind } from "../contract.ts";
import { folderPath } from "../folder.ts";
import { skillsRoot } from "../set.ts";
import { SkillsStore } from "../store.ts";

/** Who sets things up in the tests. */
const BY: Source = { kind: "plugin", plugin: "test" };

/** The session whose agent the tests hold as. */
const AGENT: P3Principal = { kind: "worker", session: "s1" };

let t: TestedPlugin<P3Principal>;
let things: Reference<typeof ThingsStore>;
let pi: string;
let root: string;

beforeEach(async () => {
	t = await testPlugin(
		fileURLToPath(new URL("../", import.meta.url)),
		{ kind: "server", stubs: [{ name: "@earendil-works/p3-things", facet: thingsServer }] },
		context,
	);
	things = await t.host.get(ThingsStore, {}, context);
	pi = (await things.workspaces.children.page({ parent: "" }, 1, context)).items[0]!.workspace;
	await things.putParty({ workspace: pi, party: { kind: "agent", session: "s1" }, source: BY }, context);
	root = skillsRoot((await t.host.registry(ServerRuntime, context)).value.dataDir);
});

afterEach(() => t.close(context));

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
	await (await t.host.get(SkillsStore, {}, context)).set({ thing, folder }, context);
	return thing;
}

/** Runs `fn` with the agent's reference to set `thing` in Pi. */
function holding<T>(thing: string, fn: (skills: Reference<typeof Skills>, ctx: Ctx<P3Principal>) => Promise<T>) {
	return t.root(
		async (ctx) => fn(await ctx.get(Skills, { workspace: pi, thing }, { readyTimeout: 500 }), ctx),
		context,
		{ principal: AGENT },
	);
}

describe("a set of skills", () => {
	it("lists its folder's skills and follows the folder live; the agent reads a skill's text and files", async () => {
		await writeSkill("coding", "release", "Cut a release", ["scripts/run.sh"]);
		const thing = await setIn("coding");
		await holding(thing, async (skills, ctx) => {
			assert.deepEqual([...skills.granted], ["read"]);
			await until(skills.skills, (list) => list.length === 1, within("the folder's skills", ctx));
			assert.deepEqual(skills.skills.value, [{ name: "release", description: "Cut a release" }]);
			assert.equal(skills.folder.value, "coding");
			await writeSkill("coding", "review", "Review a change");
			await until(skills.skills, (list) => list.length === 2, within("the new skill", ctx));
			const read = await skills.read!({ name: "release" }, ctx);
			assert.match(read.text, /description: Cut a release/);
			assert.deepEqual(read.files, ["scripts/run.sh"]);
			await assert.rejects(skills.read!({ name: "../coding" }, ctx), (error) => isChordError(error));
		});
	});

	it("refuses a folder outside the skills root", () => {
		assert.equal(folderPath(root, "coding"), join(root, "coding"));
		assert.equal(folderPath(root, ""), root);
		for (const outside of ["/etc", "..", "../other", "coding/../../x"]) {
			assert.throws(() => folderPath(root, outside), /outside the Pi's skills root/);
		}
	});

	it("drops its setting with the thing", async () => {
		const thing = await setIn("coding");
		await things.unlink({ workspace: pi, thing }, context);
		const store = await t.host.get(SkillsStore, {}, context);
		await eventually(
			async () => (await store.settings.of.page({ thing }, 1, context)).items.length,
			(count) => count === 0,
		);
	});
});
