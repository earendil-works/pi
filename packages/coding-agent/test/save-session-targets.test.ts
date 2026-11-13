import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Args } from "../src/cli/args.ts";
import { ENV_SESSION_DIR } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSessionManager, resolveSessionDir } from "../src/main.ts";
import { normalizePath } from "../src/utils/paths.ts";
import { userMsg } from "./utilities.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-save-target-"));
	tempDirs.push(dir);
	return dir;
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

describe("resolveSessionDir", () => {
	it("prefers the CLI flag over the environment and settings", () => {
		const cliDir = createTempDir();
		vi.stubEnv(ENV_SESSION_DIR, join(cliDir, "from-env"));
		const settingsManager = SettingsManager.inMemory({ sessionDir: join(cliDir, "from-settings") });

		expect(resolveSessionDir(args({ sessionDir: join(cliDir, "from-cli") }), settingsManager)).toBe(
			normalizePath(join(cliDir, "from-cli")),
		);
	});

	it("uses the environment over settings", () => {
		const cliDir = createTempDir();
		vi.stubEnv(ENV_SESSION_DIR, join(cliDir, "from-env"));
		const settingsManager = SettingsManager.inMemory({ sessionDir: join(cliDir, "from-settings") });

		expect(resolveSessionDir(args({}), settingsManager)).toBe(normalizePath(join(cliDir, "from-env")));
	});

	it("falls back to settings, then to the default directory", () => {
		const cliDir = createTempDir();
		expect(resolveSessionDir(args({}), SettingsManager.inMemory({ sessionDir: cliDir }))).toBe(normalizePath(cliDir));
		expect(resolveSessionDir(args({}), SettingsManager.inMemory())).toBeUndefined();
	});
});

describe("createSessionManager for temporary sessions", () => {
	it("keeps the resolved session directory as the future save target", async () => {
		// #10768
		const projectDir = createTempDir();
		const sessionDir = join(projectDir, "custom-sessions");
		const sessionManager = await createSessionManager(
			args({ noSession: true }),
			projectDir,
			sessionDir,
			SettingsManager.inMemory(),
		);

		expect(sessionManager.isPersisted()).toBe(false);
		expect(sessionManager.getSessionDir()).toBe("");
		expect(sessionManager.getSaveSessionDir()).toBe(normalizePath(sessionDir));
		expect(existsSync(sessionDir)).toBe(false);
	});

	it("saves into the retained target and stays there for later sessions", async () => {
		const projectDir = createTempDir();
		const sessionDir = join(projectDir, "custom-sessions");
		const sessionManager = await createSessionManager(
			args({ noSession: true }),
			projectDir,
			sessionDir,
			SettingsManager.inMemory(),
		);
		sessionManager.appendMessage(userMsg("prompt"));

		const result = sessionManager.saveInPlace();
		if (result.status !== "saved") throw new Error(`expected a saved session, got ${result.status}`);

		expect(result.sessionFile.startsWith(`${normalizePath(sessionDir)}/`)).toBe(true);
		expect(sessionManager.getSessionDir()).toBe(normalizePath(sessionDir));
		expect(sessionManager.getSessionFile()).toBe(result.sessionFile);
		expect(sessionManager.isPersisted()).toBe(true);
	});
});
