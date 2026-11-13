import type * as FsModule from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import {
	type CustomEntry,
	getDefaultSessionDir,
	loadEntriesFromFile,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const fsFaults = vi.hoisted(() => ({
	failWriteAtCall: 0,
	failCloseOnce: false,
	closeThenThrowOnce: false,
}));

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof FsModule>();
	return {
		...actual,
		writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
			if (fsFaults.failWriteAtCall > 0) {
				fsFaults.failWriteAtCall -= 1;
				if (fsFaults.failWriteAtCall === 0) throw new Error("mocked partial write failure");
			}
			return actual.writeFileSync(...args);
		},
		closeSync: (fd: number) => {
			if (fsFaults.failCloseOnce) {
				fsFaults.failCloseOnce = false;
				throw new Error("mocked close failure");
			}
			if (fsFaults.closeThenThrowOnce) {
				fsFaults.closeThenThrowOnce = false;
				actual.closeSync(fd);
				throw new Error("mocked close failure after release");
			}
			return actual.closeSync(fd);
		},
	};
});

let tempRoot: string;
let projectDir: string;
let saveDir: string;

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "pi-save-in-place-"));
	projectDir = join(tempRoot, "project");
	saveDir = join(tempRoot, "saved-sessions");
	mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
	fsFaults.failWriteAtCall = 0;
	fsFaults.failCloseOnce = false;
	fsFaults.closeThenThrowOnce = false;
	vi.unstubAllEnvs();
	rmSync(tempRoot, { recursive: true, force: true });
});

/** The file name the save convention derives from the existing header and session ID. */
function expectedFileName(session: SessionManager): string {
	const header = session.getHeader();
	if (!header) throw new Error("session has no header");
	return `${header.timestamp.replace(/[:.]/g, "-")}_${session.getSessionId()}.jsonl`;
}

function readRaw(file: string): string {
	return readFileSync(file, "utf-8");
}

function positionMarkers(file: string): CustomEntry<{ leafId: string | null }>[] {
	return loadEntriesFromFile(file).filter(
		(entry): entry is CustomEntry<{ leafId: string | null }> =>
			entry.type === "custom" && entry.customType === "pi.save-position",
	);
}

