import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { APP_NAME } from "../../../src/config.ts";
import type { SessionManager } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

// Regression for https://github.com/earendil-works/pi/issues/5080
//
// On SIGTERM/SIGHUP the graceful shutdown must emit `session_shutdown`
// (runtimeHost.dispose) BEFORE touching the terminal. Extension teardown such
// as removing a socket does not write to the tty, so it must not be skipped if
// a later terminal-restore write fails on a dead or stalled terminal. The
// interactive quit path (Ctrl+D, /quit) keeps the opposite order to preserve
// the final TUI frame.

type ShutdownThis = {
	isShuttingDown: boolean;
	unregisterSignalHandlers: () => void;
	runtimeHost: { dispose: () => Promise<void> };
	ui: { terminal: { drainInput: (ms: number) => Promise<void> } };
	themeController: { disableAutoSync: () => void };
	stop: () => void;
	sessionManager: SessionManager;
};

type InteractiveModePrototypeWithShutdown = {
	shutdown(this: ShutdownThis, options?: { fromSignal?: boolean }): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown;
const tempDirs: string[] = [];
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

class ProcessExitError extends Error {
	readonly code: number | undefined;
	constructor(code?: number) {
		super(`process.exit(${code})`);
		this.code = code;
	}
}

function createSessionManager(options: { sessionFile?: string } = {}): SessionManager {
	return {
		isPersisted: () => options.sessionFile !== undefined,
		getSessionFile: () => options.sessionFile,
		getSessionId: () => "test-session",
		getSessionDir: () => "/tmp/pi-sessions",
		usesDefaultSessionDir: () => true,
	} as unknown as SessionManager;
}

function createTempFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-shutdown-resume-hint-"));
	tempDirs.push(dir);
	const file = join(dir, "session.jsonl");
	writeFileSync(file, "\n");
	return file;
}

function setStdoutIsTTY(value: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function restoreStdoutIsTTY(): void {
	if (originalStdoutIsTTY) {
		Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
	} else {
		Reflect.deleteProperty(process.stdout, "isTTY");
	}
}

function createContext(order: string[], sessionManager = createSessionManager()): ShutdownThis {
	return {
		isShuttingDown: false,
		unregisterSignalHandlers: vi.fn(),
		runtimeHost: {
			dispose: vi.fn(async () => {
				order.push("dispose");
			}),
		},
		ui: {
			terminal: {
				drainInput: vi.fn(async () => {
					order.push("drainInput");
				}),
			},
		},
		themeController: { disableAutoSync: vi.fn() },
		stop: vi.fn(() => {
			order.push("stop");
		}),
		sessionManager,
	};
}

async function callShutdown(context: ShutdownThis, options?: { fromSignal?: boolean }): Promise<void> {
	try {
		await (interactiveModePrototype as InteractiveModePrototypeWithShutdown).shutdown.call(context, options);
	} catch (error) {
		if (!(error instanceof ProcessExitError)) throw error;
	}
}

describe("InteractiveMode.shutdown ordering (#5080)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		restoreStdoutIsTTY();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("signal-triggered shutdown emits session_shutdown before terminal writes", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual(["dispose", "drainInput", "stop"]);
		expect(context.isShuttingDown).toBe(true);
	});

	test("interactive quit stops the TUI before emitting session_shutdown", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);

		await callShutdown(context);

		expect(order).toEqual(["drainInput", "stop", "dispose"]);
	});

	test("interactive quit prints a resume hint for persisted sessions", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const stdoutWrite = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((() => true) as typeof process.stdout.write);
		setStdoutIsTTY(true);
		const order: string[] = [];
		const context = createContext(order, createSessionManager({ sessionFile: createTempFile() }));

		await callShutdown(context);

		expect(order).toEqual(["drainInput", "stop", "dispose"]);
		expect(stdoutWrite).toHaveBeenCalledWith(
			// Command on its own line (#12237).
			`${chalk.dim("To resume this session:")}\n${APP_NAME} --session test-session\n`,
		);
	});

	test("signal-triggered shutdown does not print a resume hint", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const stdoutWrite = vi
			.spyOn(process.stdout, "write")
			.mockImplementation((() => true) as typeof process.stdout.write);
		setStdoutIsTTY(true);
		const order: string[] = [];
		const context = createContext(order, createSessionManager({ sessionFile: createTempFile() }));

		await callShutdown(context, { fromSignal: true });

		for (const call of stdoutWrite.mock.calls) {
			expect(call[0]).not.toContain("To resume this session:");
		}
	});

	test("re-entrant shutdown is a no-op", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);
		const order: string[] = [];
		const context = createContext(order);
		context.isShuttingDown = true;

		await callShutdown(context, { fromSignal: true });

		expect(order).toEqual([]);
		expect(context.runtimeHost.dispose).not.toHaveBeenCalled();
	});
});

// Regression for the `read EIO` crash reports (crash_tty_read_eio) and #12317.
//
// When the terminal goes away, stdin reads and setRawMode fail with EIO (pi is
// left in an orphaned background process group) or ENOTTY (macOS revoked the
// tty), and writes fail with EIO or EPIPE. On Windows a dead console host sends
// no signal at all: every write fails with EPIPE. Node emits these as `error`
// events on the std streams. pi must then shut down like a hangup: let
// extensions clean up (session_shutdown) without writing to the terminal, then
// exit with 129, and never record a crash.

