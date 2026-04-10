import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getArtifactMemoryProjectionPath } from "../src/memory/projection.js";
import { loadWorkspaceMemoryProjection } from "../src/project-context.js";
import { buildSystemPromptSections } from "../src/prompts/index.js";

interface WorkspaceProjection {
	workspaceRef: string;
	entries: unknown[];
	indexItems: Array<{
		id: string;
		kind: string;
		label: string;
		paths: string[];
	}>;
	startupItems: unknown[];
	startupSummary: string;
	meta: {
		totalEntries: number;
		activeEntries: number;
		deletedCount: number;
		supersededCount: number;
	};
}

describe("workspace memory prompt context index", () => {
	const tempDirs: string[] = [];
	const originalHome = process.env.HOME;

	afterEach(() => {
		process.env.HOME = originalHome;
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function writeProjection(workspaceRef: string, projection: WorkspaceProjection): void {
		const projectionPath = getArtifactMemoryProjectionPath(workspaceRef);
		mkdirSync(join(process.env.HOME ?? "", ".mu", "wiki", "projections"), { recursive: true });
		writeFileSync(projectionPath, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
	}

	it("renders index rows into prompt context without injecting long summary prose", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "mu-workspace-memory-context-"));
		tempDirs.push(tempHome);
		process.env.HOME = tempHome;
		const workspaceRef = join(tempHome, "workspace");

		writeProjection(workspaceRef, {
			workspaceRef,
			entries: [],
			indexItems: [
				{
					id: "mem-1",
					kind: "note",
					label: "Workspace memory index",
					paths: ["devdocs/workspace-memory-index/SPEC.md"],
				},
			],
			startupItems: [],
			startupSummary:
				"Workspace memory index\n\nExtra long summary prose that should not appear in prompt context because the prompt should render the index view only.",
			meta: { totalEntries: 1, activeEntries: 1, deletedCount: 0, supersededCount: 0 },
		});

		const projectionContext = loadWorkspaceMemoryProjection(workspaceRef);
		expect(projectionContext).not.toBeNull();
		const sections = await buildSystemPromptSections({
			cwd: workspaceRef,
			includeFileTree: false,
			contextFiles: projectionContext ? [{ ...projectionContext, scope: "project" }] : [],
		});

		expect(sections.contextFiles).toContain("Workspace memory index");
		expect(sections.contextFiles).toContain("`devdocs/workspace-memory-index/SPEC.md`");
		expect(sections.contextFiles).not.toContain("Extra long summary prose");
	});

	it("renders multiple paths legibly in prompt context", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "mu-workspace-memory-context-"));
		tempDirs.push(tempHome);
		process.env.HOME = tempHome;
		const workspaceRef = join(tempHome, "workspace");

		writeProjection(workspaceRef, {
			workspaceRef,
			entries: [],
			indexItems: [
				{
					id: "mem-2",
					kind: "note",
					label: "Prompt index context",
					paths: [
						"devdocs/workspace-memory-index/SPEC.md",
						"devdocs/workspace-memory-index/tasks/02-prompt-index-context/TASK.yaml",
					],
				},
			],
			startupItems: [],
			startupSummary: "Should stay out of prompt context.",
			meta: { totalEntries: 1, activeEntries: 1, deletedCount: 0, supersededCount: 0 },
		});

		const projectionContext = loadWorkspaceMemoryProjection(workspaceRef);
		expect(projectionContext?.content).toContain(
			"`devdocs/workspace-memory-index/SPEC.md`, `devdocs/workspace-memory-index/tasks/02-prompt-index-context/TASK.yaml`",
		);
	});

	it("returns null when no workspace projection exists", () => {
		const tempHome = mkdtempSync(join(tmpdir(), "mu-workspace-memory-context-"));
		tempDirs.push(tempHome);
		process.env.HOME = tempHome;
		const workspaceRef = join(tempHome, "workspace");

		expect(loadWorkspaceMemoryProjection(workspaceRef)).toBeNull();
	});
});
