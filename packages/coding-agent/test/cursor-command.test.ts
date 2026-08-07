import { describe, expect, it, vi } from "vitest";
import {
	CursorCommandError,
	formatCursorStatusHuman,
	formatCursorStatusJson,
	isCursorCommandHelp,
	parseCursorCommand,
	runCursorCommand,
} from "../src/cli/cursor-command.ts";
import { CURSOR_AGENT_BIN_ENV } from "../src/core/cursor-agent-cli.ts";
import type { ExecResult } from "../src/core/exec.ts";

function stubStatusRun(payload: unknown, code = 0): (bin: string, args: string[]) => Promise<ExecResult> {
	return async (_bin, args) => {
		expect(args).toEqual(["status", "--format", "json"]);
		return {
			stdout: JSON.stringify(payload),
			stderr: "",
			code,
			killed: false,
		};
	};
}

describe("cursor-command parse/help", () => {
	it("parses status and --json", () => {
		expect(parseCursorCommand(["cursor", "status"])).toEqual({ kind: "status", json: false });
		expect(parseCursorCommand(["cursor", "status", "--json"])).toEqual({ kind: "status", json: true });
		expect(parseCursorCommand(["auth", "check"])).toBeUndefined();
	});

	it("rejects unknown commands and options", () => {
		expect(() => parseCursorCommand(["cursor", "login"])).toThrow(CursorCommandError);
		expect(() => parseCursorCommand(["cursor", "status", "--verbose"])).toThrow(/Unknown option/);
	});

	it("detects help", () => {
		expect(isCursorCommandHelp(["cursor"])).toBe(true);
		expect(isCursorCommandHelp(["cursor", "help"])).toBe(true);
		expect(isCursorCommandHelp(["cursor", "--help"])).toBe(true);
		expect(isCursorCommandHelp(["cursor", "status", "-h"])).toBe(true);
		expect(isCursorCommandHelp(["cursor", "status"])).toBe(false);
	});
});

describe("cursor-command formatting", () => {
	it("formats human and json status", () => {
		const status = {
			isAuthenticated: true,
			status: "authenticated",
			userInfo: { email: "a@b.com", teamId: 42, firstName: "Ada", lastName: "Lovelace" },
			raw: {},
		};
		const human = formatCursorStatusHuman(status, "/usr/bin/agent");
		expect(human).toContain("Authenticated: yes");
		expect(human).toContain("Email: a@b.com");
		expect(human).toContain("Team ID: 42");
		expect(human).toContain("Name: Ada Lovelace");
		expect(human).toContain("Binary: /usr/bin/agent");

		expect(JSON.parse(formatCursorStatusJson(status, "/usr/bin/agent"))).toEqual({
			isAuthenticated: true,
			status: "authenticated",
			userInfo: status.userInfo,
			binary: "/usr/bin/agent",
		});
	});

	it("includes login guidance when not authenticated", () => {
		const human = formatCursorStatusHuman({ isAuthenticated: false, raw: {} });
		expect(human).toContain("Authenticated: no");
		expect(human).toContain("agent login");
	});
});

describe("runCursorCommand", () => {
	it("returns false for non-cursor argv", async () => {
		expect(await runCursorCommand(["auth", "check"])).toBe(false);
	});

	it("prints help and returns true", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			expect(await runCursorCommand(["cursor", "help"])).toBe(true);
			expect(log).toHaveBeenCalled();
			expect(String(log.mock.calls[0]?.[0])).toContain("pi cursor status");
		} finally {
			log.mockRestore();
		}
	});

	it("exits 0 when authenticated (human)", async () => {
		const chunks: string[] = [];
		let exitCode: number | undefined;
		const ok = await runCursorCommand(["cursor", "status"], {
			env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent", PATH: "" },
			run: stubStatusRun({
				isAuthenticated: true,
				status: "authenticated",
				userInfo: { email: "dev@example.com", teamId: 7 },
			}),
			stdout: (text) => {
				chunks.push(text);
			},
			stderr: () => {},
			setExitCode: (code) => {
				exitCode = code;
			},
		});
		expect(ok).toBe(true);
		expect(exitCode).toBe(0);
		expect(chunks.join("")).toContain("Authenticated: yes");
		expect(chunks.join("")).toContain("dev@example.com");
	});

	it("exits 0 with --json when authenticated", async () => {
		const chunks: string[] = [];
		let exitCode: number | undefined;
		await runCursorCommand(["cursor", "status", "--json"], {
			env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent", PATH: "" },
			run: stubStatusRun({ isAuthenticated: true, status: "authenticated" }),
			stdout: (text) => {
				chunks.push(text);
			},
			stderr: () => {},
			setExitCode: (code) => {
				exitCode = code;
			},
		});
		expect(exitCode).toBe(0);
		expect(JSON.parse(chunks.join(""))).toMatchObject({ isAuthenticated: true, binary: "/fake/agent" });
	});

	it("exits 1 when not authenticated", async () => {
		const chunks: string[] = [];
		let exitCode: number | undefined;
		await runCursorCommand(["cursor", "status"], {
			env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent", PATH: "" },
			run: stubStatusRun({ isAuthenticated: false, status: "unauthenticated" }),
			stdout: (text) => {
				chunks.push(text);
			},
			stderr: () => {},
			setExitCode: (code) => {
				exitCode = code;
			},
		});
		expect(exitCode).toBe(1);
		expect(chunks.join("")).toContain("Authenticated: no");
		expect(chunks.join("")).toContain("agent login");
	});

	it("exits 1 with a clear message when binary is missing", async () => {
		const errors: string[] = [];
		let exitCode: number | undefined;
		await runCursorCommand(["cursor", "status"], {
			env: { PATH: "" },
			pathDirs: [],
			stdout: () => {},
			stderr: (text) => {
				errors.push(text);
			},
			setExitCode: (code) => {
				exitCode = code;
			},
		});
		expect(exitCode).toBe(1);
		expect(errors.join("\n")).toMatch(/Cursor CLI binary not found|CURSOR_AGENT_BIN/i);
	});

	it("exits 1 when status command fails", async () => {
		const errors: string[] = [];
		let exitCode: number | undefined;
		await runCursorCommand(["cursor", "status"], {
			env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent", PATH: "" },
			run: async () => ({ stdout: "", stderr: "boom", code: 2, killed: false }),
			stdout: () => {},
			stderr: (text) => {
				errors.push(text);
			},
			setExitCode: (code) => {
				exitCode = code;
			},
		});
		expect(exitCode).toBe(1);
		expect(errors.join("\n")).toContain("boom");
	});
});
