import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager entry ID reservations", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("reserves IDs without appending entries or advancing the leaf", () => {
		const session = SessionManager.inMemory();

		const first = session.reserveEntryId();
		const second = session.reserveEntryId();

		expect(first).not.toBe(second);
		expect(session.getEntries()).toEqual([]);
		expect(session.getEntry(first)).toBeUndefined();
		expect(session.getLeafId()).toBeNull();
	});

	it("appends a message with its reserved ID", () => {
		const session = SessionManager.inMemory();
		const parentId = session.appendCustomEntry("parent");
		const reservedId = session.reserveEntryId("maverick-entry-1");

		const entryId = session.appendMessage({ role: "user", content: "hello", timestamp: 1 }, { id: reservedId });

		expect(entryId).toBe(reservedId);
		expect(session.getEntry(reservedId)).toMatchObject({
			type: "message",
			id: reservedId,
			parentId,
		});
	});

	it("rejects unreserved, duplicate, and invalid IDs without mutating the session", () => {
		const session = SessionManager.inMemory();

		expect(() =>
			session.appendMessage({ role: "user", content: "hello", timestamp: 1 }, { id: "not-reserved" }),
		).toThrow("Session entry ID was not reserved: not-reserved");
		expect(session.getEntries()).toEqual([]);

		const reservedId = session.reserveEntryId("reserved-once");
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 }, { id: reservedId });
		expect(() => session.appendMessage({ role: "user", content: "again", timestamp: 2 }, { id: reservedId })).toThrow(
			"Session entry ID already exists: reserved-once",
		);
		expect(session.getEntries()).toHaveLength(1);

		expect(() => session.reserveEntryId("not valid")).toThrow("Session entry id must be non-empty");
	});

	it("releases unconsumed reservations and clears them with the session", () => {
		const session = SessionManager.inMemory();
		const releasedId = session.reserveEntryId("released-entry");

		expect(session.releaseEntryId(releasedId)).toBe(true);
		expect(session.releaseEntryId(releasedId)).toBe(false);
		expect(() => session.appendMessage({ role: "user", content: "hello", timestamp: 1 }, { id: releasedId })).toThrow(
			"Session entry ID was not reserved: released-entry",
		);

		const previousSessionId = session.getSessionId();
		const clearedId = session.reserveEntryId("cleared-entry");
		session.newSession();

		expect(session.getSessionId()).not.toBe(previousSessionId);
		expect(() => session.appendMessage({ role: "user", content: "hello", timestamp: 1 }, { id: clearedId })).toThrow(
			"Session entry ID was not reserved: cleared-entry",
		);
	});

	it("flushes a reserved user entry before the first assistant message", () => {
		const tempDir = join(tmpdir(), `pi-entry-id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);

		const session = SessionManager.create(tempDir, tempDir);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");
		const reservedId = session.reserveEntryId("durable-user-entry");

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 }, { id: reservedId, flush: true });

		expect(existsSync(sessionFile)).toBe(true);
		const reopened = SessionManager.open(sessionFile, tempDir);
		expect(reopened.getEntry(reservedId)).toMatchObject({
			type: "message",
			id: reservedId,
			message: { role: "user", content: "hello" },
		});
	});

	it("keeps the default first-user persistence behavior without flush", () => {
		const tempDir = join(tmpdir(), `pi-entry-id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);

		const session = SessionManager.create(tempDir, tempDir);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persistent session file");

		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		expect(existsSync(sessionFile)).toBe(false);
	});

	it("keeps the tree unchanged and restores the reservation when persistence fails", () => {
		const tempDir = join(tmpdir(), `pi-entry-id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const session = SessionManager.create(tempDir, tempDir);
		const reservedId = session.reserveEntryId("retryable-user-entry");
		rmSync(tempDir, { recursive: true, force: true });

		expect(() =>
			session.appendMessage({ role: "user", content: "hello", timestamp: 1 }, { id: reservedId, flush: true }),
		).toThrow();
		expect(session.getEntries()).toEqual([]);
		expect(session.getLeafId()).toBeNull();

		mkdirSync(tempDir, { recursive: true });
		expect(
			session.appendMessage({ role: "user", content: "hello", timestamp: 1 }, { id: reservedId, flush: true }),
		).toBe(reservedId);
	});
});
