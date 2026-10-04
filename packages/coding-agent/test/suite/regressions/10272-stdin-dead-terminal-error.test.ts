import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

// Regression for https://github.com/earendil-works/pi/issues/10272
//
// When the controlling terminal vanishes while stdin is held in raw mode,
// Node raises `read EIO` on the stdin read stream. stdout/stderr already
// route dead-terminal errors (EIO/EPIPE/ENOTCONN) to emergencyTerminalExit
// (exit 129, no crash record); stdin must do the same instead of letting the
// error reach uncaughtException and crash telemetry.

class ProcessExitError extends Error {}

type RegisterSignalHandlersThis = {
	signalCleanupHandlers: Array<() => void>;
	emergencyTerminalExit: () => never;
	unregisterSignalHandlers: () => void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	registerSignalHandlers(this: RegisterSignalHandlersThis): void;
	unregisterSignalHandlers(this: { signalCleanupHandlers: Array<() => void> }): void;
};

function stdinError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`read ${code}`), { code }) as NodeJS.ErrnoException;
}

function makeContext(): RegisterSignalHandlersThis {
	const context: RegisterSignalHandlersThis = {
		signalCleanupHandlers: [],
		emergencyTerminalExit: vi.fn(() => {
			throw new ProcessExitError();
		}),
		unregisterSignalHandlers: () => {
			interactiveModePrototype.unregisterSignalHandlers.call(context);
		},
	};
	return context;
}

describe("InteractiveMode stdin dead-terminal errors (#10272)", () => {
	let context: RegisterSignalHandlersThis;

	afterEach(() => {
		interactiveModePrototype.unregisterSignalHandlers.call(context);
		vi.restoreAllMocks();
	});

	test("dead-terminal stdin errors reach emergencyTerminalExit, not uncaughtException", () => {
		context = makeContext();
		interactiveModePrototype.registerSignalHandlers.call(context);

		for (const code of ["EIO", "EPIPE", "ENOTCONN"]) {
			vi.clearAllMocks();
			expect(() => process.stdin.emit("error", stdinError(code))).toThrow(ProcessExitError);
			expect(context.emergencyTerminalExit).toHaveBeenCalledTimes(1);
		}
	});

	test("non-dead-terminal stdin errors still propagate to uncaughtException", () => {
		context = makeContext();
		interactiveModePrototype.registerSignalHandlers.call(context);

		const error = stdinError("EINVAL");
		expect(() => process.stdin.emit("error", error)).toThrow(error);
		expect(context.emergencyTerminalExit).not.toHaveBeenCalled();
	});

	test("stdin error listener is removed on cleanup", () => {
		context = makeContext();
		const baseline = process.stdin.listenerCount("error");
		interactiveModePrototype.registerSignalHandlers.call(context);
		expect(process.stdin.listenerCount("error")).toBe(baseline + 1);
		interactiveModePrototype.unregisterSignalHandlers.call(context);
		expect(process.stdin.listenerCount("error")).toBe(baseline);
	});
});
