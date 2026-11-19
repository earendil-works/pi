import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Regression for #12272: an external SIGTSTP stopped pi without restoring the terminal.
// The listener must exist only while the TUI owns the terminal, so a child that owns it
// after stop() (external editor, interactive command) is suspended with the default action.
describe("TUI suspend signal handler", () => {
	const baseline = process.listenerCount("SIGTSTP");
	let tui: TUI | undefined;

	afterEach(() => {
		tui?.stop();
		tui = undefined;
	});

	it("calls the handler on SIGTSTP only while started", () => {
		let calls = 0;
		tui = new TuiMainScreen(new VirtualTerminal(40, 10));
		tui.setSuspendSignalHandler(() => calls++);
		tui.start();
		assert.equal(process.listenerCount("SIGTSTP"), baseline + 1);
		process.emit("SIGTSTP", "SIGTSTP");
		assert.equal(calls, 1);

		tui.stop();
		assert.equal(process.listenerCount("SIGTSTP"), baseline);

		tui.start();
		assert.equal(process.listenerCount("SIGTSTP"), baseline + 1);
	});

	it("does not register a listener twice when start() runs again", () => {
		tui = new TuiMainScreen(new VirtualTerminal(40, 10));
		tui.setSuspendSignalHandler(() => {});
		tui.start();
		tui.start();
		assert.equal(process.listenerCount("SIGTSTP"), baseline + 1);
	});

	it("applies a handler set or cleared while started immediately", () => {
		tui = new TuiMainScreen(new VirtualTerminal(40, 10));
		tui.start();
		assert.equal(process.listenerCount("SIGTSTP"), baseline);

		tui.setSuspendSignalHandler(() => {});
		assert.equal(process.listenerCount("SIGTSTP"), baseline + 1);

		tui.setSuspendSignalHandler(undefined);
		assert.equal(process.listenerCount("SIGTSTP"), baseline);
	});

	it("does not register a listener when a handler is set while stopped", () => {
		tui = new TuiMainScreen(new VirtualTerminal(40, 10));
		tui.start();
		tui.stop();
		tui.setSuspendSignalHandler(() => {});
		assert.equal(process.listenerCount("SIGTSTP"), baseline);
	});
});
