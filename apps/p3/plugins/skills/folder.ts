// A set's folder on the Pi's disk: where it is under the skills root (a setting people write: refused when it leaves
// the root), the skills in it (each subfolder with a `SKILL.md`, its description from the file's front matter), one
// skill's text and files, and a watcher that says when anything under the folder changed. The files are people's:
// read defensively, a missing folder is an empty set.

import { type FSWatcher, watch } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { invalid } from "@earendil-works/p3/v1";
import type { Skill, SkillText } from "./contract.ts";

/** A skill's file, in its folder. */
const SKILL_FILE = "SKILL.md";

/** The Pi's skills root: every set's folder is under it. */
export function skillsRoot(dataDir: string): string {
	return join(dataDir, "skills");
}

/**
 * Where `folder` (a setting: a path relative to the skills root `root`) is, or `invalid` when it leaves the root (an
 * absolute path, `..` above it). The empty folder is the root itself.
 */
export function folderPath(root: string, folder: string): string {
	const path = resolve(root, folder);
	if (isAbsolute(folder) || (path !== root && !path.startsWith(root + sep)))
		throw invalid("args", `skills: the folder ${JSON.stringify(folder)} is outside the Pi's skills root`);
	return path;
}

/** The skills in the folder at `path`, by name; none when it does not exist (or leaves `root` through a link). */
export async function readSkills(root: string, path: string): Promise<Skill[]> {
	const real = await inside(root, path);
	if (real === undefined) return [];
	const entries = await readdir(real, { withFileTypes: true }).catch(() => []);
	const skills: Skill[] = [];
	for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory()) continue;
		const text = await readFile(join(real, entry.name, SKILL_FILE), "utf8").catch(() => undefined);
		if (text !== undefined) skills.push({ name: entry.name, description: descriptionOf(text) });
	}
	return skills;
}

/** Skill `name`'s text and the other files of its folder; `invalid` when the set has no such skill. */
export async function readSkill(root: string, path: string, name: string): Promise<SkillText> {
	const real = await inside(root, path);
	// A name is one folder: `..` or a separator would reach outside the set.
	const folder = real === undefined || name.includes("/") || name.startsWith(".") ? undefined : join(real, name);
	const text =
		folder === undefined ? undefined : await readFile(join(folder, SKILL_FILE), "utf8").catch(() => undefined);
	if (folder === undefined || text === undefined) throw invalid("args", `skills: no skill ${JSON.stringify(name)}`);
	const files = (await readdir(folder, { recursive: true, withFileTypes: true }))
		.filter((entry) => entry.isFile())
		.map((entry) => relative(folder, join(entry.parentPath, entry.name)))
		.filter((file) => file !== SKILL_FILE)
		.toSorted();
	return { text, files };
}

/** A watcher of one folder at a time and everything under it: `changed` is called after each change. */
export class FolderWatch {
	readonly #changed: () => void;
	#watcher: FSWatcher | undefined;

	/** A watcher that watches nothing yet; each change of the folder it watches calls `changed`. */
	constructor(changed: () => void) {
		this.#changed = changed;
	}

	/** Watches `path` instead of the folder before; a missing folder is watched by nobody. */
	watch(path: string): void {
		this.close();
		try {
			this.#watcher = watch(path, { recursive: true }, () => this.#changed());
			// A folder removed while watched: the next read finds it empty.
			this.#watcher.on("error", () => this.#changed());
		} catch {
			this.#watcher = undefined;
		}
	}

	/** Stops watching. */
	close(): void {
		this.#watcher?.close();
		this.#watcher = undefined;
	}
}

/** `path`'s real path while it exists and is inside `root`'s, else `undefined`. */
async function inside(root: string, path: string): Promise<string | undefined> {
	const [realRoot, real] = await Promise.all([
		realpath(root).catch(() => undefined),
		realpath(path).catch(() => undefined),
	]);
	if (realRoot === undefined || real === undefined) return undefined;
	return real === realRoot || real.startsWith(realRoot + sep) ? real : undefined;
}

/** The `description` of a `SKILL.md`'s front matter (`---` lines around `key: value` lines); none: empty. */
function descriptionOf(text: string): string {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return "";
	for (const line of lines.slice(1)) {
		if (line.trim() === "---") break;
		const match = /^description:\s*(.*)$/.exec(line);
		if (match !== null) return (match[1] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
	}
	return "";
}
