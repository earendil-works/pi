// The agent's `terminal` tool (worker): tmux commands as argv on the session's terminals, the ones the owner sees in
// the terminal panel. Code mode scripts call it (`tools.terminal({ command, args })`); without code mode `tool_search`
// loads it, as MCP tools. Replay-safe: the host does a call with the tool call's key once, and reads start where the
// first attempt's did (memoized), so a call a restart interrupted runs again without typing or opening twice.

import {
	defineExtension,
	defineTool,
	type Extension,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { arr, bool, int, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { type Context, isRooted, joinPath, type Location, literal } from "@p2/app/v1";
import {
	COMMANDS,
	CommandError,
	parseCommand,
	type TerminalCommand,
	type WaitFor,
	type WaitOptions,
} from "./commands.ts";
import type { TerminalInfoSchema, TerminalReadSchema, TerminalWaitSchema } from "./contract.ts";

type Info = Static<typeof TerminalInfoSchema>;
type Read = Static<typeof TerminalReadSchema>;
type Wait = Static<typeof TerminalWaitSchema>;

/** The server's terminal calls for this session (`AgentTerminals`), each cancelled with `context`. */
export type TerminalBackend = {
	list(context: Context): Promise<{ terminal: Info; foreground?: string }[]>;
	open(args: { key: string; location: Location; name?: string; command?: string }, context: Context): Promise<Info>;
	send(args: { key: string; target: string; keys: string[]; literal: boolean }, context: Context): Promise<Info>;
	cursor(target: string, context: Context): Promise<{ terminal: Info; offset: number }>;
	read(args: { target: string; from?: number; wait?: Wait }, context: Context): Promise<Read>;
	capture(
		args: { target: string; scrollback: number; escapes: boolean },
		context: Context,
	): Promise<{ terminal: Info; text: string }>;
	close(args: { key: string; target: string }, context: Context): Promise<{ terminalId: string }>;
};

/**
 * How the model reaches the tool, as MCP tools: from code mode scripts (`searchTools()` finds it), or, without code
 * mode, by loading it with `tool_search`.
 */
export type TerminalReach = "codemode" | "tool_search";

export const TERMINAL_EXTENSION = "p2-terminals";

/** Characters of output a call returns at most: the last ones. */
const OUTPUT_CHARS = 16 * 1024;
/** Timeouts of waits by default, in seconds: send-keys returns sooner, its program usually answers at once. */
const DEFAULT_TIMEOUT_S = 10;
const SEND_TIMEOUT_S = 5;

const DESCRIPTION = `Use the session's terminals, the ones the user sees in p2's terminal panel, like tmux. Only when the user asks for a terminal, or to drive an interactive program in one; never instead of bash.
Call tools.terminal({ command, args }), args being tmux's argv after the command name (no quoting). Windows are numbered per session (1, 2, ...); -t takes a number or a name.
- new-window [-n name] [-c dir] [-w W] [-T s] [command ...]: a shell at your cwd (-c: relative to it); command is typed into it, then Enter.
- list-windows
- send-keys -t T [-l] [-w W] [-T s] key ...: tmux key names (Enter, C-c, Up, Escape, Tab, BSpace, M-x, F1) are keys, other args text; -l: all text.
- read -t T [-w W] [-T s]: output since your last read.
- capture-pane -t T [-S -N] [-e]: the screen, plus N scrollback lines; -e keeps colors.
- kill-window -t T
new-window, send-keys and read return the output since your last read of that window, after waiting: W is quiet (0.5 s without output; the default of new-window and send-keys), exit, /regex/ or none (read's default); -T is the timeout in seconds (default 10, send-keys 5, max 120). A timeout is no error.
Result: { window, output, running, foreground?, exitCode?, screen?, skipped?, timedOut? }; output is plain text, or a full-screen program's screen (screen: true); list-windows: { windows }.
const { window } = await tools.terminal({ command: "new-window", args: ["-n", "dev", "npm run dev"] });
await tools.terminal({ command: "send-keys", args: ["-t", String(window), "C-c"] });`;

const WindowSchema = obj({
	window: int(),
	name: opt(str()),
	title: opt(str()),
	location: str(),
	opener: union([literal("user"), literal("agent")]),
	running: bool(),
	foreground: opt(str()),
	exitCode: opt(int()),
	error: opt(str()),
});
/** What scripts get: one shape for every command, its fields as they apply. */
const ResultSchema = obj({
	window: opt(int()),
	output: opt(str()),
	running: opt(bool()),
	foreground: opt(str()),
	exitCode: opt(int()),
	error: opt(str()),
	screen: opt(bool()),
	skipped: opt(int()),
	timedOut: opt(bool()),
	killed: opt(bool()),
	windows: opt(arr(WindowSchema)),
});
type Result = Static<typeof ResultSchema>;

/** The extension offering the `terminal` tool, reached as `reach` says. */
export function createTerminalExtension(
	reach: TerminalReach,
	backend: TerminalBackend,
	locate: (api: ToolExecutionApi, context: Context) => Promise<Location>,
): Extension {
	return defineExtension({
		name: TERMINAL_EXTENSION,
		tools: [
			defineTool({
				name: "terminal",
				description: DESCRIPTION,
				parameters: obj({
					command: union(COMMANDS.map((name) => literal(name))),
					args: opt(arr(str(), { description: "tmux's arguments after the command name, one per element." })),
				}),
				structuredOutputSchema: ResultSchema,
				// Not offered to the model; only scripts call it while code mode is on.
				deferred: true,
				...(reach === "codemode" ? { callers: ["tools" as const] } : {}),
				outputLimits: { maxBytes: OUTPUT_CHARS + 1024, retain: "tail" },
				replay: "safe",
				execute: async (args, api, context) => {
					let command: TerminalCommand;
					try {
						command = parseCommand(args.command, args.args ?? []);
					} catch (error) {
						if (error instanceof CommandError) return failure(error.message);
						throw error;
					}
					try {
						const { result, terminalId } = await run(command, backend, locate, api, context);
						return {
							output: [{ type: "text", text: describe(result) }],
							structuredOutput: result,
							// The card's link to the window.
							details: {
								command: args.command,
								args: args.args ?? [],
								...(result.window === undefined ? {} : { window: result.window }),
								...(terminalId === undefined ? {} : { terminalId }),
							},
						};
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						return failure(error instanceof Error ? error.message : String(error));
					}
				},
			}),
		],
	});
}

function failure(text: string): ToolExecutionResult {
	return { output: [{ type: "text", text }], isError: true };
}

async function run(
	command: TerminalCommand,
	backend: TerminalBackend,
	locate: (api: ToolExecutionApi, context: Context) => Promise<Location>,
	api: ToolExecutionApi,
	context: Context,
): Promise<{ result: Result; terminalId?: string }> {
	const key = String(api.taskId);
	const read = async (args: Parameters<TerminalBackend["read"]>[0]) => {
		const value = await backend.read(args, context);
		return { result: readResult(value), terminalId: value.terminal.id };
	};
	switch (command.command) {
		case "new-window": {
			const here = await locate(api, context);
			const directory = command.directory;
			const location =
				directory === undefined
					? here
					: { env: here.env, cwd: isRooted(directory) ? directory : joinPath(here.cwd, directory) };
			const opened = await backend.open(
				{
					key,
					location,
					...(command.name ? { name: command.name } : {}),
					...(command.shellCommand ? { command: command.shellCommand } : {}),
				},
				context,
			);
			const wait = waitOf(command, { kind: "quiet" }, DEFAULT_TIMEOUT_S);
			return read({ target: opened.id, from: 0, ...(wait ? { wait } : {}) });
		}
		case "list-windows": {
			const windows = await backend.list(context);
			return { result: { windows: windows.map(({ terminal, foreground }) => windowOf(terminal, foreground)) } };
		}
		case "send-keys": {
			const start = await readStart(command.target, backend, api, context);
			await backend.send({ key, target: start.id, keys: command.keys, literal: command.literal }, context);
			const wait = waitOf(command, { kind: "quiet" }, SEND_TIMEOUT_S);
			return read({ target: start.id, from: start.offset, ...(wait ? { wait } : {}) });
		}
		case "read": {
			const start = await readStart(command.target, backend, api, context);
			const wait = waitOf(command, { kind: "none" }, DEFAULT_TIMEOUT_S);
			return read({ target: start.id, from: start.offset, ...(wait ? { wait } : {}) });
		}
		case "capture-pane": {
			const { target, scrollback, escapes } = command;
			const { terminal, text } = await backend.capture({ target, scrollback, escapes }, context);
			return { result: { ...stateOf(terminal), ...cut(text, 0) }, terminalId: terminal.id };
		}
		case "kill-window": {
			// A rerun closes the window the first attempt found, never another that took its number since.
			const known = await api.memo<{ id: string; window: number }>("window", context);
			const target = known ?? (await backend.cursor(command.target, context)).terminal;
			const window = "window" in target ? target.window : target.index;
			await api.memo("window", { id: target.id, window }, context);
			await backend.close({ key, target: target.id }, context);
			return { result: { window, killed: true } };
		}
	}
}

/** Where this call's read starts: the window's read cursor when the call first ran (memoized for a rerun). */
async function readStart(
	target: string,
	backend: TerminalBackend,
	api: ToolExecutionApi,
	context: Context,
): Promise<{ id: string; offset: number }> {
	const known = await api.memo<{ id: string; offset: number }>("start", context);
	if (known) return known;
	const { terminal, offset } = await backend.cursor(target, context);
	return api.memo("start", { id: terminal.id, offset }, context);
}

/** The wait a command asks for, or its default; none for `-w none`. */
function waitOf(options: WaitOptions, fallback: WaitFor, timeout: number): Wait | undefined {
	const wait = options.wait ?? fallback;
	const timeoutMs = Math.round((options.timeout ?? timeout) * 1000);
	switch (wait.kind) {
		case "none":
			return undefined;
		case "quiet":
		case "exit":
			return { until: wait.kind, timeoutMs };
		case "match":
			return { until: "match", pattern: wait.pattern, ...(wait.ignoreCase ? { ignoreCase: true } : {}), timeoutMs };
	}
}

function readResult(read: Read): Result {
	const screen = read.screen !== undefined;
	return {
		...stateOf(read.terminal, read.foreground),
		...cut(read.screen ?? read.text, screen ? 0 : read.skipped + read.truncated),
		...(screen ? { screen: true } : {}),
		...(read.waited === "timeout" ? { timedOut: true } : {}),
	};
}

/** The output's last `OUTPUT_CHARS`, with what was left out before it counted in `skipped`. */
function cut(text: string, skipped: number): { output: string; skipped?: number } {
	const over = Math.max(0, text.length - OUTPUT_CHARS);
	const total = skipped + over;
	return { output: over ? text.slice(over) : text, ...(total ? { skipped: total } : {}) };
}

function stateOf(terminal: Info, foreground?: string): Result {
	return {
		window: terminal.index,
		running: terminal.exited === undefined,
		...(foreground ? { foreground } : {}),
		...(terminal.exited?.code === undefined ? {} : { exitCode: terminal.exited.code }),
		...(terminal.exited?.error === undefined ? {} : { error: terminal.exited.error }),
	};
}

function windowOf(terminal: Info, foreground: string | undefined): Static<typeof WindowSchema> {
	return {
		window: terminal.index,
		...(terminal.name ? { name: terminal.name } : {}),
		...(terminal.title ? { title: terminal.title } : {}),
		location: terminal.env ? `${terminal.env}:${terminal.cwd}` : terminal.cwd,
		opener: terminal.agent ? "agent" : "user",
		...stateOf(terminal, foreground),
		running: terminal.exited === undefined,
	};
}

/** The result as the transcript and the model (without code mode) read it. */
function describe(result: Result): string {
	if (result.windows)
		return result.windows.length === 0
			? "No windows."
			: result.windows
					.map(
						(window) =>
							`${window.window}: ${[
								window.name ?? window.title ?? "",
								window.location,
								`opened by ${window.opener}`,
								status(window),
							]
								.filter(Boolean)
								.join(" · ")}`,
					)
					.join("\n");
	if (result.killed) return `Killed window ${result.window}.`;
	const lines = [`window ${result.window} · ${status(result)}${result.screen ? " · full-screen program" : ""}`];
	if (result.skipped) lines.push(`… ${result.skipped} characters skipped`);
	if (result.output) lines.push(result.output);
	if (result.timedOut && result.running)
		lines.push(`(timed out: still running${result.foreground ? ` (foreground: ${result.foreground})` : ""})`);
	return lines.join("\n");
}

function status(result: Pick<Result, "running" | "foreground" | "exitCode" | "error">): string {
	if (result.running) return result.foreground ? `running ${result.foreground}` : "at the prompt";
	if (result.error) return `failed: ${result.error}`;
	return `exited${result.exitCode === undefined ? "" : ` with code ${result.exitCode}`}`;
}
