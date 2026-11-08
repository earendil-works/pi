// Skill frontmatter/prompt conventions adapted from earendil-works/pi (MIT).
// See third-party/pi.LICENSE. This host uses only global and cwd-local skill roots.
import { readdir } from "node:fs/promises";
import { basename, dirname, join, type PlatformPath, resolve } from "node:path";
import { optionalText, stripBom } from "@p2/app/v1/node";
import { type PromptTemplate, parseFrontmatter, parseTemplate, type SkillFile } from "./templates.ts";

/**
 * A session's loaded prompt resources: the instructions and skills sections, every skill (including those hidden from
 * the model with `disable-model-invocation`, which `/skill:` still invokes, as in pi) and the prompt templates.
 */
export type LoadedPrompt = {
	agents: string;
	skills: string;
	fingerprint: string;
	skillFiles: SkillFile[];
	templates: PromptTemplate[];
	/**
	 * The same without the global `AGENTS.md`, skills and prompt templates (only the project's): what a locked session
	 * gets unless its owner picked the global instructions.
	 */
	project?: Omit<LoadedPrompt, "project" | "fingerprint">;
};

type Skill = { name: string; description: string; path: string; disabled: boolean; global: boolean };

/**
 * Where project instructions and skills are read: the local filesystem, or a session's execution environment. Missing
 * files and directories are `undefined`; other failures throw.
 */
export type PromptFiles = {
	readonly paths: Pick<PlatformPath, "join" | "dirname" | "resolve" | "basename">;
	readText(path: string): Promise<string | undefined>;
	/** Entries of a directory, without following symbolic links. */
	entries(path: string): Promise<{ name: string; kind: "file" | "directory" | "other" }[] | undefined>;
};

/** The local filesystem. */
export const localFiles: PromptFiles = {
	paths: { join, dirname, resolve, basename },
	readText: optionalText,
	async entries(path) {
		try {
			return (await readdir(path, { withFileTypes: true })).map((entry) => ({
				name: entry.name,
				kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
			}));
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
			throw new Error("Could not scan skills directory");
		}
	},
};

function escapeXml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

/**
 * pi's discovery (coding-agent core/skills.ts `loadSkillsFromDir`): a directory holding `SKILL.md` is one skill and is
 * not searched further; otherwise `.md` files directly in the skills root are skills, and subdirectories are searched
 * for `SKILL.md`. Hidden entries and `node_modules` are skipped. Unlike pi, symbolic links are not followed (the watch
 * does not follow them either, and there is no cycle to guard against) and `.gitignore`-style files are not read.
 */
async function skillFiles(files: PromptFiles, path: string, root = true): Promise<string[]> {
	const entries = await files.entries(path);
	if (!entries) return [];
	if (entries.some((entry) => entry.kind === "file" && entry.name === "SKILL.md"))
		return [files.paths.join(path, "SKILL.md")];
	const found = await Promise.all(
		entries
			.filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(async (entry) => {
				const child = files.paths.join(path, entry.name);
				if (entry.kind === "directory") return skillFiles(files, child, false);
				return root && entry.kind === "file" && entry.name.endsWith(".md") ? [child] : [];
			}),
	);
	return found.flat();
}

/** Each `AGENTS.md` candidate from the filesystem root down to `cwd`. */
export function agentsCandidates(paths: Pick<PlatformPath, "join" | "dirname" | "resolve">, cwd: string): string[] {
	const ancestors: string[] = [];
	for (let path = paths.resolve(cwd); ; path = paths.dirname(path)) {
		ancestors.unshift(path);
		if (path === paths.dirname(path)) break;
	}
	return ancestors.map((path) => paths.join(path, "AGENTS.md"));
}

/**
 * Instructions and skills for a session: the global `AGENTS.md` of the data directory (always local), then the
 * project's `AGENTS.md` files and skills under `<directory>/skills` and `<cwd>/.pi/skills` on the local filesystem.
 */
