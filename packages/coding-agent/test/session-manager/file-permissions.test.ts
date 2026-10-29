import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const modeOf = (path: string) => statSync(path).mode & 0o777;

// POSIX modes do not apply on Windows.
describe.skipIf(process.platform === "win32")("session file permissions", () => {
	let tempDir: string;
	let previousUmask: number;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-permissions-"));
		// The common default; it would turn the old default modes into 0755 and 0644.
		previousUmask = process.umask(0o022);
	});

	afterEach(() => {
		process.umask(previousUmask);
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeConversation(session: SessionManager): string {
		session.appendMessage(userMsg("hello"));
		session.appendMessage(assistantMsg("hi"));
		const file = session.getSessionFile();
		if (!file) throw new Error("session has no file");
		return file;
	}

	it("creates missing session directories as 0700 and session files as 0600", () => {
		const sessionsDir = join(tempDir, "sessions");
		const sessionDir = join(sessionsDir, "--project--");

		const file = writeConversation(SessionManager.create(tempDir, sessionDir));

		expect(modeOf(sessionsDir)).toBe(0o700);
		expect(modeOf(sessionDir)).toBe(0o700);
		expect(modeOf(file)).toBe(0o600);
	});

	it("keeps the modes of existing session directories and files", () => {
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { mode: 0o755 });
		const file = join(sessionDir, "existing.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({ type: "session", version: 3, id: "existing", timestamp: new Date().toISOString(), cwd: tempDir })}\n`,
		);
		chmodSync(file, 0o644);

		const session = SessionManager.open(file, sessionDir);
		session.appendMessage(userMsg("hello"));
		session.appendMessage(assistantMsg("hi"));

		expect(modeOf(sessionDir)).toBe(0o755);
		expect(modeOf(file)).toBe(0o644);
	});

	it("creates forked session files as 0600", () => {
		const source = writeConversation(SessionManager.create(tempDir, join(tempDir, "source")));
		chmodSync(source, 0o644);
		const targetDir = join(tempDir, "target");

		const fork = SessionManager.forkFrom(source, tempDir, targetDir);

		expect(modeOf(targetDir)).toBe(0o700);
		expect(modeOf(fork.getSessionFile()!)).toBe(0o600);
		expect(modeOf(source)).toBe(0o644);
	});
});
