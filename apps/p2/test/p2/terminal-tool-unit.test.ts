// The terminal tool against a recording backend: what each command asks the server for (locations, keys, waits,
// read starts), its results, and replay safety (a rerun of the same tool call reads from the same start and closes
// the same window; the host does keyed calls once).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolExecutionApi, ToolExecutionResult, ToolPark } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type JsonValue } from "@p2/app/v1";
import { createTerminalExtension, type TerminalBackend } from "../../plugins/terminals/tool.ts";

type Info = Awaited<ReturnType<TerminalBackend["open"]>>;
type Read = Awaited<ReturnType<TerminalBackend["read"]>>;

const info = (index: number, extra: Partial<Info> = {}): Info => ({
	id: `id-${index}`,
	sessionId: "s",
	index,
	cwd: "/work",
	env: null,
	title: "",
	createdAt: 0,
	cols: 80,
	rows: 24,
	...extra,
});

/** A backend recording its calls; `read` answers with `reads` in turn (or empty output). */
function recorder(reads: Partial<Read>[] = []) {
	const calls: [string, unknown][] = [];
	let cursor = 100;
	const backend: TerminalBackend = {
		list: async () => {
			calls.push(["list", null]);
			return [
				{ terminal: info(1, { agent: true, name: "dev" }), foreground: "vim" },
				{ terminal: info(2, { env: "gpu", cwd: "/srv", exited: { code: 2 } }) },
			];
		},
		open: async (args) => {
			calls.push(["open", args]);
			return info(3, { cwd: args.location.cwd, env: args.location.env });
		},
		send: async (args) => {
			calls.push(["send", args]);
			return info(1);
		},
		cursor: async (target) => {
			calls.push(["cursor", target]);
			cursor += 10;
			return { terminal: info(Number(target) || 1), offset: cursor };
		},
		read: async (args) => {
			calls.push(["read", args]);
			return {
				terminal: info(1),
				from: args.from ?? 0,
				to: 0,
				text: "",
				skipped: 0,
				truncated: 0,
				...reads.shift(),
			};
		},
		capture: async (args) => {
			calls.push(["capture", args]);
			return { terminal: info(1), text: "screen" };
		},
		close: async (args) => {
			calls.push(["close", args]);
			return { terminalId: args.target };
		},
	};
	return { backend, calls };
}

/** One tool call's API: its task id and memo store (shared by its reruns). */
function callApi(taskId: number): ToolExecutionApi {
	const memos = new Map<string, JsonValue>();
	const api = {
		taskId,
		conversationId: 7,
		memo: async (name: string, candidate: JsonValue | typeof BACKGROUND_CONTEXT, _context?: unknown) => {
			if (!memos.has(name) && candidate !== BACKGROUND_CONTEXT) memos.set(name, candidate as JsonValue);
			return memos.get(name);
		},
	};
	// The tool uses only these members of the API.
	return api as unknown as ToolExecutionApi;
}

function terminal(backend: TerminalBackend, reach: "codemode" | "tool_search" = "codemode", sandbox?: string) {
	const extension = createTerminalExtension(reach, backend, async (api) => {
		assert.equal(api.conversationId, 7);
		return { here: { cwd: "/work/sub", env: "gpu" }, ...(sandbox === undefined ? {} : { sandbox }) };
	});
	return extension.tools![0]!;
}

const run = async (
	backend: TerminalBackend,
	command: string,
	args: string[],
	api = callApi(42),
): Promise<ToolExecutionResult | ToolPark> => terminal(backend).execute({ command, args }, api, BACKGROUND_CONTEXT);

test("code mode only while code mode is on; tool_search reaches it otherwise", () => {
	const { backend } = recorder();
	assert.deepEqual(terminal(backend).callers, ["tools"]);
	assert.equal(terminal(backend).deferred, true);
	assert.equal(terminal(backend).replay, "safe");
	assert.equal(terminal(backend, "tool_search").callers, undefined);
	assert.equal(terminal(backend, "tool_search").deferred, true);
	assert.match(terminal(backend).description, /Only when the user asks for a terminal/);
});

test("new-window opens at the calling conversation's location, keyed by the call, and reads from its start", async () => {
	const { backend, calls } = recorder([{ text: "$ ", terminal: info(3) }]);
	const result = await run(backend, "new-window", ["-n", "dev", "-c", "../web", "npm", "run", "dev"]);
	assert.deepEqual(calls, [
		["open", { key: "42", location: { cwd: "/work/web", env: "gpu" }, name: "dev", command: "npm run dev" }],
		["read", { target: "id-3", from: 0, wait: { until: "quiet", timeoutMs: 10_000 } }],
	]);
	assert.deepEqual(result.structuredOutput, { window: 3, running: true, output: "$ " });
	assert.equal((result.output?.[0] as { text: string }).text, "window 3 · at the prompt\n$ ");
	const absolute = recorder();
	await run(absolute.backend, "new-window", ["-c", "/tmp", "-w", "none"]);
	assert.deepEqual(absolute.calls, [
		["open", { key: "42", location: { cwd: "/tmp", env: "gpu" } }],
		["read", { target: "id-3", from: 0 }],
	]);
});