describe("SessionManager.saveInPlace", () => {
	it("returns empty for a session without a user or assistant message and creates no directory", () => {
		const session = SessionManager.inMemory(projectDir, undefined, undefined, saveDir);
		session.appendThinkingLevelChange("high");
		session.appendCustomEntry("ext-state", { count: 1 });

		expect(session.saveInPlace()).toEqual({ status: "empty" });
		expect(existsSync(saveDir)).toBe(false);
		expect(session.isPersisted()).toBe(false);
		expect(session.getSessionFile()).toBeUndefined();
	});

	it("writes the whole tree with the existing header, ID, timestamp, and cwd", () => {
		// #10768
		const session = SessionManager.inMemory(projectDir, { id: "temp-save" }, undefined, saveDir);
		const headerBefore = session.getHeader();
		if (!headerBefore) throw new Error("session has no header");
		session.appendModelChange("anthropic", "test-model");
		const user1 = session.appendMessage(userMsg("first prompt"));
		const assistant1 = session.appendMessage(assistantMsg("first reply"));
		session.appendLabelChange(assistant1, "keep-this");
		session.branch(user1);
		const user2 = session.appendMessage(userMsg("alternate prompt"));
		const assistant2 = session.appendMessage(assistantMsg("alternate reply"));
		session.appendCustomEntry("ext-state", { branch: 2 });
		session.appendSessionInfo("kept name");

		const result = session.saveInPlace();

		expect(result).toEqual({ status: "saved", sessionFile: join(saveDir, expectedFileName(session)) });
		if (result.status !== "saved") throw new Error("expected a saved session");

		const entries = loadEntriesFromFile(result.sessionFile);
		const header = entries[0];
		if (header?.type !== "session") throw new Error("saved file has no session header");
		expect(header).toMatchObject({
			type: "session",
			id: headerBefore.id,
			timestamp: headerBefore.timestamp,
			cwd: headerBefore.cwd,
		});
		expect(header.version).toBe(headerBefore.version);
		expect(entries).toHaveLength(session.getEntries().length + 1);

		const reopened = SessionManager.open(result.sessionFile);
		expect(reopened.getSessionId()).toBe("temp-save");
		expect(reopened.getHeader()).toMatchObject({ timestamp: headerBefore.timestamp, cwd: projectDir });
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual(session.getEntries().map((entry) => entry.id));
		// Both children of the first prompt survive the save.
		expect(
			reopened
				.getChildren(user1)
				.map((entry) => entry.id)
				.sort(),
		).toEqual([assistant1, user2].sort());
		expect(reopened.getLabel(assistant1)).toBe("keep-this");
		expect(reopened.getSessionName()).toBe("kept name");
		expect(assistant2).toBeDefined();
		expect(positionMarkers(result.sessionFile)).toEqual([]);
	});

	it("records a non-last active leaf with one position marker and reopens the same context", () => {
		// #10768
		const session = SessionManager.inMemory(projectDir, undefined, undefined, saveDir);
		const user1 = session.appendMessage(userMsg("first prompt"));
		const modelChangeId = session.appendModelChange("anthropic", "claude-test");
		const thinkingChangeId = session.appendThinkingLevelChange("high");
		const assistant1 = session.appendMessage(assistantMsg("first reply"));
		const user2 = session.appendMessage(userMsg("second prompt"));
		session.appendMessage(assistantMsg("second reply"));
		session.branch(assistant1);

		const contextBefore = session.buildSessionContext();
		expect(contextBefore.thinkingLevel).toBe("high");
		expect(contextBefore.model).toEqual({ provider: "anthropic", modelId: "test" });
		expect(contextBefore.messages).toHaveLength(2);
		const result = session.saveInPlace();
		if (result.status !== "saved") throw new Error(`expected a saved session, got ${result.status}`);

		const markers = positionMarkers(result.sessionFile);
		expect(markers).toHaveLength(1);
		const [marker] = markers;
		expect(marker.parentId).toBe(assistant1);
		expect(marker.data).toEqual({ leafId: assistant1 });

		const reopened = SessionManager.open(result.sessionFile);
		expect(reopened.getLeafId()).toBe(marker.id);
		expect(reopened.buildSessionContext()).toEqual(contextBefore);
		expect(reopened.getBranch().map((entry) => entry.id)).toEqual([
			user1,
			modelChangeId,
			thinkingChangeId,
			assistant1,
			marker.id,
		]);
		expect(user2).toBeDefined();
	});

	it("adds no marker when the active leaf is the last entry", () => {
		const session = SessionManager.inMemory(projectDir, undefined, undefined, saveDir);
		session.appendMessage(userMsg("prompt"));
		const assistant = session.appendMessage(assistantMsg("reply"));

		const result = session.saveInPlace();
		if (result.status !== "saved") throw new Error(`expected a saved session, got ${result.status}`);

		expect(positionMarkers(result.sessionFile)).toEqual([]);
		expect(SessionManager.open(result.sessionFile).getLeafId()).toBe(assistant);
	});

	it("reopens with an empty context after the leaf was reset to the root", () => {
		const session = SessionManager.inMemory(projectDir, undefined, undefined, saveDir);
		session.appendMessage(userMsg("prompt"));
		session.appendMessage(assistantMsg("reply"));
		session.resetLeaf();

		const result = session.saveInPlace();
		if (result.status !== "saved") throw new Error(`expected a saved session, got ${result.status}`);

		const [marker] = positionMarkers(result.sessionFile);
		expect(marker.parentId).toBeNull();
		expect(marker.data).toEqual({ leafId: null });

		const reopened = SessionManager.open(result.sessionFile);
		expect(reopened.buildSessionContext().messages).toEqual([]);
		expect(reopened.getLeafId()).toBe(marker.id);
	});

	it("autosaves appends after the initial save", () => {
		const session = SessionManager.inMemory(projectDir, undefined, undefined, saveDir);
		session.appendMessage(userMsg("prompt"));
		const result = session.saveInPlace();
		if (result.status !== "saved") throw new Error(`expected a saved session, got ${result.status}`);

		session.appendMessage(userMsg("after save"));

		const reopened = SessionManager.open(result.sessionFile);
		expect(reopened.getEntries()).toHaveLength(2);
		expect(readRaw(result.sessionFile)).toContain("after save");
		expect(session.isPersisted()).toBe(true);
	});

	it("reports already saved without changing the file or adding a marker", () => {
		const session = SessionManager.inMemory(projectDir, undefined, undefined, saveDir);
		session.appendMessage(userMsg("prompt"));
		session.appendMessage(assistantMsg("reply"));
		session.branch(session.getEntries()[0].id);

		const first = session.saveInPlace();
		if (first.status !== "saved") throw new Error(`expected a saved session, got ${first.status}`);
		const mtimeBefore = statSync(first.sessionFile).mtimeMs;
		const contentBefore = readRaw(first.sessionFile);

		expect(session.saveInPlace()).toEqual({ status: "already-saved", sessionFile: first.sessionFile });
		expect(statSync(first.sessionFile).mtimeMs).toBe(mtimeBefore);
		expect(readRaw(first.sessionFile)).toBe(contentBefore);
		expect(positionMarkers(first.sessionFile)).toHaveLength(1);
	});

	it("never claims an unsaved persistent session is on disk", () => {
		const session = SessionManager.create(projectDir, saveDir);
		const target = join(saveDir, expectedFileName(session));

		expect(session.saveInPlace()).toEqual({ status: "empty" });
		expect(existsSync(target)).toBe(false);
	});

	it("writes a persistent session again when its file disappeared", () => {
		const session = SessionManager.create(projectDir, saveDir);
		session.appendMessage(userMsg("prompt"));
		session.appendMessage(assistantMsg("reply"));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("expected a persistent session file");
		rmSync(sessionFile);

		expect(session.saveInPlace()).toEqual({ status: "saved", sessionFile });
		expect(loadEntriesFromFile(sessionFile).map((entry) => entry.type)).toEqual(["session", "message", "message"]);
	});

	it("returns already saved for a persistent session that is already on disk", () => {
		const session = SessionManager.create(projectDir, saveDir);
		session.appendMessage(userMsg("prompt"));
		session.appendMessage(assistantMsg("reply"));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("expected a persistent session file");
		const mtimeBefore = statSync(sessionFile).mtimeMs;

		expect(session.saveInPlace()).toEqual({ status: "already-saved", sessionFile });
		expect(statSync(sessionFile).mtimeMs).toBe(mtimeBefore);
	});

	it("leaves a pre-existing file untouched on a name collision and succeeds on retry", () => {
		const session = SessionManager.inMemory(projectDir, { id: "collision" }, undefined, saveDir);
		session.appendMessage(userMsg("prompt"));
		mkdirSync(saveDir, { recursive: true });
		const target = join(saveDir, expectedFileName(session));
		writeFileSync(target, "sentinel\n");

		expect(() => session.saveInPlace()).toThrow(target);
		expect(readRaw(target)).toBe("sentinel\n");
		expect(session.isPersisted()).toBe(false);
		expect(session.getSessionFile()).toBeUndefined();
		expect(session.getSessionDir()).toBe("");

		rmSync(target);
		expect(session.saveInPlace()).toEqual({ status: "saved", sessionFile: target });
		expect(readRaw(target)).toContain('"type":"session"');
	});

	it("refuses to save a second file for a session ID that already exists", () => {
		// #10768
		const session = SessionManager.inMemory(projectDir, { id: "duplicate-id" }, undefined, saveDir);
		session.appendMessage(userMsg("prompt"));
		mkdirSync(saveDir, { recursive: true });
		// A different timestamp means a different file name, so this is not the target path.
		const existing = join(saveDir, `2020-01-01T00-00-00-000Z_duplicate-id.jsonl`);
		writeFileSync(
			existing,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "duplicate-id",
				timestamp: "2020-01-01T00:00:00.000Z",
				cwd: projectDir,
			})}\n`,
		);
		const contentBefore = readRaw(existing);
		const target = join(saveDir, expectedFileName(session));
		expect(target).not.toBe(existing);

		expect(() => session.saveInPlace()).toThrow(`Session duplicate-id already exists at ${existing}`);
		expect(readRaw(existing)).toBe(contentBefore);
		expect(existsSync(target)).toBe(false);
		expect(session.isPersisted()).toBe(false);
		expect(session.getSessionFile()).toBeUndefined();
		expect(session.getSessionDir()).toBe("");

		// The failed save leaves the conversation usable; removing the duplicate allows a retry.
		session.appendMessage(assistantMsg("reply"));
		expect(session.getEntries()).toHaveLength(2);
		rmSync(existing);
		expect(session.saveInPlace()).toEqual({ status: "saved", sessionFile: target });
	});

	it("names the target when the session directory cannot be created", () => {
		const blockedDir = join(tempRoot, "blocked-sessions");
		writeFileSync(blockedDir, "not a directory\n");
		const session = SessionManager.inMemory(projectDir, undefined, undefined, blockedDir);
		session.appendMessage(userMsg("prompt"));
		const target = join(blockedDir, expectedFileName(session));

		expect(() => session.saveInPlace()).toThrow(`Could not write session file ${target}`);
		expect(session.isPersisted()).toBe(false);
		expect(readRaw(blockedDir)).toBe("not a directory\n");
	});

	it("rolls back a staged position marker after a partial write failure and adds one marker on retry", () => {
		// #10768
		const session = SessionManager.inMemory(projectDir, undefined, undefined, saveDir);
		session.appendMessage(userMsg("prompt"));
		session.appendMessage(assistantMsg("reply"));
		const leafBefore = session.getEntries()[0].id;
		session.branch(leafBefore);
		const entriesBefore = session.getEntries().map((entry) => entry.id);
		mkdirSync(saveDir, { recursive: true });
		const unrelated = join(saveDir, "unrelated.txt");
		writeFileSync(unrelated, "keep me\n");
		const target = join(saveDir, expectedFileName(session));

		// Two complete JSONL lines reach the file before the third write fails.
		fsFaults.failWriteAtCall = 3;
		expect(() => session.saveInPlace()).toThrow(`Could not write session file ${target}`);

		expect(existsSync(target)).toBe(false);
		expect(readRaw(unrelated)).toBe("keep me\n");
		expect(session.isPersisted()).toBe(false);
		expect(session.getSessionFile()).toBeUndefined();
		expect(session.getSessionDir()).toBe("");
		expect(session.getLeafId()).toBe(leafBefore);
		expect(session.getEntries().map((entry) => entry.id)).toEqual(entriesBefore);
		// The staged pi.save-position marker never entered memory or the leaf pointer.
		expect(session.getEntries().some((entry) => entry.type === "custom")).toBe(false);

		expect(session.saveInPlace()).toEqual({ status: "saved", sessionFile: target });
		const markers = positionMarkers(target);
		expect(markers).toHaveLength(1);
		expect(markers[0].parentId).toBe(leafBefore);
		expect(markers[0].data).toEqual({ leafId: leafBefore });
		expect(session.getLeafId()).toBe(markers[0].id);
	});

	it("removes the new file when closing it fails and succeeds on retry", () => {
		const session = SessionManager.inMemory(projectDir, undefined, undefined, saveDir);
		session.appendMessage(userMsg("prompt"));
		const target = join(saveDir, expectedFileName(session));

		fsFaults.failCloseOnce = true;
		expect(() => session.saveInPlace()).toThrow(`Could not write session file ${target}`);
		expect(existsSync(target)).toBe(false);
		expect(session.isPersisted()).toBe(false);

		expect(session.saveInPlace()).toEqual({ status: "saved", sessionFile: target });
		expect(existsSync(target)).toBe(true);
	});

	it("does not report a cleanup failure when the failed close already released the descriptor", () => {
		const session = SessionManager.inMemory(projectDir, undefined, undefined, saveDir);
		session.appendMessage(userMsg("prompt"));
		const target = join(saveDir, expectedFileName(session));

		let thrownMessage = "";
		fsFaults.closeThenThrowOnce = true;
		try {
			session.saveInPlace();
		} catch (error) {
			thrownMessage = error instanceof Error ? error.message : String(error);
		}

		// The cleanup close hits EBADF on the released descriptor and must be ignored.
		expect(thrownMessage).toBe(`Could not write session file ${target}: mocked close failure after release`);
		expect(existsSync(target)).toBe(false);
		expect(session.isPersisted()).toBe(false);
		expect(session.saveInPlace()).toEqual({ status: "saved", sessionFile: target });
	});

	it("saves into an explicit future target without creating the default session directory", () => {
		vi.stubEnv(ENV_AGENT_DIR, join(tempRoot, "agent"));
		const session = SessionManager.inMemory(projectDir, undefined, undefined, saveDir);
		session.appendMessage(userMsg("prompt"));

		const result = session.saveInPlace();
		if (result.status !== "saved") throw new Error(`expected a saved session, got ${result.status}`);

		expect(result.sessionFile).toBe(join(saveDir, expectedFileName(session)));
		expect(existsSync(join(getDefaultSessionDir(projectDir), expectedFileName(session)))).toBe(false);
		expect(session.getSessionDir()).toBe(saveDir);
		expect(session.getSessionFile()).toBe(result.sessionFile);
		expect(session.isPersisted()).toBe(true);
		expect(session.usesDefaultSessionDir()).toBe(false);
		expect(session.getSaveSessionDir()).toBeUndefined();
	});

	it("saves into the default session directory when no future target is configured", () => {
		const agentDir = join(tempRoot, "agent");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const session = SessionManager.inMemory(projectDir);
		session.appendMessage(userMsg("prompt"));

		const result = session.saveInPlace();
		if (result.status !== "saved") throw new Error(`expected a saved session, got ${result.status}`);

		expect(result.sessionFile).toBe(join(getDefaultSessionDir(projectDir), expectedFileName(session)));
		expect(session.getSessionDir()).toBe(getDefaultSessionDir(projectDir));
		expect(session.usesDefaultSessionDir()).toBe(true);
		expect(session.isPersisted()).toBe(true);
	});
});
