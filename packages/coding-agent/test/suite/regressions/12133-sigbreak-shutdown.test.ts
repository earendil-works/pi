import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

// Regression for https://github.com/earendil-works/pi/issues/12133
//
// On Windows, a console Ctrl+Break (the user's key, or a child process in the
// same console calling GenerateConsoleCtrlEvent) ends a process that has no
// SIGBREAK listener without running any JavaScript. pi then left the alternate
// screen, mouse reporting and keyboard modes on. InteractiveMode must handle
// SIGBREAK like SIGTERM: a graceful shutdown that restores the terminal.

type HandlerContext = {
	signalCleanupHandlers: Array<() => void>;
	shutdown: (options?: { fromSignal?: boolean }) => Promise<void>;
	unregisterSignalHandlers: () => void;
};

type InteractiveModePrivates = {
	registerSignalHandlers(this: HandlerContext): void;
	unregisterSignalHandlers(this: HandlerContext): void;
};

const proto = InteractiveMode.prototype as unknown as InteractiveModePrivates;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function register(): HandlerContext {
	const context: HandlerContext = {
		signalCleanupHandlers: [],
		shutdown: vi.fn(async () => {}),
		unregisterSignalHandlers: () => proto.unregisterSignalHandlers.call(context),
	};
	proto.registerSignalHandlers.call(context);
	return context;
}

describe("InteractiveMode SIGBREAK handling (#12133)", () => {
	let context: HandlerContext | undefined;

	afterEach(() => {
		context?.unregisterSignalHandlers();
		context = undefined;
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		vi.restoreAllMocks();
	});

	test("SIGBREAK on Windows starts a signal-triggered shutdown", () => {
		setPlatform("win32");
		context = register();

		process.emit("SIGBREAK");

		expect(context.shutdown).toHaveBeenCalledWith({ fromSignal: true });
	});

	test("unregister removes the SIGBREAK listener", () => {
		setPlatform("win32");
		const before = process.listenerCount("SIGBREAK");
		context = register();
		expect(process.listenerCount("SIGBREAK")).toBe(before + 1);

		context.unregisterSignalHandlers();

		expect(process.listenerCount("SIGBREAK")).toBe(before);
	});

	test("no SIGBREAK listener on other platforms", () => {
		setPlatform("linux");
		const before = process.listenerCount("SIGBREAK");

		context = register();

		expect(process.listenerCount("SIGBREAK")).toBe(before);
	});
});