test("send-keys and read wait by default as documented; -w and -T override", async () => {
	const { backend, calls } = recorder();
	await run(backend, "send-keys", ["-t", "1", "q"], callApi(1));
	await run(backend, "send-keys", ["-t", "1", "-w", "none", "-l", "C-c"], callApi(2));
	await run(backend, "read", ["-t", "1"], callApi(3));
	await run(backend, "read", ["-t", "1", "-w", "/x/i", "-T", "2"], callApi(4));
	assert.deepEqual(calls, [
		["cursor", "1"],
		["send", { key: "1", target: "id-1", keys: ["q"], literal: false }],
		["read", { target: "id-1", from: 110, wait: { until: "quiet", timeoutMs: 5000 } }],
		["cursor", "1"],
		["send", { key: "2", target: "id-1", keys: ["C-c"], literal: true }],
		["read", { target: "id-1", from: 120 }],
		["cursor", "1"],
		["read", { target: "id-1", from: 130 }],
		["cursor", "1"],
		[
			"read",
			{ target: "id-1", from: 140, wait: { until: "match", pattern: "x", ignoreCase: true, timeoutMs: 2000 } },
		],
	]);
});

test("a rerun of the same call reads from the same start and closes the same window", async () => {
	const { backend, calls } = recorder();
	const api = callApi(9);
	await run(backend, "send-keys", ["-t", "1", "ls", "Enter"], api);
	await run(backend, "send-keys", ["-t", "1", "ls", "Enter"], api);
	// One cursor: the rerun's start is the memoized one; the send repeats with the same key (the host does it once).
	assert.deepEqual(
		calls.filter(([name]) => name !== "read"),
		[
			["cursor", "1"],
			["send", { key: "9", target: "id-1", keys: ["ls", "Enter"], literal: false }],
			["send", { key: "9", target: "id-1", keys: ["ls", "Enter"], literal: false }],
		],
	);
	assert.deepEqual(
		calls.filter(([name]) => name === "read").map(([, args]) => (args as { from: number }).from),
		[110, 110],
	);
	const killing = recorder();
	const kill = callApi(10);
	assert.deepEqual((await run(killing.backend, "kill-window", ["-t", "2"], kill)).structuredOutput, {
		window: 2,
		killed: true,
	});
	await run(killing.backend, "kill-window", ["-t", "2"], kill);
	assert.deepEqual(killing.calls, [
		["cursor", "2"],
		["close", { key: "10", target: "id-2" }],
		["close", { key: "10", target: "id-2" }],
	]);
});

test("results: the screen of full-screen programs, skipped output, timeouts, windows, errors", async () => {
	const long = "x".repeat(20_000);
	const { backend } = recorder([
		{ text: "ignored", screen: "VIM", foreground: "vim", waited: "timeout" },
		{ text: long, skipped: 5, truncated: 7, terminal: info(1, { exited: { code: 1 } }) },
	]);
	const screen = await run(backend, "read", ["-t", "1"]);
	assert.deepEqual(screen.structuredOutput, {
		window: 1,
		running: true,
		foreground: "vim",
		output: "VIM",
		screen: true,
		timedOut: true,
	});
	assert.equal(
		(screen.output?.[0] as { text: string }).text,
		"window 1 · running vim · full-screen program\nVIM\n(timed out: still running (foreground: vim))",
	);
	const skipped = (await run(backend, "read", ["-t", "1"])).structuredOutput as { output: string; skipped: number };
	assert.equal(skipped.output.length, 16 * 1024);
	assert.equal(skipped.skipped, 5 + 7 + 20_000 - 16 * 1024);
	const listed = await run(backend, "list-windows", []);
	assert.deepEqual(listed.structuredOutput, {
		windows: [
			{ window: 1, name: "dev", location: "/work", opener: "agent", running: true, foreground: "vim" },
			{ window: 2, location: "gpu:/srv", opener: "user", running: false, exitCode: 2 },
		],
	});
	assert.equal(
		(listed.output?.[0] as { text: string }).text,
		"1: dev · /work · opened by agent · running vim\n2: gpu:/srv · opened by user · exited with code 2",
	);
	assert.deepEqual(await run(backend, "kill-window", []), {
		output: [{ type: "text", text: "usage: kill-window -t target-window" }],
		isError: true,
	});
	const failing: TerminalBackend = {
		...backend,
		cursor: async () => {
			throw new Error("can't find window: 9");
		},
	};
	assert.deepEqual(await run(failing, "read", ["-t", "9"]), {
		output: [{ type: "text", text: "can't find window: 9" }],
		isError: true,
	});
});

test("a caller in a sandbox sees and drives only the session's terminals in it", async () => {
	const { backend, calls } = recorder();
	const confined = terminal(backend, "codemode", "gpu");
	const call = (command: string, args: string[], taskId: number) =>
		confined.execute({ command, args }, callApi(taskId), BACKGROUND_CONTEXT);
	const listed = await call("list-windows", [], 1);
	assert.deepEqual(
		(listed.structuredOutput as { windows: { window: number }[] }).windows.map((window) => window.window),
		[2],
	);
	// Window 1 runs on this device (env null), outside the sandbox.
	for (const [command, args] of [
		["send-keys", ["-t", "1", "rm -rf ~"]],
		["read", ["-t", "1"]],
		["capture-pane", ["-t", "1"]],
		["kill-window", ["-t", "1"]],
	] as const) {
		const result = await call(command, [...args], 2);
		assert.equal(result.isError, true, command);
		assert.match((result.output?.[0] as { text: string }).text, /outside sandbox gpu/);
	}
	assert(!calls.some(([name]) => ["send", "read", "capture", "close"].includes(name)), JSON.stringify(calls));
	// A rerun after the conversation was moved into the sandbox: the window its first run remembered is refused too.
	const api = callApi(9);
	await terminal(backend).execute({ command: "send-keys", args: ["-t", "1", "ls"] }, api, BACKGROUND_CONTEXT);
	const sends = calls.filter(([name]) => name === "send").length;
	const rerun = await confined.execute({ command: "send-keys", args: ["-t", "1", "ls"] }, api, BACKGROUND_CONTEXT);
	assert.equal(rerun.isError, true);
	assert.equal(calls.filter(([name]) => name === "send").length, sends);
});
