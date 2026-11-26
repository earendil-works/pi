// A set's folder on the Pi's disk: where it is under the skills root (a setting people write: refused when it leaves
// the root), the skills in it (each subfolder with a `SKILL.md`, its description from the file's front matter), one
// skill's text and files, and a watcher that says when anything under the folder changed, also once a missing folder
// is made. The files are people's: every read is confined where it happens (the opened object itself, never a link,
// verified inside the set's real folder, which is inside the root's; folders enumerated from their verified handle),
// the watcher watches only folders verified inside the root, and a missing folder is an empty set.

import { existsSync, type FSWatcher, mkdirSync, realpathSync, watch } from "node:fs";
import { constants, type FileHandle, open, readdir, readlink, realpath } from "node:fs/promises";
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
	const set = await opened(await realRoot(root), path, "folder");
	if (set === undefined) return [];
	try {
		const entries = await readdir(set.at, { withFileTypes: true }).catch(() => []);
		const skills: Skill[] = [];
		for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
			const text = await skillFile(set.real, join(set.at, entry.name));
			if (text !== undefined) skills.push({ name: entry.name, description: descriptionOf(text) });
		}
		return skills;
	} finally {
		await set.handle.close();
	}
}

/** Skill `name`'s text and the other files of its folder; `invalid` when the set has no such skill. */
export async function readSkill(root: string, path: string, name: string): Promise<SkillText> {
	// A name is one folder: `..` or a separator would reach outside the set.
	const set =
		name.includes("/") || name.startsWith(".") ? undefined : await opened(await realRoot(root), path, "folder");
	const skill = set === undefined ? undefined : await opened(set.real, join(set.at, name), "folder");
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
	const file = await opened(within, join(folder, SKILL_FILE), "file");
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

/** An open file or folder that was verified to be inside a set: its handle, its real path, and where to reach it. */
type Opened = { readonly handle: FileHandle; readonly real: string; readonly at: string };

/**
 * `path` opened as a regular file or a folder, its last part never a link (`O_NOFOLLOW`), then verified where it was
 * opened: the opened object's real path (Linux and Android name it in `/proc/self/fd`) is `within` (a real path) or
 * inside it. `at` reaches the verified object itself (its `/proc/self/fd` path) where the system names one. `undefined`
 * for anything else: missing, a link, outside, another kind of file. A change between the open and a later read inside
 * it, by someone with a shell on the Pi, is the residual race accepted as for Files.
 */
async function opened(within: string | undefined, path: string, kind: "file" | "folder"): Promise<Opened | undefined> {
	if (within === undefined) return undefined;
	const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (kind === "folder" ? constants.O_DIRECTORY : 0);
	const handle = await open(path, flags).catch(() => undefined);
	if (handle === undefined) return undefined;
	const proc = `/proc/self/fd/${handle.fd}`;
	const named = await readlink(proc).catch(() => undefined);
	const real = named ?? (await realpath(path).catch(() => undefined));
	const stats = await handle.stat().catch(() => undefined);
	const fits = kind === "file" ? stats?.isFile() : stats?.isDirectory();
	if (real === undefined || fits !== true || !(real === within || real.startsWith(within + sep))) {
		await handle.close();
		return undefined;
	}
	return { handle, real, at: named === undefined ? real : proc };
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

	/**
	 * `path` when it exists, else its nearest existing ancestor up to the root (made when missing); `undefined` when
	 * that folder's real path is not inside the root's (a link out): nothing is watched there.
	 */
	#nearest(path: string): string | undefined {
		let at = path;
		while (at !== this.#root && !existsSync(at)) at = dirname(at);
		if (at === this.#root && !existsSync(at)) mkdirSync(at, { recursive: true });
		try {
			const root = realpathSync(this.#root);
			const real = realpathSync(at);
			return real === root || real.startsWith(root + sep) ? real : undefined;
		} catch {
			return undefined;
		}
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
