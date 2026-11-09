import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type MissingSessionCwdChoice, MissingSessionCwdError } from "../src/core/session-cwd.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SwitchSession = (sessionPath: string, options?: { cwdOverride?: string }) => Promise<{ cancelled: boolean }>;

type ResumeContext = {
	clearStatusIndicator: () => void;
	runtimeHost: { switchSession: SwitchSession };
	sessionManager: SessionManager;
	showStatus: (message: string) => void;
	showExtensionSelector: (title: string, options: string[]) => Promise<string | undefined>;
	createProjectTrustContext: (cwd: string) => unknown;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	promptForMissingSessionCwd: unknown;
	switchToForkedSession: unknown;
};

type InteractiveModePrototype = {
	handleResumeSession(this: ResumeContext, sessionPath: string): Promise<{ cancelled: boolean }>;
	promptForMissingSessionCwd: unknown;
	switchToForkedSession: unknown;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function createTempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// #11060
describe("InteractiveMode /resume with a missing session cwd", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		for (const path of cleanupPaths.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
	});

	function setup(options: { choice: MissingSessionCwdChoice | undefined; switchCancelled: boolean }) {
		const currentCwd = createTempDir("pi-resume-missing-cwd");
		const missingCwd = join(currentCwd, "renamed-away");
		const oldSessionDir = createTempDir("pi-resume-missing-cwd-old");
		const currentSessionDir = createTempDir("pi-resume-missing-cwd-current");
		cleanupPaths.push(currentCwd, oldSessionDir, currentSessionDir);

		const sessionPath = join(oldSessionDir, "orphan.jsonl");
		const original = `${JSON.stringify({ type: "session", version: 3, id: "orphan", timestamp: new Date().toISOString(), cwd: missingCwd })}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "hello", timestamp: 1 } })}\n`;
		writeFileSync(sessionPath, original);

		const switchSession = vi.fn<SwitchSession>(async (path, switchOptions) => {
			if (path === sessionPath && switchOptions?.cwdOverride === undefined) {
				throw new MissingSessionCwdError({
					sessionFile: sessionPath,
					sessionCwd: missingCwd,
					fallbackCwd: currentCwd,
				});
			}
			return { cancelled: options.switchCancelled };
		});
		const showStatus = vi.fn();
		const context: ResumeContext = {
			clearStatusIndicator: vi.fn(),
			runtimeHost: { switchSession },
			sessionManager: SessionManager.create(currentCwd, currentSessionDir),
			showStatus,
			showExtensionSelector: vi.fn(
				async (_title: string, labels: string[]) => labels[["continue", "fork", undefined].indexOf(options.choice)],
			),
			createProjectTrustContext: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: interactiveModePrototype.promptForMissingSessionCwd,
			switchToForkedSession: interactiveModePrototype.switchToForkedSession,
		};
		return { context, currentCwd, currentSessionDir, sessionPath, original, switchSession, showStatus };
	}

	it("forks the session into the current cwd and leaves the original unchanged", async () => {
		const { context, currentCwd, currentSessionDir, sessionPath, original, switchSession, showStatus } = setup({
			choice: "fork",
			switchCancelled: false,
		});

		const result = await interactiveModePrototype.handleResumeSession.call(context, sessionPath);

		expect(result).toEqual({ cancelled: false });
		const forkPath = switchSession.mock.calls[1][0];
		expect(forkPath.startsWith(currentSessionDir)).toBe(true);
		const lines = readFileSync(forkPath, "utf8").trim().split("\n");
		const header = JSON.parse(lines[0]);
		expect(header).toMatchObject({ type: "session", cwd: currentCwd, parentSession: sessionPath });
		expect(header.id).not.toBe("orphan");
		expect(JSON.parse(lines[1])).toMatchObject({ id: "m1" });
		expect(readFileSync(sessionPath, "utf8")).toBe(original);
		expect(showStatus).toHaveBeenCalledWith(`Forked into new session ${header.id} in ${currentCwd}`);
	});

	it("continues the original session in the current cwd without writing a file", async () => {
		const { context, currentCwd, currentSessionDir, sessionPath, original, switchSession, showStatus } = setup({
			choice: "continue",
			switchCancelled: false,
		});

		const result = await interactiveModePrototype.handleResumeSession.call(context, sessionPath);

		expect(result).toEqual({ cancelled: false });
		expect(switchSession).toHaveBeenLastCalledWith(sessionPath, expect.objectContaining({ cwdOverride: currentCwd }));
		expect(readFileSync(sessionPath, "utf8")).toBe(original);
		expect(readdirSync(currentSessionDir)).toEqual([]);
		expect(showStatus).toHaveBeenCalledWith(`Resumed session in ${currentCwd}`);
	});

	it("removes the fork when an extension cancels the switch", async () => {
		const { context, currentSessionDir, sessionPath, switchSession } = setup({
			choice: "fork",
			switchCancelled: true,
		});

		const result = await interactiveModePrototype.handleResumeSession.call(context, sessionPath);

		expect(result).toEqual({ cancelled: true });
		expect(existsSync(switchSession.mock.calls[1][0])).toBe(false);
		expect(readdirSync(currentSessionDir)).toEqual([]);
	});

	it("creates no fork when the user cancels", async () => {
		const { context, currentSessionDir, sessionPath, switchSession, showStatus } = setup({
			choice: undefined,
			switchCancelled: false,
		});

		const result = await interactiveModePrototype.handleResumeSession.call(context, sessionPath);

		expect(result).toEqual({ cancelled: true });
		expect(switchSession).toHaveBeenCalledTimes(1);
		expect(readdirSync(currentSessionDir)).toEqual([]);
		expect(showStatus).toHaveBeenCalledWith("Resume cancelled");
	});
});
