import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";

const DIRECTORY_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

describe("regression #7497: discover sessions through symlinked directories", () => {
	let tempDir: string;
	let sessionsDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-discovery-"));
		const agentDir = join(tempDir, "agent");
		sessionsDir = join(agentDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSession(dir: string, id: string): void {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${id}.jsonl`),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id,
				timestamp: "2026-08-03T00:00:00.000Z",
				cwd: join(tempDir, "project"),
			})}\n`,
		);
	}

	it("discovers a session through a directory link and preserves the alias path", async () => {
		const targetDir = join(tempDir, "linked-sessions");
		writeSession(targetDir, "linked");
		const aliasDir = join(sessionsDir, "--linked--");
		symlinkSync(targetDir, aliasDir, DIRECTORY_LINK_TYPE);

		const sessions = await SessionManager.listAll();

		expect(sessions.map((session) => session.id)).toEqual(["linked"]);
		expect(sessions[0]?.path).toBe(join(aliasDir, "linked.jsonl"));
	});

	it("ignores a broken directory link without hiding valid sessions", async () => {
		writeSession(join(sessionsDir, "--regular--"), "regular");
		const targetDir = join(tempDir, "removed-sessions");
		mkdirSync(targetDir);
		symlinkSync(targetDir, join(sessionsDir, "--broken--"), DIRECTORY_LINK_TYPE);
		rmSync(targetDir, { recursive: true });

		const sessions = await SessionManager.listAll();

		expect(sessions.map((session) => session.id)).toEqual(["regular"]);
	});

	it.skipIf(process.platform === "win32")("ignores links to files", async () => {
		writeSession(join(sessionsDir, "--regular--"), "regular");
		const targetFile = join(tempDir, "not-a-directory");
		writeFileSync(targetFile, "");
		symlinkSync(targetFile, join(sessionsDir, "--file--"), "file");

		const sessions = await SessionManager.listAll();

		expect(sessions.map((session) => session.id)).toEqual(["regular"]);
	});
});
