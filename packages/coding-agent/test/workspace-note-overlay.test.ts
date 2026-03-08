import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURSOR_ACCENT_BG_ANSI, CURSOR_ACCENT_FG_ANSI } from "@kennyfrc/mu-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorkspaceNotesFilePath, WorkspaceNoteStore } from "../src/notes/workspace-note-store.js";
import { initTheme } from "../src/theme/theme.js";
import { WorkspaceNoteOverlayComponent } from "../src/tui/workspace-note-overlay.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

describe("WorkspaceNoteOverlayComponent", () => {
	let previousCwd: string;
	let previousConfigDir: string | undefined;
	let repoRoot: string;
	let nestedWorkspace: string;
	let configDir: string;

	beforeEach(() => {
		initTheme("dark");
		previousCwd = process.cwd();
		previousConfigDir = process.env.MU_CODING_AGENT_DIR;

		repoRoot = mkdtempSync(join(tmpdir(), "mu-workspace-note-overlay-"));
		nestedWorkspace = join(repoRoot, "apps", "demo");
		configDir = join(repoRoot, ".mu-agent-test");

		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		writeFileSync(join(repoRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
		mkdirSync(nestedWorkspace, { recursive: true });
		mkdirSync(configDir, { recursive: true });

		process.env.MU_CODING_AGENT_DIR = configDir;
		process.chdir(nestedWorkspace);
	});

	afterEach(() => {
		process.chdir(previousCwd);
		if (previousConfigDir === undefined) {
			delete process.env.MU_CODING_AGENT_DIR;
		} else {
			process.env.MU_CODING_AGENT_DIR = previousConfigDir;
		}
		rmSync(repoRoot, { recursive: true, force: true });
	});

	it("prefills the saved note, saves on enter, cancels on escape, and removes empty notes", () => {
		const store = new WorkspaceNoteStore({ cwd: nestedWorkspace });
		store.saveNote("Remember the docs before editing");

		let cancelCount = 0;
		const overlay = new WorkspaceNoteOverlayComponent({
			tui: { requestRender: () => undefined },
			workspaceLabel: repoRoot,
			initialText: store.getNote(),
			onSave: (text) => {
				store.saveNote(text);
			},
			onCancel: () => {
				cancelCount += 1;
			},
		});

		const initialRender = stripAnsi(overlay.render(80).join("\n"));
		const initialLines = initialRender.split("\n");
		const rawRender = overlay.render(80).join("\n");
		expect(initialRender).toContain("Workspace note");
		expect(initialRender).toContain("╭");
		expect(initialRender).toContain("╰");
		expect(initialRender).not.toContain("✦");
		expect(initialRender).not.toContain("░");
		expect(initialLines.some((line) => /^│ ─+ │$/.test(line))).toBe(false);
		expect(rawRender).toContain(`${CURSOR_ACCENT_FG_ANSI}${CURSOR_ACCENT_BG_ANSI}`);
		expect(rawRender).not.toContain("\x1b[4m");
		expect(rawRender).not.toContain("\x1b[7m");
		expect(rawRender).not.toContain("\x1b[0m");
		expect(
			initialLines.filter(
				(line) => line === "│                                                                              │",
			).length,
		).toBeGreaterThanOrEqual(4);
		expect(initialRender).toContain("Enter save");
		expect(initialRender).toContain("Remember the docs before editing");

		overlay.setText("Remember the docs before editing\nAnd run npm run check");
		overlay.handleInput("\r");
		expect(store.getNote()).toBe("Remember the docs before editing\nAnd run npm run check");

		const reopened = new WorkspaceNoteOverlayComponent({
			tui: { requestRender: () => undefined },
			workspaceLabel: repoRoot,
			initialText: store.getNote(),
			onSave: (text) => {
				store.saveNote(text);
			},
			onCancel: () => {
				cancelCount += 1;
			},
		});

		reopened.setText("Clear me with ctrl+c");
		reopened.handleInput("\x03");
		expect(reopened.getText()).toBe("");
		expect(cancelCount).toBe(0);

		reopened.setText("Throw this away");
		reopened.handleInput("\x1b");
		expect(cancelCount).toBe(1);
		expect(store.getNote()).toBe("Remember the docs before editing\nAnd run npm run check");

		const notesFile = getWorkspaceNotesFilePath();
		expect(existsSync(notesFile)).toBe(true);

		const cleared = new WorkspaceNoteOverlayComponent({
			tui: { requestRender: () => undefined },
			workspaceLabel: repoRoot,
			initialText: store.getNote(),
			onSave: (text) => {
				store.saveNote(text);
			},
			onCancel: () => {
				cancelCount += 1;
			},
		});

		cleared.setText("   ");
		cleared.handleInput("\r");
		expect(store.getNote()).toBe("");

		const savedFile = JSON.parse(readFileSync(notesFile, "utf8")) as {
			workspaces?: Record<string, unknown>;
		};
		expect(savedFile.workspaces ?? {}).toEqual({});
	});
});
