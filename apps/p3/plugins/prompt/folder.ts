// A set's folder on the Pi's disk: where it is under the skills root (a setting people write: refused when it leaves
// the root), the skills in it (each subfolder with a `SKILL.md`, its description from the file's front matter), one
// skill's text and files, and a watcher that says when anything under the folder changed, also once a missing folder
// is made. The files are people's: every read is confined where it happens (its real path, links resolved, inside the
// set's real folder, which is inside the root's), and a missing folder is an empty set.

import { existsSync, type FSWatcher, mkdirSync, watch } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { invalid } from "@earendil-works/p3/v1";
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

/** The skills in the folder at `path`, by name; none when it does not exist or leaves `root` through a link. */
export async function readSkills(root: string, path: string): Promise<Skill[]> {
	const set = await inside(await realRoot(root), path);
	if (set === undefined) return [];
	const entries = await readdir(set, { withFileTypes: true }).catch(() => []);
	const skills: Skill[] = [];
	for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
		const text = await skillFile(set, entry.name);
		if (text !== undefined) skills.push({ name: entry.name, description: descriptionOf(text) });
	}
	return skills;
}

/** Skill `name`'s text and the other files of its folder; `invalid` when the set has no such skill. */
export async function readSkill(root: string, path: string, name: string): Promise<SkillText> {
	const set = await inside(await realRoot(root), path);
	// A name is one folder: `..` or a separator would reach outside the set.
	const ok = set !== undefined && !name.includes("/") && !name.startsWith(".");
	const text = ok ? await skillFile(set, name) : undefined;
	const folder = ok ? await inside(set, join(set, name)) : undefined;
	if (text === undefined || folder === undefined) throw invalid("args", `prompt: no skill ${JSON.stringify(name)}`);
	// Links are not followed: a linked file or folder of a skill is not one of its files.
	const files = (await readdir(folder, { recursive: true, withFileTypes: true }))
		.filter((entry) => entry.isFile())
		.map((entry) => relative(folder, join(entry.parentPath, entry.name)))
		.filter((file) => file !== SKILL_FILE)
		.toSorted();
	return { text, files };
}

/** The `SKILL.md` of the skill folder `name` in the real set folder `set`, read only where its real path is inside. */
async function skillFile(set: string, name: string): Promise<string | undefined> {
	const file = await inside(set, join(set, name, SKILL_FILE));
	return file === undefined ? undefined : readFile(file, "utf8").catch(() => undefined);
}

/** The root's real path; none: no skills at all. */
function realRoot(root: string): Promise<string | undefined> {
	return realpath(root).catch(() => undefined);
}

/** `path`'s real path while it exists and is `within` (a real path) or inside it, else `undefined`. */
async function inside(within: string | undefined, path: string): Promise<string | undefined> {
	if (within === undefined) return undefined;
	const real = await realpath(path).catch(() => undefined);
	if (real === undefined) return undefined;
	return real === within || real.startsWith(within + sep) ? real : undefined;
}

/**
 * A watcher of one folder at a time and everything under it: `changed` is called after each change. A folder that
 * does not exist yet is waited for: its nearest existing ancestor under the root is watched (the root is made when
 * missing), and the watcher moves to the folder once it exists. An error (the folder removed) re-arms it.
 */
export class FolderWatch {
	readonly #root: string;
	readonly #changed: () => void;
	#path: string | undefined;
	#watched: string | undefined;
	#watcher: FSWatcher | undefined;

	/** A watcher under `root` that watches nothing yet; each change calls `changed`. */
	constructor(root: string, changed: () => void) {
		this.#root = root;
		this.#changed = changed;
	}

	/** Watches `path` (a folder under the root) instead of the folder before; `undefined`: nothing. */
	watch(path: string | undefined): void {
		this.#path = path;
		this.#arm();
	}

	/** Stops watching. */
	close(): void {
		this.#path = undefined;
		this.#arm();
	}

	/** Watches the nearest existing folder on the way to `#path`, if it is another than now. */
	#arm(): void {
		const target = this.#path === undefined ? undefined : this.#nearest(this.#path);
		if (target === this.#watched) return;
		this.#watcher?.close();
		this.#watcher = undefined;
		this.#watched = target;
		if (target === undefined) return;
		try {
			this.#watcher = watch(target, { recursive: true }, () => {
				// Waiting for the folder: it may exist now.
				if (target !== this.#path) this.#arm();
				this.#changed();
			});
			this.#watcher.on("error", () => {
				this.#watched = undefined;
				this.#arm();
				this.#changed();
			});
		} catch {
			this.#watched = undefined;
		}
	}

	/** `path` when it exists, else its nearest existing ancestor up to the root (made when missing). */
	#nearest(path: string): string {
		let at = path;
		while (at !== this.#root && !existsSync(at)) at = dirname(at);
		if (at === this.#root && !existsSync(at)) mkdirSync(at, { recursive: true });
		return at;
	}
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
