import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "../../config.js";
import { HttpError } from "./http.js";
import type { SkillWriteRequest, WebSkill } from "./types.js";

export function skillsRoot(): string {
	return path.join(getAgentDir(), "skills");
}

export function parseSkillMarkdown(content: string, fallbackName: string): Omit<WebSkill, "path"> {
	const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
	const meta: Record<string, string> = {};
	if (match) {
		for (const line of match[1].split(/\r?\n/)) {
			const index = line.indexOf(":");
			if (index > 0) meta[line.slice(0, index).trim()] = line.slice(index + 1).trim();
		}
	}
	const heading = content.match(/^#\s+(.+)$/m);
	return {
		name: meta.name || fallbackName || heading?.[1] || "Untitled skill",
		description: meta.description || "",
		meta,
		body: content.replace(/^---\n[\s\S]*?\n---\n?/, ""),
		content,
	};
}

export function skillSlug(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

export async function listWebSkills(root = skillsRoot()): Promise<WebSkill[]> {
	const skills: WebSkill[] = [];
	let entries: Array<import("node:fs").Dirent>;
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skillPath = path.join(root, entry.name, "SKILL.md");
		try {
			const content = await fs.readFile(skillPath, "utf8");
			skills.push({ ...parseSkillMarkdown(content, entry.name), path: skillPath });
		} catch {
			// Ignore incomplete skill directories.
		}
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function writeWebSkill(
	input: SkillWriteRequest,
	method: "POST" | "PUT",
	root = skillsRoot(),
): Promise<WebSkill> {
	if (typeof input.name !== "string") throw new HttpError(400, "Missing skill name");
	if (typeof input.description !== "string") throw new HttpError(400, "Missing skill description");
	if (typeof input.content !== "string") throw new HttpError(400, "Missing skill content");
	const name = input.name.trim();
	const description = input.description.trim();
	const content = input.content.trim();
	const slug = skillSlug(name);
	if (!slug) throw new HttpError(400, "Missing skill name");
	if (!description) throw new HttpError(400, "Missing skill description");
	if (!content) throw new HttpError(400, "Missing skill content");

	let filePath = path.join(root, slug, "SKILL.md");
	if (method === "POST") {
		try {
			await fs.mkdir(root, { recursive: true });
			await fs.mkdir(path.dirname(filePath), { recursive: false });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST")
				throw new HttpError(400, `Skill already exists: ${slug}`);
			throw error;
		}
	} else {
		filePath = resolveSkillPath(input.path, root);
		await fs.stat(filePath);
	}
	await fs.writeFile(filePath, content, "utf8");
	return { ...parseSkillMarkdown(content, slug), path: filePath };
}

export async function deleteWebSkill(skillPath: string | undefined, root = skillsRoot()): Promise<void> {
	const filePath = resolveSkillPath(skillPath, root);
	await fs.rm(path.dirname(filePath), { recursive: true, force: true });
}

export function resolveSkillPath(skillPath: string | undefined, root = skillsRoot()): string {
	if (!skillPath) throw new HttpError(400, "Missing skill path");
	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(skillPath);
	if (!resolved.startsWith(`${resolvedRoot}${path.sep}`) || path.basename(resolved) !== "SKILL.md") {
		throw new HttpError(400, "Invalid skill path");
	}
	return resolved;
}
