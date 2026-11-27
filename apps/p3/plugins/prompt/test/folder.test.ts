// A set's folder on disk (`folder.ts`): a folder setting is refused when it leaves the skills root; the skills of a
// folder are its subfolders with a regular `SKILL.md`, in the folders' order, read as pi reads them: the front
// matter's `name`, else the folder's, and its `description` (plain, quoted, folded, a BOM and Windows lines read
// too), required: none, an empty one or YAML that does not parse is no skill; `disable-model-invocation` leaves it
// out (and still takes its name, as in pi); a name two folders give is the first's, dot folders and links never
// count; a missing folder or root has none; a folder, a skill folder or a `SKILL.md` linked out of the set (to
// another set, out of the root) is not read, and neither is a `SKILL.md` that is a folder; a skill's files are those
// of its folder, its links left out.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isChordError } from "@earendil-works/p3/v1";
import { folderPath, readSkill, readSkills, skillsRoot } from "../folder.ts";

let dataDir: string;
let root: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "p3-prompt-folder-"));
	root = skillsRoot(dataDir);
	await mkdir(root);
});

afterEach(() => rm(dataDir, { recursive: true, force: true }));

/** Writes `text` as the `SKILL.md` of skill `name` in `folder` under the root. */
async function skillMd(folder: string, name: string, text: string): Promise<void> {
	await mkdir(join(root, folder, name), { recursive: true });
	await writeFile(join(root, folder, name, "SKILL.md"), text);
}

/** Whether `promise` rejects as `invalid`. */
const invalid = (promise: Promise<unknown>) =>
	assert.rejects(promise, (error: unknown) => isChordError(error) && error.code === "invalid");

describe("a folder setting", () => {
	it("is a path under the skills root, refused when it leaves it", () => {
		assert.equal(folderPath(root, "coding"), join(root, "coding"));
		assert.equal(folderPath(root, ""), root);
		for (const outside of ["/etc", "..", "../other", "coding/../../x"]) {
			assert.throws(() => folderPath(root, outside), /outside the Pi's skills root/);
		}
	});
});

describe("a folder's skills", () => {
	it("are its subfolders with a SKILL.md, read as pi reads them", async () => {
		await skillMd("coding", "a-release", "---\nname: release\ndescription: Cut a release\n---\n# Release\n");
		await skillMd("coding", "b-release", "---\nname: release\ndescription: The second one\n---\n");
		await skillMd("coding", "quoted", `---\ndescription: "Say: hello"\n---\n`);
		await skillMd("coding", "folded", "---\ndescription: >\n  Reviews a change\n  line by line.\n---\n");
		await skillMd("coding", "bom", "\uFEFF---\r\ndescription: Windows lines\r\n---\r\n");
		await skillMd("coding", "manual", "---\ndescription: Only by command\ndisable-model-invocation: true\n---\n");
		await skillMd("coding", "plain", "# No front matter\n");
		await skillMd("coding", "blank", "---\ndescription: '  '\n---\n");
		await skillMd("coding", "broken", "---\ndescription: [unclosed\n---\n");
		await mkdir(join(root, "coding", "empty"));
		assert.deepEqual(await readSkills(root, join(root, "coding")), [
			{ skill: { name: "release", description: "Cut a release" }, folder: "a-release" },
			{ skill: { name: "bom", description: "Windows lines" }, folder: "bom" },
			{ skill: { name: "folded", description: "Reviews a change line by line.\n" }, folder: "folded" },
			{ skill: { name: "quoted", description: "Say: hello" }, folder: "quoted" },
		]);
	});

	it("are read from the folders that can be read: dot folders and links never win a name (Astra, review)", async () => {
		await skillMd("coding", ".draft", "---\nname: release\ndescription: A draft\n---\nDraft.\n");
		await skillMd("coding", "release", "---\nname: release\ndescription: Cut a release\n---\nThe steps.\n");
		await symlink(join(root, "coding", "release"), join(root, "coding", "a-release"));
		assert.deepEqual(await readSkills(root, join(root, "coding")), [
			{ skill: { name: "release", description: "Cut a release" }, folder: "release" },
		]);
		assert.match((await readSkill(root, join(root, "coding"), "release", "release")).text, /The steps\./);
	});

	it("keep the first of two equal names also when it is offered by command only, as pi does (Astra, review)", async () => {
		await skillMd("coding", "a-manual", "---\nname: release\ndescription: x\ndisable-model-invocation: true\n---\n");
		await skillMd("coding", "release", "---\nname: release\ndescription: Cut a release\n---\n");
		await skillMd("coding", "review", "---\ndescription: Review\n---\n");
		assert.deepEqual(
			(await readSkills(root, join(root, "coding"))).map(({ folder }) => folder),
			["review"],
		);
	});

	it("are none for a missing folder or root", async () => {
		assert.deepEqual(await readSkills(root, join(root, "missing")), []);
		await rm(root, { recursive: true });
		assert.deepEqual(await readSkills(root, join(root, "coding")), []);
	});

	it("leave out links out of the set or the root, and a SKILL.md that is a folder (Astra, rounds 1, 2)", async () => {
		await skillMd("coding", "release", "---\ndescription: Cut a release\n---\n");
		await skillMd("other", "secret", "---\ndescription: Another set's\n---\n");
		const outside = join(dataDir, "outside");
		await mkdir(join(outside, "escape"), { recursive: true });
		await writeFile(join(outside, "escape", "SKILL.md"), "---\ndescription: outside\n---\n");
		await symlink(join(root, "other", "secret"), join(root, "coding", "borrowed"));
		await symlink(join(outside, "escape"), join(root, "coding", "escaped"));
		await mkdir(join(root, "coding", "linked"));
		await symlink(join(outside, "escape", "SKILL.md"), join(root, "coding", "linked", "SKILL.md"));
		await mkdir(join(root, "coding", "odd", "SKILL.md"), { recursive: true });
		await symlink(outside, join(root, "out"));
		assert.deepEqual(
			(await readSkills(root, join(root, "coding"))).map(({ folder }) => folder),
			["release"],
		);
		assert.deepEqual(await readSkills(root, join(root, "out")), []);
		for (const name of ["borrowed", "escaped", "linked", "odd"]) {
			await invalid(readSkill(root, join(root, "coding"), name, name));
		}
		await invalid(readSkill(root, join(root, "out"), "escape", "escape"));
	});
});

describe("a skill", () => {
	it("is its SKILL.md's text and its folder's other files, links left out", async () => {
		await skillMd("coding", "release", "---\ndescription: Cut a release\n---\n# Release\n");
		await mkdir(join(root, "coding", "release", "scripts"));
		await writeFile(join(root, "coding", "release", "scripts", "run.sh"), "echo hi\n");
		await writeFile(join(dataDir, "secret.txt"), "not the skill's\n");
		await symlink(join(dataDir, "secret.txt"), join(root, "coding", "release", "secret.txt"));
		assert.deepEqual(await readSkill(root, join(root, "coding"), "release", "release"), {
			text: "---\ndescription: Cut a release\n---\n# Release\n",
			files: ["scripts/run.sh"],
		});
	});

	it("is refused for a folder that is none of the set's", async () => {
		await skillMd("coding", "release", "---\ndescription: x\n---\n");
		await skillMd("other", "secret", "---\ndescription: y\n---\n");
		for (const name of ["missing", "../other/secret", ".", "..", "release/../../other/secret"]) {
			await invalid(readSkill(root, join(root, "coding"), name, name));
		}
	});
});
