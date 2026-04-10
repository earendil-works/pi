import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@kennyfrc/mu-agent-core";
import { getModel } from "@kennyfrc/mu-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getArtifactMemoryProjectionPath } from "../src/memory/projection.js";
import { SettingsManager } from "../src/settings-manager.js";
import { initTheme } from "../src/theme/theme.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

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

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function writeProjection(workspaceRef: string, projection: WorkspaceProjection): void {
	const projectionPath = getArtifactMemoryProjectionPath(workspaceRef);
	mkdirSync(join(process.env.HOME ?? "", ".mu", "wiki", "projections"), { recursive: true });
	writeFileSync(projectionPath, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
}

async function makeRenderer(configDir: string): Promise<{
	stop(): void;
	ui: {
		render(width: number): string[];
	};
}> {
	initTheme("dark");
	const agent = new Agent({
		transport: {
			async *run() {
				yield* [];
			},
		} as never,
		initialState: {
			model: getModel("openai-codex", "gpt-5.4"),
			thinkingLevel: "medium",
		},
	});

	const renderer = new TuiRenderer(
		agent,
		{
			loadTitle: () => null,
			getSessionId: () => "workspace-memory-tui-index-test",
		} as never,
		new SettingsManager(configDir),
		{
			listCommands: () => [],
			getCommand: () => undefined,
			applyInputHooks: async (text: string) => ({ handled: false, text }),
			composeToolResultTransformer: <T>(base: T) => base,
			getIndicators: () => [],
		} as never,
		{} as never,
		"0.0.0",
	);

	await renderer.init();
	return renderer as unknown as {
		stop(): void;
		ui: { render(width: number): string[] };
	};
}

describe("workspace memory tui index", () => {
	const tempDirs: string[] = [];
	const originalHome = process.env.HOME;
	const originalCwd = process.cwd();

	afterEach(() => {
		process.env.HOME = originalHome;
		process.chdir(originalCwd);
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("renders index rows in startup chrome instead of summary prose", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "mu-workspace-memory-tui-"));
		const workspaceRef = join(tempHome, "workspace");
		const configDir = join(tempHome, "config");
		tempDirs.push(tempHome);
		mkdirSync(workspaceRef, { recursive: true });
		mkdirSync(configDir, { recursive: true });
		process.env.HOME = tempHome;
		process.chdir(workspaceRef);

		writeProjection(workspaceRef, {
			workspaceRef,
			entries: [{ id: "mem-1" }, { id: "mem-2" }],
			indexItems: [
				{
					id: "mem-1",
					kind: "note",
					label: "Workspace memory index",
					paths: ["devdocs/workspace-memory-index/SPEC.md"],
				},
				{
					id: "mem-2",
					kind: "note",
					label: "TUI startup task",
					paths: ["devdocs/workspace-memory-index/tasks/03-tui-index-display/TASK.yaml"],
				},
			],
			startupItems: [],
			startupSummary: "Long summary prose that must not appear in startup chrome.",
			meta: { totalEntries: 2, activeEntries: 2, deletedCount: 0, supersededCount: 0 },
		});

		const renderer = await makeRenderer(configDir);
		try {
			const output = stripAnsi(renderer.ui.render(100).join("\n"));
			expect(output).toContain("Workspace memory projection");
			expect(output).toContain("Workspace memory index — devdocs/workspace-memory-index/SPEC.md");
			expect(output).toContain(
				"TUI startup task — devdocs/workspace-memory-index/tasks/03-tui-index-display/TASK.yaml",
			);
			expect(output).not.toContain("Long summary prose that must not appear in startup chrome.");
		} finally {
			renderer.stop();
		}
	});

	it("preserves existing no-memory behavior for empty projections", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "mu-workspace-memory-tui-"));
		const workspaceRef = join(tempHome, "workspace");
		const configDir = join(tempHome, "config");
		tempDirs.push(tempHome);
		mkdirSync(workspaceRef, { recursive: true });
		mkdirSync(configDir, { recursive: true });
		process.env.HOME = tempHome;
		process.chdir(workspaceRef);

		writeProjection(workspaceRef, {
			workspaceRef,
			entries: [],
			indexItems: [],
			startupItems: [],
			startupSummary: "No stored memory for this workspace.",
			meta: { totalEntries: 0, activeEntries: 0, deletedCount: 0, supersededCount: 0 },
		});

		const renderer = await makeRenderer(configDir);
		try {
			const output = stripAnsi(renderer.ui.render(100).join("\n"));
			expect(output).not.toContain("Workspace memory projection");
			expect(output).not.toContain("No stored memory for this workspace.");
		} finally {
			renderer.stop();
		}
	});

	it("does not crash on legacy projection files without indexItems and rebuilds from entries", async () => {
		const tempHome = mkdtempSync(join(tmpdir(), "mu-workspace-memory-tui-"));
		const workspaceRef = join(tempHome, "workspace");
		const configDir = join(tempHome, "config");
		tempDirs.push(tempHome);
		mkdirSync(workspaceRef, { recursive: true });
		mkdirSync(configDir, { recursive: true });
		process.env.HOME = tempHome;
		process.chdir(workspaceRef);

		const projectionPath = getArtifactMemoryProjectionPath(workspaceRef);
		mkdirSync(join(process.env.HOME ?? "", ".mu", "wiki", "projections"), { recursive: true });
		writeFileSync(
			projectionPath,
			`${JSON.stringify(
				{
					workspaceRef,
					entries: [
						{
							id: "mem-legacy-1",
							kind: "artifact",
							summary: "Successfully wrote 120 bytes to docs/legacy.md",
							workspaceRef,
							artifacts: ["docs/legacy.md"],
							timestamp: new Date().toISOString(),
						},
					],
					startupItems: [],
					startupSummary: "Artifact\n- Wrote legacy.md",
					meta: { totalEntries: 1, activeEntries: 1, deletedCount: 0, supersededCount: 0 },
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		const renderer = await makeRenderer(configDir);
		try {
			const output = stripAnsi(renderer.ui.render(100).join("\n"));
			expect(output).toContain("Workspace memory projection");
			expect(output).toContain("Wrote legacy.md — docs/legacy.md");
		} finally {
			renderer.stop();
		}
	});
});
