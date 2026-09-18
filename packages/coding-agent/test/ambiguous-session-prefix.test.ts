import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Args } from "../src/cli/args.ts";
import { parseArgs } from "../src/cli/args.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSessionManager, type ResolvedSession, resolveSessionPath } from "../src/main.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempRoot(): string {
	// realpath: on macOS tmpdir() is a symlink (/var -> /private/var), but session
	// cwd filtering compares paths textually, so fixtures must use physical paths.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-ambiguous-session-")));
	tempDirs.push(dir);
	return dir;
}

function writeSessionFile(dir: string, file: string, id: string, cwd: string, text: string): void {
	const header = { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd };
	const msg = {
		type: "message",
		id: `m-${id.slice(0, 8)}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text }] },
	};
	writeFileSync(join(dir, file), `${JSON.stringify(header)}\n${JSON.stringify(msg)}\n`);
}

function args(overrides: Partial<Args>): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
		...overrides,
	};
}

function mockExit(): void {
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`exit:${code}`);
	});
}

describe("ambiguous session prefix", () => {
	it("reports ambiguous instead of resolving when a prefix matches two sessions", async () => {
		const root = createTempRoot();
		const projectDir = join(root, "project");
		const sessionDir = join(root, "sessions");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		// Session IDs are time-ordered (uuidv7), so IDs created close together
		// share a long prefix; a short documented "partial UUID" collides.
		const idA = "0198d640-1111-7aaa-aaaa-aaaaaaaaaaaa";
		const idB = "0198d640-2222-7bbb-bbbb-bbbbbbbbbbbb";
		writeSessionFile(sessionDir, "a.jsonl", idA, projectDir, "SESSION A MARKER");
		writeSessionFile(sessionDir, "b.jsonl", idB, projectDir, "SESSION B MARKER");

		const resolved = await resolveSessionPath("0198d640", projectDir, sessionDir);

		expect(resolved.type).toBe("ambiguous");
		expect((resolved as Extract<ResolvedSession, { type: "ambiguous" }>).matches.map((m) => m.id).sort()).toEqual(
			[idA, idB].sort(),
		);
	});

	it("still resolves an exact session ID when other sessions share its prefix", async () => {
		const root = createTempRoot();
		const projectDir = join(root, "project");
		const sessionDir = join(root, "sessions");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		const idA = "0198d640-1111-7aaa-aaaa-aaaaaaaaaaaa";
		const idB = "0198d640-2222-7bbb-bbbb-bbbbbbbbbbbb";
		writeSessionFile(sessionDir, "a.jsonl", idA, projectDir, "SESSION A MARKER");
		writeSessionFile(sessionDir, "b.jsonl", idB, projectDir, "SESSION B MARKER");

		const resolved = await resolveSessionPath(idB, projectDir, sessionDir);

		expect(resolved.type).toBe("local");
		expect((resolved as { path: string }).path).toBe(join(sessionDir, "b.jsonl"));
	});

	it("still resolves a prefix that matches exactly one session", async () => {
		const root = createTempRoot();
		const projectDir = join(root, "project");
		const sessionDir = join(root, "sessions");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		writeSessionFile(sessionDir, "a.jsonl", "0198d640-1111-7aaa-aaaa-aaaaaaaaaaaa", projectDir, "A");
		writeSessionFile(sessionDir, "b.jsonl", "0198d641-2222-7bbb-bbbb-bbbbbbbbbbbb", projectDir, "B");

		const resolved = await resolveSessionPath("0198d640", projectDir, sessionDir);

		expect(resolved.type).toBe("local");
		expect((resolved as { path: string }).path).toBe(join(sessionDir, "a.jsonl"));
	});

	it("--session with an ambiguous prefix exits instead of opening a session", async () => {
		const root = createTempRoot();
		const projectDir = join(root, "project");
		const sessionDir = join(root, "sessions");
		const agentDir = join(root, "agent");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeSessionFile(sessionDir, "a.jsonl", "0198d640-1111-7aaa-aaaa-aaaaaaaaaaaa", projectDir, "SESSION A MARKER");
		writeSessionFile(sessionDir, "b.jsonl", "0198d640-2222-7bbb-bbbb-bbbbbbbbbbbb", projectDir, "SESSION B MARKER");
		mockExit();

		await expect(
			createSessionManager(
				args({ ...parseArgs([]), session: "0198d640" }),
				projectDir,
				sessionDir,
				SettingsManager.create(projectDir, agentDir),
			),
		).rejects.toThrow("exit:1");
	});

	it("--fork with an ambiguous prefix exits instead of forking a session", async () => {
		const root = createTempRoot();
		const projectDir = join(root, "project");
		const sessionDir = join(root, "sessions");
		const agentDir = join(root, "agent");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeSessionFile(sessionDir, "a.jsonl", "0198d640-1111-7aaa-aaaa-aaaaaaaaaaaa", projectDir, "SESSION A MARKER");
		writeSessionFile(sessionDir, "b.jsonl", "0198d640-2222-7bbb-bbbb-bbbbbbbbbbbb", projectDir, "SESSION B MARKER");
		mockExit();

		await expect(
			createSessionManager(
				args({ ...parseArgs([]), fork: "0198d640" }),
				projectDir,
				sessionDir,
				SettingsManager.create(projectDir, agentDir),
			),
		).rejects.toThrow("exit:1");
	});
});
