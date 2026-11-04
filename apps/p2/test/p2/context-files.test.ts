// Prompt resources (Pi Mobile's context files): the global AGENTS.md of the data directory is always local; a remote
// environment's file at the same path is another file and is read too, a local session's is not read twice.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { loadPromptResources, type PromptFiles } from "../../plugins/prompt/context-files.ts";

test("a remote file at the local global AGENTS.md path is its own file", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-context-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(join(directory, "AGENTS.md"), "LOCAL GLOBAL");
	// Local session working in the data directory: the global file once.
	const local = await loadPromptResources(directory, directory);
	assert.equal(local.agents.match(/LOCAL GLOBAL/g)?.length, 1);
	// Remote session whose cwd has the same path: the remote AGENTS.md there is read as well.
	const remote: PromptFiles = {
		paths: { join, dirname, resolve, basename },
		readText: async (path) => (path === join(directory, "AGENTS.md") ? "REMOTE PROJECT" : undefined),
		entries: async () => undefined,
	};
	const resources = await loadPromptResources(directory, directory, remote);
	assert.match(resources.agents, /LOCAL GLOBAL/);
	assert.match(resources.agents, /REMOTE PROJECT/);
});

test("skills follow pi's discovery: root .md files, SKILL.md directories, invalid files skipped", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "p2-skills-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const skills = join(directory, "skills");
	const write = (path: string, content: string) => {
		mkdirSync(dirname(join(skills, path)), { recursive: true });
		writeFileSync(join(skills, path), content);
	};
	write("release.md", "---\nname: release\ndescription: Root file skill.\n---\nBody");
	write("README.md", "# Not a skill: no frontmatter");
	write("broken.md", "---\nname: [unclosed\n---\n");
	write("deploy/SKILL.md", "---\ndescription: Directory skill, named after its directory.\n---\n");
	write("deploy/notes.md", "---\nname: notes\ndescription: Inside a skill directory: not a skill.\n---\n");
	write("group/nested.md", "---\nname: nested\ndescription: Below the root without SKILL.md: not a skill.\n---\n");
	write("group/odd/SKILL.md", "---\nname: Odd Name\ndescription: pi only warns about the name.\n---\n");
	write("node_modules/dep/SKILL.md", "---\nname: dep\ndescription: Skipped.\n---\n");
	write(".hidden/SKILL.md", "---\nname: hidden\ndescription: Skipped.\n---\n");
	const loaded = await loadPromptResources(directory, directory);
	assert.deepEqual(
		loaded.skillFiles.map(({ name, path }) => [name, path]),
		[
			["deploy", join(skills, "deploy", "SKILL.md")],
			["Odd Name", join(skills, "group", "odd", "SKILL.md")],
			["release", join(skills, "release.md")],
		],
	);
});
