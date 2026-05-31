import { describe, expect, it } from "vitest";
import { compactLabel, registerCmuxBridge } from "../examples/extensions/cmux.ts";
import type { ExecOptions, ExecResult, ExtensionAPI, ExtensionContext } from "../src/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

interface ExecCall {
	command: string;
	args: string[];
	options: ExecOptions | undefined;
}

function ok(stdout = ""): ExecResult {
	return { stdout, stderr: "", code: 0, killed: false };
}

function createBridgeHarness(env: Record<string, string | undefined> = {}) {
	const calls: ExecCall[] = [];
	const handlers = new Map<string, Handler[]>();
	const exec = async (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
		calls.push({ command, args, options });
		if (command === "git") return ok("omp-cmux-bridge\n");
		return ok();
	};
	const on = ((event: string, handler: Handler) => {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	}) as ExtensionAPI["on"];
	const api = { exec, on } satisfies Pick<ExtensionAPI, "exec" | "on">;
	const ctx = { cwd: "/tmp/pi project" } as ExtensionContext;

	registerCmuxBridge(api, { exec, env });

	return {
		calls,
		exec,
		emit: async (type: string, event: Record<string, unknown> = {}) => {
			for (const handler of handlers.get(type) ?? []) {
				await handler({ type, ...event }, ctx);
			}
		},
	};
}

function cmuxCalls(calls: ExecCall[]): string[][] {
	return calls.filter((call) => call.command === "cmux").map((call) => call.args);
}

describe("cmux extension", () => {
	it("mirrors session start into cmux status, progress, and git branch", async () => {
		const harness = createBridgeHarness();

		await harness.emit("session_start", { reason: "startup" });

		expect(cmuxCalls(harness.calls)).toEqual([
			["set-status", "working_dir", "/tmp/pi project", "--icon", "folder", "--color", "#34D399"],
			["set-status", "agent_omp", "Ready — pi project", "--icon", "sparkles", "--color", "#34D399"],
			["set-progress", "0.00", "--label", "Idle — OMP Ready"],
			["set-status", "git_branch", "omp-cmux-bridge", "--icon", "arrow.triangle.branch", "--color", "#34D399"],
		]);
		expect(harness.calls.find((call) => call.command === "git")?.args).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
	});

	it("logs prompt and tool lifecycle as argument arrays", async () => {
		const harness = createBridgeHarness();

		await harness.emit("before_agent_start", {
			prompt: "ship\nthis\tbridge",
			systemPrompt: "",
			systemPromptOptions: {},
		});
		await harness.emit("tool_execution_start", { toolCallId: "tool-1", toolName: "bash; rm -rf /", args: {} });
		await harness.emit("tool_execution_end", {
			toolCallId: "tool-1",
			toolName: "bash; rm -rf /",
			result: {},
			isError: false,
		});

		expect(cmuxCalls(harness.calls)).toContainEqual([
			"log",
			"--level",
			"info",
			"--source",
			"omp",
			"--",
			"Prompt: ship this bridge",
		]);
		expect(cmuxCalls(harness.calls)).toContainEqual([
			"set-status",
			"agent_omp_tool",
			"bash; rm -rf /",
			"--icon",
			"terminal",
			"--color",
			"#FBBF24",
		]);
		expect(cmuxCalls(harness.calls)).toContainEqual(["clear-status", "agent_omp_tool"]);
	});

	it("disables cmux calls after a cmux execution failure", async () => {
		const calls: ExecCall[] = [];
		const handlers = new Map<string, Handler[]>();
		const exec = async (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
			calls.push({ command, args, options });
			if (command === "cmux") throw new Error("ENOENT");
			return ok("main\n");
		};
		const on = ((event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		}) as ExtensionAPI["on"];
		const api = { exec, on } satisfies Pick<ExtensionAPI, "exec" | "on">;
		const ctx = { cwd: "/tmp/pi" } as ExtensionContext;
		registerCmuxBridge(api, { exec, env: {} });

		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ type: "session_start", reason: "startup" }, ctx);
		}
		for (const handler of handlers.get("agent_end") ?? []) {
			await handler({ type: "agent_end", messages: [] }, ctx);
		}

		expect(calls.filter((call) => call.command === "cmux")).toHaveLength(1);
		expect(calls.some((call) => call.command === "git")).toBe(true);
	});

	it("still cleans stale status after a later persistent cmux failure", async () => {
		const calls: ExecCall[] = [];
		const handlers = new Map<string, Handler[]>();
		let cmuxCallCount = 0;
		const exec = async (command: string, args: string[], options?: ExecOptions): Promise<ExecResult> => {
			calls.push({ command, args, options });
			if (command !== "cmux") return ok("main\n");

			cmuxCallCount++;
			if (cmuxCallCount === 2) throw new Error("transient cmux timeout");
			return ok();
		};
		const on = ((event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		}) as ExtensionAPI["on"];
		const api = { exec, on } satisfies Pick<ExtensionAPI, "exec" | "on">;
		const ctx = { cwd: "/tmp/pi" } as ExtensionContext;
		registerCmuxBridge(api, { exec, env: {} });

		for (const handler of handlers.get("tool_execution_start") ?? []) {
			await handler({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {} }, ctx);
		}
		for (const handler of handlers.get("agent_end") ?? []) {
			await handler({ type: "agent_end", messages: [] }, ctx);
		}

		expect(cmuxCalls(calls)).toContainEqual(["clear-status", "agent_omp_tool"]);
		expect(cmuxCalls(calls)).toContainEqual([
			"set-status",
			"agent_omp",
			"Ready",
			"--icon",
			"checkmark",
			"--color",
			"#34D399",
		]);
		expect(cmuxCalls(calls)).toContainEqual(["set-progress", "1.00", "--label", "Idle — OMP Ready"]);
	});

	it("sends completion notification only when explicitly enabled", async () => {
		const defaultHarness = createBridgeHarness();
		await defaultHarness.emit("agent_end", { messages: [] });
		expect(cmuxCalls(defaultHarness.calls).some((args) => args[0] === "notify")).toBe(false);

		const notifyHarness = createBridgeHarness({ OMP_CMUX_NOTIFY: "true" });
		await notifyHarness.emit("agent_end", { messages: [] });
		expect(cmuxCalls(notifyHarness.calls)).toContainEqual([
			"notify",
			"--title",
			"OMP Ready",
			"--body",
			"Agent finished and is waiting",
		]);
	});

	it("compacts control characters and long labels", () => {
		expect(compactLabel("  one\n\ttwo  ")).toBe("one two");
		expect(compactLabel("abcdefghijklmnopqrstuvwxyz", 8)).toBe("abcdefg…");
	});
});
