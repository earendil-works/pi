import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CURSOR_AGENT_BIN_ENV,
	CURSOR_API_KEY_ENV,
	CursorAgentCliError,
	formatCursorAgentCliErrorMessage,
	parseCursorAgentListModels,
	parseCursorAgentPrintJson,
	parseCursorAgentStatusJson,
	resolveCursorAgentBin,
	runCursorAgentListModels,
	runCursorAgentPrint,
	runCursorAgentStatus,
	scrubCursorAgentChildEnv,
} from "../src/core/cursor-agent-cli.ts";

function makeFakeBinDir(names: string[]): string {
	const dir = join(tmpdir(), `cursor-agent-bin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	for (const name of names) {
		const path = join(dir, name);
		writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		chmodSync(path, 0o755);
	}
	return dir;
}

describe("cursor-agent-cli", () => {
	it("resolves CURSOR_AGENT_BIN before PATH names", () => {
		const agentDir = makeFakeBinDir(["agent"]);
		const custom = join(agentDir, "custom-agent");
		writeFileSync(custom, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		chmodSync(custom, 0o755);

		expect(
			resolveCursorAgentBin({
				env: { [CURSOR_AGENT_BIN_ENV]: custom, PATH: agentDir },
				pathDirs: [agentDir],
			}),
		).toBe(custom);
	});

	it("prefers agent over cursor-agent on PATH", () => {
		const dir = makeFakeBinDir(["agent", "cursor-agent"]);
		expect(resolveCursorAgentBin({ env: { PATH: dir }, pathDirs: [dir] })).toBe(join(dir, "agent"));
	});

	it("falls back to cursor-agent when agent is missing", () => {
		const dir = makeFakeBinDir(["cursor-agent"]);
		expect(resolveCursorAgentBin({ env: { PATH: dir }, pathDirs: [dir] })).toBe(join(dir, "cursor-agent"));
	});

	it("returns undefined when no binary is available", () => {
		const dir = makeFakeBinDir([]);
		expect(resolveCursorAgentBin({ env: { PATH: dir }, pathDirs: [dir] })).toBeUndefined();
	});

	it("strips CURSOR_API_KEY from child env", () => {
		const scrubbed = scrubCursorAgentChildEnv({
			HOME: "/home/test",
			PATH: "/bin",
			[CURSOR_API_KEY_ENV]: "secret-key",
		});
		expect(scrubbed[CURSOR_API_KEY_ENV]).toBeUndefined();
		expect(scrubbed.HOME).toBe("/home/test");
		expect(scrubbed.PATH).toBe("/bin");
	});

	it("parses authenticated status JSON", () => {
		const status = parseCursorAgentStatusJson(
			JSON.stringify({
				status: "authenticated",
				isAuthenticated: true,
				userInfo: { email: "a@b.com", teamId: 1 },
			}),
		);
		expect(status.isAuthenticated).toBe(true);
		expect(status.userInfo?.email).toBe("a@b.com");
		expect(status.userInfo?.teamId).toBe(1);
	});

	it("treats status authenticated without isAuthenticated as authenticated", () => {
		expect(parseCursorAgentStatusJson(JSON.stringify({ status: "authenticated" })).isAuthenticated).toBe(true);
	});

	it("rejects unauthenticated status", () => {
		expect(
			parseCursorAgentStatusJson(JSON.stringify({ isAuthenticated: false, status: "logged_out" })).isAuthenticated,
		).toBe(false);
	});

	it("parses list-models lines and strips tags", () => {
		const models = parseCursorAgentListModels(`Available models

auto - Auto (current, default)
gpt-5.2 - GPT-5.2
claude-fable-5-thinking-high - Fable 5 1M Thinking (NO ZDR)
Tip: use agent --model <id>
`);
		expect(models).toEqual([
			{ id: "auto", name: "Auto" },
			{ id: "gpt-5.2", name: "GPT-5.2" },
			{ id: "claude-fable-5-thinking-high", name: "Fable 5 1M Thinking" },
		]);
	});

	it("parses print JSON success payload", () => {
		const parsed = parseCursorAgentPrintJson(
			JSON.stringify({
				type: "result",
				subtype: "success",
				is_error: false,
				result: "ok",
				usage: { inputTokens: 10, outputTokens: 2 },
			}),
		);
		expect(parsed.result).toBe("ok");
		expect(parsed.usage?.inputTokens).toBe(10);
	});

	it("fails print JSON without result string", () => {
		expect(() => parseCursorAgentPrintJson(JSON.stringify({ type: "result", is_error: false }))).toThrow(
			/missing string `result`/,
		);
	});

	it("runs status/list/print through injected runner and scrubbed env", async () => {
		const calls: Array<{ bin: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
		const run = async (bin: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
			calls.push({ bin, args, env: options.env });
			if (args[0] === "status") {
				return {
					stdout: JSON.stringify({ isAuthenticated: true, status: "authenticated" }),
					stderr: "",
					code: 0,
					killed: false,
				};
			}
			if (args[0] === "--list-models") {
				return { stdout: "auto - Auto\n", stderr: "", code: 0, killed: false };
			}
			return {
				stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "hi" }),
				stderr: "",
				code: 0,
				killed: false,
			};
		};

		const deps = {
			env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent", [CURSOR_API_KEY_ENV]: "leak", PATH: "/bin" },
			run,
		};

		const status = await runCursorAgentStatus(deps);
		expect(status.isAuthenticated).toBe(true);
		expect(await runCursorAgentListModels(deps)).toEqual([{ id: "auto", name: "Auto" }]);
		expect((await runCursorAgentPrint({ ...deps, modelId: "auto", prompt: "Say hi" })).result).toBe("hi");

		expect(calls[0]?.args).toEqual(["status", "--format", "json"]);
		expect(calls[1]?.args).toEqual(["--list-models"]);
		expect(calls[2]?.args).toEqual([
			"-p",
			"--output-format",
			"json",
			"--mode",
			"ask",
			"--trust",
			"--model",
			"auto",
			"--workspace",
			expect.any(String),
			"Say hi",
		]);
		for (const call of calls) {
			expect(call.env?.[CURSOR_API_KEY_ENV]).toBeUndefined();
		}
	});

	it("surfaces stderr snippets on non-zero status/list/print exits", async () => {
		const deps = {
			env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent" },
			run: async (_bin: string, args: string[]) => {
				if (args[0] === "status") {
					return { stdout: "", stderr: "status boom", code: 3, killed: false };
				}
				if (args[0] === "--list-models") {
					return { stdout: "", stderr: "list boom", code: 4, killed: false };
				}
				return { stdout: "print boom", stderr: "", code: 5, killed: false };
			},
		};
		await expect(runCursorAgentStatus(deps)).rejects.toThrow(/status boom/);
		await expect(runCursorAgentListModels(deps)).rejects.toThrow(/list boom/);
		await expect(runCursorAgentPrint({ ...deps, modelId: "auto", prompt: "x" })).rejects.toThrow(/print boom/);
	});

	it("rejects empty list-models output and print JSON without result", async () => {
		await expect(
			runCursorAgentListModels({
				env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent" },
				run: async () => ({
					stdout: "Available models\nTip: use agent --model <id>\n",
					stderr: "",
					code: 0,
					killed: false,
				}),
			}),
		).rejects.toMatchObject({ code: "parse_error" });

		expect(() =>
			parseCursorAgentPrintJson(JSON.stringify({ type: "result", is_error: true, result: "nope" })),
		).toThrow(/nope/);
	});

	it("reports abort vs timeout when the child is killed", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			runCursorAgentStatus({
				env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent" },
				signal: controller.signal,
				timeout: 12_000,
				run: async () => ({ stdout: "", stderr: "", code: 1, killed: true }),
			}),
		).rejects.toThrow(/aborted/);

		await expect(
			runCursorAgentPrint({
				env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent" },
				modelId: "auto",
				prompt: "hi",
				timeout: 99,
				run: async () => ({ stdout: "", stderr: "", code: 1, killed: true }),
			}),
		).rejects.toThrow(/timed out after 99ms/);
	});

	it("formats CLI errors for user-facing messages", () => {
		const error = new CursorAgentCliError("binary_not_found", "missing binary");
		expect(formatCursorAgentCliErrorMessage(error)).toBe("missing binary");
		expect(formatCursorAgentCliErrorMessage(new Error("other"))).toBe("other");
		expect(formatCursorAgentCliErrorMessage("raw")).toBe("raw");
	});
});