type HandlerContext = {
	isShuttingDown: boolean;
	terminalLost: boolean;
	signalCleanupHandlers: Array<() => void>;
	runtimeHost: { dispose: () => Promise<void> };
	shutdown: () => Promise<void>;
	unregisterSignalHandlers: () => void;
	handleTerminalLost: () => void;
	uncaughtCrash: (error: Error) => never;
	recordCrash: () => boolean;
	getCrashExtensionHint: () => string | undefined;
	crashReportInstructions: () => string;
	ui: { stop: () => void };
};

type InteractiveModePrivates = {
	registerSignalHandlers(this: HandlerContext): void;
	unregisterSignalHandlers(this: HandlerContext): void;
	handleTerminalLost(this: HandlerContext): void;
	uncaughtCrash(this: HandlerContext, error: Error): never;
};

const proto = InteractiveMode.prototype as unknown as InteractiveModePrivates;

function createHandlerContext(dispose: () => Promise<void>): HandlerContext {
	const context: HandlerContext = {
		isShuttingDown: false,
		terminalLost: false,
		signalCleanupHandlers: [],
		runtimeHost: { dispose: vi.fn(dispose) },
		shutdown: vi.fn(async () => {}),
		unregisterSignalHandlers: () => proto.unregisterSignalHandlers.call(context),
		handleTerminalLost: () => proto.handleTerminalLost.call(context),
		uncaughtCrash: (error: Error) => proto.uncaughtCrash.call(context, error),
		recordCrash: vi.fn(() => true),
		getCrashExtensionHint: () => undefined,
		crashReportInstructions: () => "",
		ui: { stop: vi.fn() },
	};
	return context;
}

function errnoError(message: string, code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

describe("lost terminal", () => {
	let context: HandlerContext | undefined;

	afterEach(() => {
		context?.unregisterSignalHandlers();
		context = undefined;
		// Drops the pending forced-exit timer, which would call the real process.exit later.
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function setup(dispose: () => Promise<void> = async () => {}) {
		vi.useFakeTimers();
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
		vi.spyOn(console, "error").mockImplementation(() => {});
		context = createHandlerContext(dispose);
		proto.registerSignalHandlers.call(context);
		return { ctx: context, exit };
	}

	test.each([
		["stdin", process.stdin, "read EIO", "EIO"],
		["stdin", process.stdin, "setRawMode EIO", "EIO"],
		["stdin", process.stdin, "setRawMode ENOTTY", "ENOTTY"],
		["stdout", process.stdout, "write EIO", "EIO"],
		// Windows: the console host exited (#12317).
		["stdout", process.stdout, "write EPIPE", "EPIPE"],
	])(
		"%s %s runs session cleanup, then exits with 129 without recording a crash",
		async (_name, stream, message, code) => {
			const { ctx, exit } = setup();

			stream.emit("error", errnoError(message, code));
			expect(exit).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(0);

			expect(ctx.runtimeHost.dispose).toHaveBeenCalledOnce();
			expect(exit).toHaveBeenCalledWith(129);
			expect(ctx.recordCrash).not.toHaveBeenCalled();
			expect(ctx.ui.stop).not.toHaveBeenCalled();
		},
	);

	test("repeated errors run session cleanup once", async () => {
		const { ctx } = setup();

		process.stdout.emit("error", errnoError("write EPIPE", "EPIPE"));
		process.stdout.emit("error", errnoError("write EPIPE", "EPIPE"));
		process.stdin.emit("error", errnoError("read EIO", "EIO"));
		await vi.advanceTimersByTimeAsync(0);

		expect(ctx.runtimeHost.dispose).toHaveBeenCalledOnce();
	});

	test("hung session cleanup is cut off by the exit timeout", async () => {
		const { exit } = setup(() => new Promise(() => {}));

		process.stdout.emit("error", errnoError("write EPIPE", "EPIPE"));
		await vi.advanceTimersByTimeAsync(4999);
		expect(exit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(exit).toHaveBeenCalledWith(129);
	});

	test("a running shutdown (SIGHUP) is not cut short, only bounded", async () => {
		const { ctx, exit } = setup();
		ctx.isShuttingDown = true;

		process.stdout.emit("error", errnoError("write EIO", "EIO"));
		await vi.advanceTimersByTimeAsync(4999);
		expect(ctx.runtimeHost.dispose).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(exit).toHaveBeenCalledWith(129);
	});

	test("other stdin errors still crash", () => {
		setup();
		const error = errnoError("read ECONNREFUSED", "ECONNREFUSED");

		expect(() => process.stdin.emit("error", error)).toThrow(error);
	});

	test("uncaught EPIPE from outside the terminal is recorded as a crash (#12317)", () => {
		// For example a write to the stdin of an exited child process. It used to exit silently with 129.
		const { ctx, exit } = setup();

		ctx.uncaughtCrash(errnoError("write EPIPE", "EPIPE"));

		expect(exit).toHaveBeenCalledWith(1);
		expect(ctx.recordCrash).toHaveBeenCalledOnce();
		expect(ctx.runtimeHost.dispose).not.toHaveBeenCalled();
	});

	test("handlers are removed on unregister", () => {
		const { ctx } = setup();
		const before = process.stdin.listenerCount("error");

		ctx.unregisterSignalHandlers();

		expect(process.stdin.listenerCount("error")).toBe(before - 1);
	});
});
