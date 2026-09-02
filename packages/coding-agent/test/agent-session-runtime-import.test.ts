import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
} from "../src/core/agent-session-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function sessionFileContent(id: string, cwd: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`;
}

function createStubSession(sessionManager: SessionManager): AgentSession {
	return {
		sessionManager,
		sessionFile: sessionManager.getSessionFile(),
		extensionRunner: { hasHandlers: () => false, emit: async () => undefined },
		abort: async () => {},
		dispose: () => {},
	} as unknown as AgentSession;
}

function createImportRuntime(cwd: string, sessionDir: string): AgentSessionRuntime {
	const sessionManager = SessionManager.create(cwd, sessionDir);
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: nextCwd, sessionManager: nextManager }) => {
		const services = { cwd: nextCwd, agentDir: nextCwd } as unknown as AgentSessionServices;
		return {
			session: createStubSession(nextManager),
			extensionsResult: { extensions: [], errors: [], runtimeContext: {} },
			services,
			diagnostics: [],
		} as unknown as CreateAgentSessionRuntimeResult;
	};
	const services = { cwd, agentDir: cwd } as unknown as AgentSessionServices;
	return new AgentSessionRuntime(createStubSession(sessionManager), services, createRuntime);
}

// Regression tests for https://github.com/earendil-works/pi/issues/8993
describe("AgentSessionRuntime.importFromJsonl", () => {
	const tempDirs: string[] = [];

	function createTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-import-test-"));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("renames the imported file instead of overwriting an existing session with the same name", async () => {
		const cwd = createTempDir();
		const sessionDir = join(cwd, "sessions");
		const sourceDir = createTempDir();

		const runtime = createImportRuntime(cwd, sessionDir);

		const existingPath = join(sessionDir, "shared.jsonl");
		const existingContent = sessionFileContent("11111111-1111-4111-8111-111111111111", cwd);
		writeFileSync(existingPath, existingContent);

		const sourcePath = join(sourceDir, "shared.jsonl");
		const importedContent = sessionFileContent("22222222-2222-4222-8222-222222222222", cwd);
		writeFileSync(sourcePath, importedContent);

		const result = await runtime.importFromJsonl(sourcePath);

		expect(result).toEqual({ cancelled: false });
		// The pre-existing session file is untouched.
		expect(readFileSync(existingPath, "utf8")).toBe(existingContent);
		// The import landed under a unique name with the imported content.
		const renamedPath = join(sessionDir, "shared-1.jsonl");
		expect(readFileSync(renamedPath, "utf8")).toBe(importedContent);
		expect(runtime.session.sessionManager.getSessionFile()).toBe(resolve(renamedPath));
	});

	it("does not overwrite or leave files behind when the imported file is not a valid session", async () => {
		const cwd = createTempDir();
		const sessionDir = join(cwd, "sessions");
		const sourceDir = createTempDir();

		const runtime = createImportRuntime(cwd, sessionDir);

		const existingPath = join(sessionDir, "broken.jsonl");
		const existingContent = sessionFileContent("33333333-3333-4333-8333-333333333333", cwd);
		writeFileSync(existingPath, existingContent);

		const sourcePath = join(sourceDir, "broken.jsonl");
		writeFileSync(sourcePath, "this is not a pi session\n");

		await expect(runtime.importFromJsonl(sourcePath)).rejects.toThrow("not a valid");

		expect(readFileSync(existingPath, "utf8")).toBe(existingContent);
		expect(readdirSync(sessionDir).sort()).toEqual(["broken.jsonl"]);
	});

	it("imports a file already inside the session directory in place", async () => {
		const cwd = createTempDir();
		const sessionDir = join(cwd, "sessions");

		const runtime = createImportRuntime(cwd, sessionDir);

		const inPlacePath = join(sessionDir, "in-place.jsonl");
		writeFileSync(inPlacePath, sessionFileContent("44444444-4444-4444-8444-444444444444", cwd));

		const result = await runtime.importFromJsonl(inPlacePath);

		expect(result).toEqual({ cancelled: false });
		expect(runtime.session.sessionManager.getSessionFile()).toBe(resolve(inPlacePath));
		expect(existsSync(join(sessionDir, "in-place-1.jsonl"))).toBe(false);
	});
});
