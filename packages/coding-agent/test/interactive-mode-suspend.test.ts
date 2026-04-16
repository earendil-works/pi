import { afterEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type FakeUi = {
	start: () => void;
	stop: () => void;
	requestRender: (force?: boolean) => void;
};

type HandleCtrlZThis = {
	ui: FakeUi;
};

type ProcessSignalHandler = () => void;

type InteractiveModePrototypeWithHandleCtrlZ = {
	handleCtrlZ(this: HandleCtrlZThis): void;
};

function callHandleCtrlZ(context: HandleCtrlZThis): void {
	(interactiveModePrototype as InteractiveModePrototypeWithHandleCtrlZ).handleCtrlZ.call(context);
}

const interactiveModePrototype = InteractiveMode.prototype as unknown;

describe("InteractiveMode.handleCtrlZ", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("shows a status message and skips suspend on Windows", () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const showStatus = vi.fn();
		const context: HandleCtrlZThis & { showStatus: (message: string) => void } = { ui, showStatus };
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", {
			configurable: true,
			value: "win32",
		});
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const processOnSpy = vi.spyOn(process, "on");
		const processOnceSpy = vi.spyOn(process, "once");
		const processKillSpy = vi.spyOn(process, "kill");

		try {
			callHandleCtrlZ(context);
		} finally {
			if (platformDescriptor) {
				Object.defineProperty(process, "platform", platformDescriptor);
			}
		}

		expect(showStatus).toHaveBeenCalledWith("Suspend to background is not supported on Windows");
		expect(ui.stop).not.toHaveBeenCalled();
		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(processOnSpy).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(processOnceSpy).not.toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		expect(processKillSpy).not.toHaveBeenCalled();
	});

	test("keeps the process alive while suspended and restores the TUI on SIGCONT", () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const context: HandleCtrlZThis = { ui };
		const keepAliveHandle = setTimeout(() => undefined, 0);
		clearTimeout(keepAliveHandle);

		let sigintHandler: ProcessSignalHandler | undefined;
		let sigcontHandler: ProcessSignalHandler | undefined;

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(keepAliveHandle);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
		const processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
			if (event === "SIGINT") {
				sigintHandler = listener;
			}
			return process;
		}) as typeof process.on);
		const processOnceSpy = vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
			if (event === "SIGCONT") {
				sigcontHandler = listener;
			}
			return process;
		}) as typeof process.once);
		const removeListenerSpy = vi
			.spyOn(process, "removeListener")
			.mockImplementation(((_event: string, _listener: () => void) => process) as typeof process.removeListener);
		const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		callHandleCtrlZ(context);

		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2 ** 30);
		expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(processOnceSpy).toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(processKillSpy).toHaveBeenCalledWith(0, "SIGTSTP");
		expect(sigintHandler).toBeDefined();
		expect(sigcontHandler).toBeDefined();

		sigcontHandler?.();

		expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveHandle);
		expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", sigintHandler);
		expect(ui.start).toHaveBeenCalledTimes(1);
		expect(ui.requestRender).toHaveBeenCalledWith(true);
	});

	test("cleans up the temporary handlers if suspension fails", () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const context: HandleCtrlZThis = { ui };
		const keepAliveHandle = setTimeout(() => undefined, 0);
		clearTimeout(keepAliveHandle);
		const suspendError = new Error("suspend failed");

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(keepAliveHandle);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
		vi.spyOn(process, "on").mockImplementation(
			((_event: string, _listener: () => void) => process) as typeof process.on,
		);
		const removeListenerSpy = vi
			.spyOn(process, "removeListener")
			.mockImplementation(((_event: string, _listener: () => void) => process) as typeof process.removeListener);
		vi.spyOn(process, "once").mockImplementation(
			((_event: string, _listener: () => void) => process) as typeof process.once,
		);
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw suspendError;
		});

		expect(() => callHandleCtrlZ(context)).toThrow(suspendError);
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveHandle);
		expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(ui.start).not.toHaveBeenCalled();
		expect(ui.requestRender).not.toHaveBeenCalled();
	});
});
