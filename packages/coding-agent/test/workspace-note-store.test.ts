import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface WorkspaceNoteAppendResult {
	anchor: string;
}

interface WorkspaceNoteStoreInstance {
	appendNote(text: string): WorkspaceNoteAppendResult | Promise<WorkspaceNoteAppendResult>;
}

interface WorkspaceNoteStoreModule {
	getWorkspaceNoteAnchor(text: string): string;
	getWorkspaceNotesFilePath(cwd?: string): string;
	WorkspaceNoteStore: new () => WorkspaceNoteStoreInstance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assertWorkspaceNoteStoreModule(value: unknown): asserts value is WorkspaceNoteStoreModule {
	if (!isRecord(value)) {
		throw new Error("workspace note store module did not load as an object");
	}

	if (typeof value.getWorkspaceNoteAnchor !== "function") {
		throw new Error("workspace note store module is missing getWorkspaceNoteAnchor(text)");
	}

	if (typeof value.getWorkspaceNotesFilePath !== "function") {
		throw new Error("workspace note store module is missing getWorkspaceNotesFilePath(cwd?)");
	}

	if (typeof value.WorkspaceNoteStore !== "function") {
		throw new Error("workspace note store module is missing WorkspaceNoteStore");
	}
}

function assertAppendResult(value: unknown): asserts value is WorkspaceNoteAppendResult {
	if (!isRecord(value) || typeof value.anchor !== "string") {
		throw new Error("appendNote() must return an object with a string anchor");
	}
}

async function loadWorkspaceNoteStoreModule(): Promise<WorkspaceNoteStoreModule> {
	const modulePath = "../src/notes/workspace-note-store.js";
	const loaded: unknown = await import(modulePath);
	assertWorkspaceNoteStoreModule(loaded);
	return loaded;
}

describe("WorkspaceNoteStore", () => {
	let previousCwd: string;
	let repoRoot: string;
	let nestedWorkspace: string;

	beforeEach(() => {
		previousCwd = process.cwd();
		repoRoot = mkdtempSync(join(tmpdir(), "mu-workspace-note-store-"));
		nestedWorkspace = join(repoRoot, "apps", "demo");

		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		writeFileSync(join(repoRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
		mkdirSync(nestedWorkspace, { recursive: true });

		process.chdir(repoRoot);
	});

	afterEach(() => {
		process.chdir(previousCwd);
		rmSync(repoRoot, { recursive: true, force: true });
	});

	it("persists appended notes on disk across store instances and uses one notes file per repo", async () => {
		const noteModule = await loadWorkspaceNoteStoreModule();
		const rootNotesFile = noteModule.getWorkspaceNotesFilePath();

		process.chdir(nestedWorkspace);
		expect(noteModule.getWorkspaceNotesFilePath()).toBe(rootNotesFile);

		const firstStore = new noteModule.WorkspaceNoteStore();
		const firstSave = await Promise.resolve(firstStore.appendNote("Remember to use rg before grep"));
		assertAppendResult(firstSave);

		const secondStore = new noteModule.WorkspaceNoteStore();
		const secondSave = await Promise.resolve(secondStore.appendNote("Remember to run npm run check"));
		assertAppendResult(secondSave);

		expect(existsSync(rootNotesFile)).toBe(true);

		const savedNotes = readFileSync(rootNotesFile, "utf8");
		expect(savedNotes).toContain("Remember to use rg before grep");
		expect(savedNotes).toContain("Remember to run npm run check");
		expect(firstSave.anchor).toBe(noteModule.getWorkspaceNoteAnchor("Remember to use rg before grep"));
		expect(secondSave.anchor).toBe(noteModule.getWorkspaceNoteAnchor("Remember to run npm run check"));
	});
});
