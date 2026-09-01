import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionHeader, SessionInfo } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { isSessionVisible } from "../src/modes/interactive/components/session-selector-search.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function writeHeaderedSession(path: string, mode: "interactive" | "headless" | undefined): void {
	const header: SessionHeader = {
		type: "session",
		id: "test-session",
		version: 3,
		timestamp: new Date(0).toISOString(),
		cwd: "/tmp",
		mode,
	};
	writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");

	// SessionManager only persists once it has seen at least one assistant message.
	const mgr = SessionManager.open(path);
	mgr.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

describe("SessionInfo.mode", () => {
	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parses a headless session mode from the session header", async () => {
		const filePath = join(tmpdir(), `pi-session-${Date.now()}-headless.jsonl`);
		writeHeaderedSession(filePath, "headless");

		const sessions = await SessionManager.list("/tmp", dirname(filePath));
		const s = sessions.find((x) => x.path === filePath);
		expect(s).toBeDefined();
		expect(s!.mode).toBe("headless");
	});

	it("parses an interactive session mode", async () => {
		const filePath = join(tmpdir(), `pi-session-${Date.now()}-interactive.jsonl`);
		writeHeaderedSession(filePath, "interactive");

		const sessions = await SessionManager.list("/tmp", dirname(filePath));
		const s = sessions.find((x) => x.path === filePath);
		expect(s).toBeDefined();
		expect(s!.mode).toBe("interactive");
	});

	it("leaves mode undefined for legacy sessions (no mode in header)", async () => {
		const filePath = join(tmpdir(), `pi-session-${Date.now()}-legacy.jsonl`);
		writeHeaderedSession(filePath, undefined);

		const sessions = await SessionManager.list("/tmp", dirname(filePath));
		const s = sessions.find((x) => x.path === filePath);
		expect(s).toBeDefined();
		expect(s!.mode).toBeUndefined();
	});
});

describe("isSessionVisible", () => {
	it("hides headless sessions by default", () => {
		const session = { mode: "headless" } as SessionInfo;
		expect(isSessionVisible(session)).toBe(false);
	});

	it("shows headless sessions when showHeadless is on", () => {
		const session = { mode: "headless" } as SessionInfo;
		expect(isSessionVisible(session, { showHeadless: true })).toBe(true);
	});

	it("shows interactive sessions", () => {
		const session = { mode: "interactive" } as SessionInfo;
		expect(isSessionVisible(session)).toBe(true);
	});

	it("treats legacy sessions (no mode) as visible", () => {
		const session = {} as SessionInfo;
		expect(isSessionVisible(session)).toBe(true);
	});
});