export async function loadPromptResources(
	directory: string,
	cwd: string,
	files: PromptFiles = localFiles,
	skillsRoot = join(directory, "skills"),
	promptsRoot = join(directory, "prompts"),
): Promise<LoadedPrompt> {
	const agents: { text: string; global: boolean }[] = [];
	const fingerprint: string[] = [];
	const read = async (path: string, from: PromptFiles, isGlobal = false) => {
		const content = await from.readText(path);
		fingerprint.push(`${path}\n${content ?? ""}`);
		if (content !== undefined) agents.push({ text: `## ${path}\n${stripBom(content)}`, global: isGlobal });
	};
	const global = join(directory, "AGENTS.md");
	await read(global, localFiles, true);
	// The same path on a remote environment is another file: only a local session skips the global one it read.
	for (const path of agentsCandidates(files.paths, cwd))
		if (files !== localFiles || path !== global) await read(path, files);
	const skills = new Map<string, Skill>();
	const globalSkills = new Set(await skillFiles(files, skillsRoot));
	const paths = [...new Set([...globalSkills, ...(await skillFiles(files, files.paths.join(cwd, ".pi", "skills")))])];
	for (const path of paths) {
		const content = await files.readText(path);
		if (content === undefined) continue;
		fingerprint.push(`${path}\n${content}`);
		// pi's rules (`loadSkillFromFile`): a file whose frontmatter does not parse or has no description is skipped (a
		// README next to the skills, say); other spec violations, such as the name's characters or lengths, only warn in
		// pi and load here too. The name defaults to the parent directory's; the first skill of a name wins.
		let frontmatter: Record<string, unknown>;
		try {
			({ frontmatter } = parseFrontmatter(content));
		} catch {
			continue;
		}
		const description = frontmatter.description;
		if (typeof description !== "string" || !description.trim()) continue;
		const name =
			typeof frontmatter.name === "string" && frontmatter.name
				? frontmatter.name
				: files.paths.basename(files.paths.dirname(path));
		if (!skills.has(name))
			skills.set(name, {
				name,
				description,
				path,
				disabled: frontmatter["disable-model-invocation"] === true,
				global: globalSkills.has(path),
			});
	}
	// Prompt templates (pi's format): `.md` files directly in the global and the project's prompts directory. An
	// unreadable or invalid template is skipped (pi warns and goes on); symbolic links are not followed.
	const templates: PromptTemplate[] = [];
	for (const [root, source] of [
		[promptsRoot, "global"],
		[files.paths.join(cwd, ".pi", "prompts"), "project"],
	] as const) {
		const entries = (await files.entries(root)) ?? [];
		for (const entry of entries
			.filter((item) => item.kind === "file" && item.name.endsWith(".md"))
			.sort((a, b) => a.name.localeCompare(b.name))) {
			const path = files.paths.join(root, entry.name);
			const content = await files.readText(path).catch(() => undefined);
			if (content === undefined) continue;
			fingerprint.push(`${path}\n${content}`);
			try {
				const template = parseTemplate(entry.name, content, source, path);
				if (/^[^\s/]+$/.test(template.name)) templates.push(template);
			} catch {
				// Invalid frontmatter: skipped.
			}
		}
	}
	const assemble = (all: boolean) => {
		const kept = [...skills.values()].filter((skill) => all || !skill.global);
		const visible = kept.filter((skill) => !skill.disabled);
		return {
			agents: agents
				.filter((entry) => all || !entry.global)
				.map((entry) => entry.text)
				.join("\n\n"),
			skills:
				visible.length === 0
					? ""
					: [
							"Use the read tool to load a skill's file when the task matches its description.",
							"Resolve relative paths against the skill's directory.",
							"<available_skills>",
							...visible.map(
								(skill) =>
									`<skill><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description)}</description><location>${escapeXml(skill.path)}</location></skill>`,
							),
							"</available_skills>",
						].join("\n"),
			skillFiles: kept.map(({ name, description, path }) => ({
				name,
				description,
				path,
				baseDir: files.paths.dirname(path),
			})),
			templates: templates.filter((template) => all || template.source !== "global"),
		};
	};
	return { ...assemble(true), fingerprint: fingerprint.join("\n\0\n"), project: assemble(false) };
}
