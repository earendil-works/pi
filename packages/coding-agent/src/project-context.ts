import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	getArtifactMemoryProjectionPath,
	normalizeWorkspaceProjection,
	type WorkspaceProjection,
} from "./memory/projection.js";

export type ContextFile = { path: string; content: string; scope: "user" | "project" };

function formatWorkspaceMemoryProjection(projection: WorkspaceProjection): string {
	if (projection.indexItems.length === 0) {
		return `# Workspace Memory Projection

**Workspace:** ${projection.workspaceRef}

No stored memory for this workspace.`;
	}

	const indexRows = projection.indexItems.map((item) => {
		const paths = item.paths.length > 0 ? item.paths.map((path) => `\`${path}\``).join(", ") : "(no paths)";
		return `- ${item.label} — ${paths}`;
	});

	return `# Workspace Memory Projection

**Workspace:** ${projection.workspaceRef}

${indexRows.join("\n")}`;
}

/**
 * Look for AGENTS.md or CLAUDE.md in a directory (prefers AGENTS.md).
 */
export function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.md", "CLAUDE.md"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (!existsSync(filePath)) continue;
		try {
			return {
				path: filePath,
				content: readFileSync(filePath, "utf-8"),
			};
		} catch {}
	}
	return null;
}

export function loadWorkspaceMemoryProjection(cwd: string): { path: string; content: string } | null {
	const projectionPath = getArtifactMemoryProjectionPath(cwd);
	if (!existsSync(projectionPath)) {
		return null;
	}
	try {
		const projection = normalizeWorkspaceProjection(
			JSON.parse(readFileSync(projectionPath, "utf-8")) as WorkspaceProjection,
		);
		return {
			path: projectionPath,
			content: formatWorkspaceMemoryProjection(projection),
		};
	} catch {
		return null;
	}
}

/**
 * Load all project context files in order:
 * 1. Global: ~/.mu/agent/AGENTS.md or CLAUDE.md
 * 2. Parent directories (top-most first) down to cwd
 * 3. Workspace memory projection (derived from ~/.mu/wiki/)
 */
export function loadProjectContextFiles(cwd: string = process.cwd()): ContextFile[] {
	const contextFiles: ContextFile[] = [];

	const homeDir = homedir();
	const globalContextDir = resolve(process.env.MU_CODING_AGENT_DIR || join(homeDir, ".mu/agent/"));
	const globalContext = loadContextFileFromDir(globalContextDir);
	if (globalContext) {
		contextFiles.push({ ...globalContext, scope: "user" });
	}

	const ancestorContextFiles: ContextFile[] = [];
	let currentDir = resolve(cwd);
	const root = resolve("/");

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile) {
			ancestorContextFiles.unshift({ ...contextFile, scope: "project" });
		}
		if (currentDir === root) break;
		const parentDir = resolve(currentDir, "..");
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	const memoryProjection = loadWorkspaceMemoryProjection(resolve(cwd));
	if (memoryProjection) {
		contextFiles.push({ ...memoryProjection, scope: "project" });
	}

	return contextFiles;
}
