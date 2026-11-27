// A set's folder on the Pi's disk: where it is under the skills root (a setting people write: refused when it leaves
// the root), the skills in it (each subfolder with a `SKILL.md`, read as pi's skills are: `skillOf`), and one skill's
// text and files. The files are people's: every read is confined where it happens (`confined.ts`: the opened object
// itself, never a link, verified inside the set's real folder, which is inside the root's; folders enumerated from
// their verified handle), and a missing folder is an empty set. Watching a folder is `watch.ts`.

import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { invalid } from "@earendil-works/p3/v1";
import { openConfined } from "./confined.ts";
import { parseFrontmatter } from "./front-matter.ts";
import { messages } from "./messages.ts";
import type { Skill, SkillText } from "./skills-kind.ts";

/** A skill's file, in its folder. */
const SKILL_FILE = "SKILL.md";

/** The Pi's skills root: every set's folder is under it. */
export function skillsRoot(dataDir: string): string {
	return join(dataDir, "skills");
}

/**
 * Where `folder` (a setting: a path relative to the skills root `root`, never empty) is, or `invalid` with its message
 * when it leaves the root (an absolute path, `..` above it).
 */
export function folderPath(root: string, folder: string): string {
	const path = resolve(root, folder);
	if (isAbsolute(folder) || (path !== root && !path.startsWith(root + sep)))
		throw invalid("args", `prompt: the folder ${JSON.stringify(folder)} is outside the Pi's skills root`, {
			message: messages.message("outsideRoot", folder),
		});
	return path;
}

/** A skill in a set's folder: the skill as it is listed, and its folder (under the set's), where its files are. */
export type Listed = { readonly skill: Skill; readonly folder: string };

/**
 * The skills in the folder at `path`, in the order of their folders' names; none when it does not exist or leaves
 * `root` through a link. A name two folders give is the first folder's (pi keeps the first too).
 */
export async function readSkills(root: string, path: string): Promise<Listed[]> {
	const set = await openConfined(await realRoot(root), path, "folder");
	if (set === undefined) return [];
	try {
		const entries = await readdir(set.at, { withFileTypes: true }).catch(() => []);
		const listed: Listed[] = [];
		const names = new Set<string>();
		for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
			const text = await skillFile(set.real, join(set.at, entry.name));
			const skill = text === undefined ? undefined : skillOf(entry.name, text);
			if (skill === undefined || names.has(skill.name)) continue;
			names.add(skill.name);
			listed.push({ skill, folder: entry.name });
		}
		return listed;
	} finally {
		await set.handle.close();
	}
}

/**
 * The skill a `SKILL.md`'s `text` in folder `folder` is, read as pi's `loadSkillFromFile` (coding-agent
 * core/skills.ts) reads it: its front matter's `name`, else the folder's; its `description`, required (none, an empty
 * one, or front matter that does not parse: no skill). pi's warnings (a name or description against the Agent Skills
 * spec) do not stop it either. `disable-model-invocation: true` leaves it out: pi offers such a skill only through a
 * command, which p3 has not, never in the agent's prompt.
 */
function skillOf(folder: string, text: string): Skill | undefined {
	let frontmatter: Readonly<Record<string, unknown>>;
	try {
		({ frontmatter } = parseFrontmatter(text));
	} catch {
		return undefined;
	}
	const { name, description } = frontmatter;
	if (typeof description !== "string" || description.trim() === "") return undefined;
	if (frontmatter["disable-model-invocation"] === true) return undefined;
	return { name: typeof name === "string" && name !== "" ? name : folder, description };
}

/**
 * The text and other files of the skill in folder `folder` of the set at `path`; `invalid` naming skill `name` when
 * there is none there.
 */
export async function readSkill(root: string, path: string, folder: string, name: string): Promise<SkillText> {
	// A skill's folder is one folder of the set: `..` or a separator would reach outside it.
	const set =
		folder.includes("/") || folder.startsWith(".")
			? undefined
			: await openConfined(await realRoot(root), path, "folder");
	const skill = set === undefined ? undefined : await openConfined(set.real, join(set.at, folder), "folder");
	try {
		const text = skill === undefined ? undefined : await skillFile(skill.real, skill.at);
		if (skill === undefined || text === undefined) throw invalid("args", `prompt: no skill ${JSON.stringify(name)}`);
		// Enumerated from the verified folder; links are not followed: a linked file or folder of a skill is not one of
		// its files.
		const files = (await readdir(skill.at, { recursive: true, withFileTypes: true }))
			.filter((entry) => entry.isFile())
			.map((entry) => relative(skill.at, join(entry.parentPath, entry.name)))
			.filter((file) => file !== SKILL_FILE)
			.toSorted();
		return { text, files };
	} finally {
		await skill?.handle.close();
		await set?.handle.close();
	}
}

/** The `SKILL.md` in the skill folder at `folder`, read only from a regular file opened inside `within` (real). */
async function skillFile(within: string, folder: string): Promise<string | undefined> {
	const file = await openConfined(within, join(folder, SKILL_FILE), "file");
	if (file === undefined) return undefined;
	try {
		return await file.handle.readFile("utf8");
	} finally {
		await file.handle.close();
	}
}

/** The root's real path; none: no skills at all. */
function realRoot(root: string): Promise<string | undefined> {
	return realpath(root).catch(() => undefined);
}
