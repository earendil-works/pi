import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Args } from "../src/cli/args.js";
import { validateNewSessionIdFlags } from "../src/main.js";
import { SessionManager } from "../src/core/session-manager.js";

const VALID_UUID = "12345678-1234-1234-1234-123456789abc";

function makeArgs(overrides: Partial<Args> = {}): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
		...overrides,
	};
}

describe("validateNewSessionIdFlags", () => {
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		exitSpy.mockRestore();
		errorSpy.mockRestore();
	});

	it("accepts a valid UUID with no conflicting flags", () => {
		validateNewSessionIdFlags(makeArgs({ newSessionId: VALID_UUID }));
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("rejects a non-UUID value", () => {
		validateNewSessionIdFlags(makeArgs({ newSessionId: "not-a-uuid" }));
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("must be a UUID"));
	});

	it("passes through when newSessionId is absent", () => {
		validateNewSessionIdFlags(makeArgs());
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("rejects --new-session-id combined with --session", () => {
		validateNewSessionIdFlags(makeArgs({ newSessionId: VALID_UUID, session: "some-session" }));
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--session"));
	});

	it("rejects --new-session-id combined with --continue", () => {
		validateNewSessionIdFlags(makeArgs({ newSessionId: VALID_UUID, continue: true }));
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--continue"));
	});

	it("rejects --new-session-id combined with --resume", () => {
		validateNewSessionIdFlags(makeArgs({ newSessionId: VALID_UUID, resume: true }));
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--resume"));
	});

	it("rejects --new-session-id combined with --fork", () => {
		validateNewSessionIdFlags(makeArgs({ newSessionId: VALID_UUID, fork: "some-fork" }));
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--fork"));
	});

	it("rejects --new-session-id combined with --no-session", () => {
		validateNewSessionIdFlags(makeArgs({ newSessionId: VALID_UUID, noSession: true }));
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--no-session"));
	});
});

describe("SessionManager.create with options.id", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-session-test-"));
	});

	afterEach(() => {
		try {
			const files = readdirSync(tempDir);
			for (const file of files) {
				unlinkSync(join(tempDir, file));
			}
			rmdirSync(tempDir);
		} catch {
			// ignore cleanup errors
		}
	});

	it("uses the supplied UUID as sessionId", () => {
		const sm = SessionManager.create(process.cwd(), tempDir, { id: VALID_UUID });
		expect(sm.getSessionId()).toBe(VALID_UUID);
	});

	it("includes the supplied UUID in the session file path", () => {
		const sm = SessionManager.create(process.cwd(), tempDir, { id: VALID_UUID });
		expect(sm.getSessionFile()).toContain(VALID_UUID);
	});

	it("falls back to a generated UUID when options is omitted", () => {
		const sm = SessionManager.create(process.cwd(), tempDir);
		expect(sm.getSessionId()).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
		expect(sm.getSessionId()).not.toBe(VALID_UUID);
	});

	it("falls back to a generated UUID when options.id is undefined", () => {
		const sm = SessionManager.create(process.cwd(), tempDir, {});
		expect(sm.getSessionId()).toMatch(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
	});
});
