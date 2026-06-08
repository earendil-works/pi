import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	FILE_CHECKPOINT_TYPE,
	FileCheckpointStore,
	type FileCheckpointStoreOptions,
} from "../src/core/file-checkpoint-store.ts";

interface FakeEntry {
	type: string;
	id: string;
	parentId: string | null;
	customType?: string;
	data?: unknown;
}

/** Minimal in-memory stand-in for SessionManager's append-only tree. */
class FakeSession {
	entries: FakeEntry[] = [];
	leaf: string | null = null;
	private counter = 0;

	private append(entry: FakeEntry): void {
		entry.parentId = this.leaf;
		this.leaf = entry.id;
		this.entries.push(entry);
	}

	appendUser(id: string): void {
		this.append({ type: "message", id, parentId: null });
	}

	appendCustomEntry = (customType: string, data: unknown): string => {
		const id = `custom-${this.counter++}`;
		this.append({ type: "custom", id, parentId: null, customType, data });
		return id;
	};

	getEntries = (): FakeEntry[] => this.entries;

	getBranch = (fromId: string): FakeEntry[] => {
		const byId = new Map(this.entries.map((e) => [e.id, e]));
		const path: FakeEntry[] = [];
		let current = byId.get(fromId);
		while (current) {
			path.unshift(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		return path;
	};
}

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-file-checkpoint-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createStore(opts?: { isStreaming?: () => boolean }): Promise<{
	store: FileCheckpointStore;
	session: FakeSession;
	cwd: string;
}> {
	const cwd = await createTempDir();
	const session = new FakeSession();
	// FakeEntry mirrors only the fields the store reads; cast through unknown.
	const options = {
		sessionId: "test-session",
		cwd,
		checkpointsRoot: join(cwd, ".checkpoints"),
		appendCustomEntry: session.appendCustomEntry,
		getEntries: session.getEntries,
		getBranch: session.getBranch,
		isStreaming: opts?.isStreaming ?? (() => false),
	} as unknown as FileCheckpointStoreOptions;
	return { store: new FileCheckpointStore(options), session, cwd };
}

describe("FileCheckpointStore", () => {
	it("captures one manifest per turn and restores files to the target state", async () => {
		const { store, session, cwd } = await createStore();
		const fileA = join(cwd, "a.txt");
		writeFileSync(fileA, "v0");

		// Turn 1: v0 -> v1
		session.appendUser("u1");
		store.beginTurn("u1");
		await store.wrapEditOperations().writeFile(fileA, "v1");

		// Turn 2: v1 -> v2
		session.appendUser("u2");
		store.beginTurn("u2");
		await store.wrapEditOperations().writeFile(fileA, "v2");

		expect(readFileSync(fileA, "utf-8")).toBe("v2");

		// Restore to before turn 1 -> v0
		const summary = await store.restoreTo("u1", "u2");
		expect(readFileSync(fileA, "utf-8")).toBe("v0");
		expect(summary.restored).toEqual(["a.txt"]);

		const manifests = session.entries.filter((e) => e.type === "custom" && e.customType === FILE_CHECKPOINT_TYPE);
		expect(manifests).toHaveLength(2);
	});

	it("dedups multiple edits to the same file within a turn (first-touch wins)", async () => {
		const { store, session, cwd } = await createStore();
		const fileA = join(cwd, "a.txt");
		writeFileSync(fileA, "v0");

		session.appendUser("u1");
		store.beginTurn("u1");
		await store.wrapEditOperations().writeFile(fileA, "v1");
		await store.wrapEditOperations().writeFile(fileA, "v2");

		// Restore to before u1 -> should be v0 (the first-touch baseline), not v1
		await store.restoreTo("u1", "u1");
		expect(readFileSync(fileA, "utf-8")).toBe("v0");
	});

	it("deletes files that were newly created after the target (absent sentinel)", async () => {
		const { store, session, cwd } = await createStore();
		const fileB = join(cwd, "b.txt");

		session.appendUser("u1");
		store.beginTurn("u1");
		// New file created this turn
		await store.wrapWriteOperations().writeFile(fileB, "new");
		expect(existsSync(fileB)).toBe(true);

		const summary = await store.restoreTo("u1", "u1");
		expect(existsSync(fileB)).toBe(false);
		expect(summary.deleted).toEqual(["b.txt"]);
	});

	it("skips files changed outside pi (external-edit guard)", async () => {
		const { store, session, cwd } = await createStore();
		const fileA = join(cwd, "a.txt");
		writeFileSync(fileA, "v0");

		session.appendUser("u1");
		store.beginTurn("u1");
		await store.wrapEditOperations().writeFile(fileA, "v1");

		// User hand-edits the file outside pi after pi wrote it
		writeFileSync(fileA, "hand-edited");

		const summary = await store.restoreTo("u1", "u1");
		expect(readFileSync(fileA, "utf-8")).toBe("hand-edited");
		expect(summary.skippedExternal).toEqual(["a.txt"]);
		expect(summary.restored).toEqual([]);
	});

	it("counts files already at the target state as unchanged", async () => {
		const { store, session, cwd } = await createStore();
		const fileA = join(cwd, "a.txt");
		writeFileSync(fileA, "v0");

		session.appendUser("u1");
		store.beginTurn("u1");
		await store.wrapEditOperations().writeFile(fileA, "v1");

		// Manually put it back to the pre-turn state, then restore: nothing to do
		writeFileSync(fileA, "v0");
		const summary = await store.restoreTo("u1", "u1");
		expect(summary.unchanged).toBe(1);
		expect(summary.restored).toEqual([]);
		expect(summary.skippedExternal).toEqual([]);
	});

	it("refuses to restore while the agent is streaming", async () => {
		const { store, session, cwd } = await createStore({ isStreaming: () => true });
		const fileA = join(cwd, "a.txt");
		writeFileSync(fileA, "v0");
		session.appendUser("u1");
		store.beginTurn("u1");
		await store.wrapEditOperations().writeFile(fileA, "v1");

		await expect(store.restoreTo("u1", "u1")).rejects.toThrow(/agent is running/);
	});

	it("rolls back the capture when the write fails (no phantom manifest)", async () => {
		const { store, session, cwd } = await createStore();
		// A regular file used as a fake parent dir -> writing under it throws ENOTDIR.
		const blocker = join(cwd, "blocker");
		writeFileSync(blocker, "i am a file, not a dir");
		const badPath = join(blocker, "child.txt");

		session.appendUser("u1");
		store.beginTurn("u1");
		await expect(store.wrapWriteOperations().writeFile(badPath, "x")).rejects.toThrow();

		// The failed write must not leave a captured entry behind.
		store.flushPending();
		const manifests = session.entries.filter((e) => e.type === "custom" && e.customType === FILE_CHECKPOINT_TYPE);
		expect(manifests).toHaveLength(0);
	});

	it("keeps a prior successful capture when a later write in the turn fails", async () => {
		const { store, session, cwd } = await createStore();
		const fileA = join(cwd, "a.txt");
		writeFileSync(fileA, "v0");
		const blocker = join(cwd, "blocker");
		writeFileSync(blocker, "file");
		const badPath = join(blocker, "child.txt");

		session.appendUser("u1");
		store.beginTurn("u1");
		await store.wrapEditOperations().writeFile(fileA, "v1"); // succeeds
		await expect(store.wrapWriteOperations().writeFile(badPath, "x")).rejects.toThrow(); // fails

		// fileA's capture survives; restore still rolls it back to v0.
		const summary = await store.restoreTo("u1", "u1");
		expect(readFileSync(fileA, "utf-8")).toBe("v0");
		expect(summary.restored).toEqual(["a.txt"]);
	});

	it("re-drives an interrupted restore idempotently", async () => {
		const { store, session, cwd } = await createStore();
		const fileA = join(cwd, "a.txt");
		writeFileSync(fileA, "v0");

		session.appendUser("u1");
		store.beginTurn("u1");
		await store.wrapEditOperations().writeFile(fileA, "v1");
		await store.restoreTo("u1", "u1");
		expect(readFileSync(fileA, "utf-8")).toBe("v0");

		// Simulate a crash mid-restore: drop the "done" marker and revert the file
		// to pi's last-written state, then recover. Recovery re-applies the plan.
		session.entries = session.entries.filter((e) => e.customType !== "file_restore_done");
		writeFileSync(fileA, "v1");
		const recovered = await store.recoverIncompleteRestore();
		expect(recovered).not.toBeNull();
		expect(readFileSync(fileA, "utf-8")).toBe("v0");
	});
});
