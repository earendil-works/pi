import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMostRecentSession, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";

const SESSION_ID = "0199ffff-0000-7000-8000-000000000001";

describe("entries before the session header", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-header-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeTitleLine(file: string): void {
		writeFileSync(
			file,
			`${JSON.stringify({
				type: "title",
				v: 1,
				title: "Fork-written title",
				source: "auto",
				updatedAt: "2025-01-01T00:00:00Z",
			})}\n`,
		);
	}

	function writeHeaderLine(file: string): void {
		writeFileSync(
			file,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: SESSION_ID,
				timestamp: "2025-01-01T00:00:00Z",
				cwd: tempDir,
			})}\n`,
			{ flag: "a" },
		);
	}

	function writeSessionFile(name: string, { withTitle = true } = {}): string {
		const file = join(tempDir, name);
		if (withTitle) writeTitleLine(file);
		writeHeaderLine(file);
		return file;
	}

	it("loadEntriesFromFile reads entries when a title record precedes the header", () => {
		const file = writeSessionFile("prefixed.jsonl");
		const entries = loadEntriesFromFile(file);
		expect(entries.length).toBe(2);
		expect(entries[0].type).toBe("title");
		expect(entries[1].type).toBe("session");
	});

	it("loadEntriesFromFile still rejects files without any session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeTitleLine(file);
		writeFileSync(file, `${JSON.stringify({ type: "session_info", name: "x" })}\n`, { flag: "a" });
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("findMostRecentSession resolves sessions with pre-header entries", () => {
		const file = writeSessionFile("2025-01-01T00-00-00-000Z_test.jsonl");
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("SessionManager.listAll lists sessions with pre-header entries", async () => {
		writeSessionFile("2025-01-01T00-00-00-000Z_test.jsonl");
		const sessions = await SessionManager.listAll(tempDir);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].id).toBe(SESSION_ID);
	});
});
