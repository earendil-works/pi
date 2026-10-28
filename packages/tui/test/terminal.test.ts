import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { setKittyProtocolActive } from "../src/keys.ts";
import {
	normalizeAppleTerminalInput,
	normalizeNativeShiftEnterInput,
	ProcessTerminal,
	resolveEscapeTimeoutMs,
} from "../src/terminal.ts";

describe("resolveEscapeTimeoutMs", () => {
	it("uses PI_TUI_ESC_TIMEOUT when configured", () => {
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "80" }), 80);
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "80", SSH_TTY: "/dev/pts/1" }), 80);
	});

	it("ignores invalid PI_TUI_ESC_TIMEOUT values", () => {
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "abc" }), 10);
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "0" }), 10);
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "-5" }), 10);
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "" }), 10);
	});

	it("defaults to 100ms over SSH", () => {
		assert.equal(resolveEscapeTimeoutMs({ SSH_CONNECTION: "10.0.0.1 22" }), 100);
		assert.equal(resolveEscapeTimeoutMs({ SSH_TTY: "/dev/pts/1" }), 100);
	});

	it("defaults to 10ms otherwise", () => {
		assert.equal(resolveEscapeTimeoutMs({}), 10);
	});
});

describe("normalizeNativeShiftEnterInput", () => {
	it("rewrites Return to CSI-u Shift+Enter when native Shift detection is enabled and Shift is pressed", () => {
		assert.equal(normalizeNativeShiftEnterInput("\r", true, true), "\x1b[13;2u");
	});

	it("leaves Return unchanged when native Shift detection is disabled", () => {
		assert.equal(normalizeNativeShiftEnterInput("\r", false, true), "\r");
	});

	it("leaves Return unchanged when Shift is not pressed", () => {
		assert.equal(normalizeNativeShiftEnterInput("\r", true, false), "\r");
	});

	it("leaves non-Return input unchanged", () => {
		assert.equal(normalizeNativeShiftEnterInput("\x1b[13;2u", true, true), "\x1b[13;2u");
		assert.equal(normalizeNativeShiftEnterInput("a", true, true), "a");
	});
});

describe("normalizeAppleTerminalInput", () => {
	it("rewrites Apple Terminal Return to CSI-u Shift+Enter when Shift is pressed", () => {
		assert.equal(normalizeAppleTerminalInput("\r", true, true), "\x1b[13;2u");
	});

	it("leaves Apple Terminal Return unchanged when Shift is not pressed", () => {
		assert.equal(normalizeAppleTerminalInput("\r", true, false), "\r");
	});

	it("leaves non-Apple Terminal Return unchanged when Shift is pressed", () => {
		assert.equal(normalizeAppleTerminalInput("\r", false, true), "\r");
	});

	it("leaves non-Return input unchanged", () => {
		assert.equal(normalizeAppleTerminalInput("\x1b[13;2u", true, true), "\x1b[13;2u");
		assert.equal(normalizeAppleTerminalInput("a", true, true), "a");
	});
});

describe("ProcessTerminal Kitty keyboard protocol negotiation", () => {
	type NegotiationHarness = {
		terminal: ProcessTerminal;
		writes: string[];
		send(data: string): void;
		getInput(): string | undefined;
		cleanup(): void;
	};

	function setupNegotiation(): NegotiationHarness {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		let input: string | undefined;
		let dataHandler: ((data: string) => void) | undefined;
		let cleaned = false;
		const previousWrite = process.stdout.write;
		const previousOn = process.stdin.on;

		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		process.stdin.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			if (event === "data") dataHandler = listener as (data: string) => void;
			return process.stdin;
		}) as typeof process.stdin.on;

		(
			terminal as unknown as {
				inputHandler?: (data: string) => void;
				queryAndEnableKittyProtocol(): void;
			}
		).inputHandler = (data) => {
			input = data;
		};
		(terminal as unknown as { queryAndEnableKittyProtocol(): void }).queryAndEnableKittyProtocol();

		return {
			terminal,
			writes,
			send(data: string): void {
				dataHandler?.(data);
			},
			getInput(): string | undefined {
				return input;
			},
			cleanup(): void {
				if (cleaned) return;
				cleaned = true;
				try {
					terminal.stop();
				} finally {
					process.stdout.write = previousWrite;
					process.stdin.on = previousOn;
					setKittyProtocolActive(false);
				}
			},
		};
	}

	it("queries Kitty mode before enabling modifyOtherKeys fallback", () => {
		const harness = setupNegotiation();
		try {
			assert.equal(harness.writes[0], "\x1b[>7u\x1b[?u\x1b]7501;?\x1b\\\x1b[c");
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
			assert.equal(harness.terminal.kittyProtocolActive, false);
		} finally {
			harness.cleanup();
		}
	});

	it("activates Kitty mode for non-zero negotiated flags", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?7u");

			assert.equal(harness.getInput(), undefined);
			assert.equal(harness.terminal.kittyProtocolActive, true);
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
			assert.equal(harness.writes.includes("\x1b[>4;0m"), false);

			harness.cleanup();
			assert.equal(harness.writes.filter((write) => write === "\x1b[<u").length, 1);
			assert.equal(harness.writes.includes("\x1b[>4;0m"), false);
		} finally {
			harness.cleanup();
		}
	});

	it("falls back to modifyOtherKeys for zero Kitty flags", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?0u");

			assert.equal(harness.getInput(), undefined);
			assert.equal(harness.terminal.kittyProtocolActive, false);
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;2m").length, 1);

			harness.cleanup();
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;0m").length, 1);
		} finally {
			harness.cleanup();
		}
	});

	it("falls back to modifyOtherKeys for device attributes without Kitty flags", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?62;4;52c");

			assert.equal(harness.getInput(), undefined);
			assert.equal(harness.terminal.kittyProtocolActive, false);
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;2m").length, 1);
		} finally {
			harness.cleanup();
		}
	});

	it("forwards device attributes replies that answer other queries", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?7u");
			harness.send("\x1b[?62;4;52c");
			assert.equal(harness.getInput(), undefined);

			// The TUI's color query uses DA1 as its own sentinel.
			harness.send("\x1b[?62;4;52c");
			assert.equal(harness.getInput(), "\x1b[?62;4;52c");
		} finally {
			harness.cleanup();
		}
	});

	it("forwards normal input while waiting for Kitty response", () => {
		const harness = setupNegotiation();
		try {
			harness.send("a");

			assert.equal(harness.getInput(), "a");
			assert.equal(harness.terminal.kittyProtocolActive, false);
		} finally {
			harness.cleanup();
		}
	});

	it("tracks split Kitty confirmation", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?7");
			mock.timers.tick(10);

			assert.equal(harness.getInput(), undefined);

			harness.send("u");

			assert.equal(harness.terminal.kittyProtocolActive, true);
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
		} finally {
			harness.cleanup();
			mock.timers.reset();
		}
	});

	// #10607
	describe("program status (OSC 7501)", () => {
		const working = "\x1b]7501;state=working:app=pi\x1b\\";
		const clear = "\x1b]7501;state=clear\x1b\\";

		function withOverride(value: string | undefined, fn: () => void): void {
			const previous = process.env.PI_PROGRAM_STATUS;
			if (value === undefined) delete process.env.PI_PROGRAM_STATUS;
			else process.env.PI_PROGRAM_STATUS = value;
			try {
				fn();
			} finally {
				if (previous === undefined) delete process.env.PI_PROGRAM_STATUS;
				else process.env.PI_PROGRAM_STATUS = previous;
			}
		}

		it("reports the latest status once the terminal answers the query before DA", () => {
			withOverride(undefined, () => {
				const harness = setupNegotiation();
				try {
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					assert.equal(harness.writes.includes(working), false);

					harness.send("\x1b]7501;?\x1b\\");
					assert.equal(harness.getInput(), undefined);
					assert.equal(harness.writes.filter((write) => write === working).length, 1);
					harness.send("\x1b[?62;4;52c");

					harness.terminal.setProgramStatus({ state: "done" });
					assert.equal(harness.writes.at(-1), "\x1b]7501;state=done\x1b\\");
				} finally {
					harness.cleanup();
				}
			});
		});

		it("reports nothing when DA arrives first and swallows late replies", () => {
			withOverride(undefined, () => {
				const harness = setupNegotiation();
				try {
					harness.send("\x1b[?62;4;52c");
					harness.send("\x1b]7501;?\x07");
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });

					assert.equal(harness.getInput(), undefined);
					assert.equal(
						harness.writes.some((write) => write.startsWith("\x1b]7501;state=")),
						false,
					);
				} finally {
					harness.cleanup();
				}
			});
		});

		it("skips the query when PI_PROGRAM_STATUS is set", () => {
			withOverride("1", () => {
				const harness = setupNegotiation();
				try {
					assert.equal(harness.writes[0], "\x1b[>7u\x1b[?u\x1b[c");
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					assert.equal(harness.writes.at(-1), working);
				} finally {
					harness.cleanup();
				}
			});
			withOverride("0", () => {
				const harness = setupNegotiation();
				try {
					assert.equal(harness.writes[0], "\x1b[>7u\x1b[?u\x1b[c");
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					assert.equal(harness.writes.includes(working), false);
				} finally {
					harness.cleanup();
				}
			});
		});

		it("does not let a DA reply from before a restart end the new query", () => {
			withOverride(undefined, () => {
				const harness = setupNegotiation();
				try {
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					harness.terminal.stop();
					(harness.terminal as unknown as { queryAndEnableKittyProtocol(): void }).queryAndEnableKittyProtocol();

					// The first start's replies arrive late: its DA, then the second start's reply and DA.
					harness.send("\x1b[?62;4;52c");
					harness.send("\x1b]7501;?\x1b\\");
					harness.send("\x1b[?62;4;52c");
					assert.equal(harness.writes.at(-1), working);
					assert.equal(harness.getInput(), undefined);
				} finally {
					harness.cleanup();
				}
			});
		});

		it("clears the status on stop and reports it again after restart", () => {
			withOverride(undefined, () => {
				const harness = setupNegotiation();
				try {
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					harness.send("\x1b]7501;?\x1b\\");
					harness.terminal.stop();
					assert.ok(harness.writes.includes(clear));

					// Stopped: nothing is written until the restarted terminal confirms support again.
					const writesBeforeRestart = harness.writes.length;
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					assert.equal(harness.writes.length, writesBeforeRestart);

					(harness.terminal as unknown as { queryAndEnableKittyProtocol(): void }).queryAndEnableKittyProtocol();
					harness.send("\x1b]7501;?\x1b\\");
					assert.equal(harness.writes.at(-1), working);
				} finally {
					harness.cleanup();
				}
			});
		});
	});

	it("replays buffered CSI-prefix input when it is not a Kitty response", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[");
			mock.timers.tick(50); // StdinBuffer sequence timeout, not the lone-ESC timeout

			assert.equal(harness.getInput(), undefined);

			mock.timers.tick(150);

			assert.equal(harness.getInput(), "\x1b[");
		} finally {
			harness.cleanup();
			mock.timers.reset();
		}
	});
});

describe("ProcessTerminal progress", () => {
	it("writes a valid OSC 9;4 clear sequence", () => {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		const previousWrite = process.stdout.write;

		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;

		try {
			terminal.setProgress(false);
			assert.deepEqual(writes, ["\x1b]9;4;0\x07"]);
		} finally {
			process.stdout.write = previousWrite;
		}
	});
});

describe("ProcessTerminal title", () => {
	it("replaces control characters so the title cannot end the OSC sequence", () => {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		const previousWrite = process.stdout.write;

		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;

		try {
			terminal.setTitle("pi - work\x07\x1b]52;c;Zm9v\x07\u009b2J - repo");
			assert.deepEqual(writes, ["\x1b]0;pi - work ]52;c;Zm9v 2J - repo\x07"]);
		} finally {
			process.stdout.write = previousWrite;
		}
	});
});

describe("ProcessTerminal dimensions", () => {
	it("falls back to COLUMNS and LINES before default dimensions", () => {
		const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const previousColumns = process.env.COLUMNS;
		const previousLines = process.env.LINES;

		try {
			Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
			process.env.COLUMNS = "123";
			process.env.LINES = "45";

			const terminal = new ProcessTerminal();

			assert.equal(terminal.columns, 123);
			assert.equal(terminal.rows, 45);
		} finally {
			if (previousColumnsDescriptor) {
				Object.defineProperty(process.stdout, "columns", previousColumnsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "columns");
			}
			if (previousRowsDescriptor) {
				Object.defineProperty(process.stdout, "rows", previousRowsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
			if (previousColumns === undefined) {
				delete process.env.COLUMNS;
			} else {
				process.env.COLUMNS = previousColumns;
			}
			if (previousLines === undefined) {
				delete process.env.LINES;
			} else {
				process.env.LINES = previousLines;
			}
		}
	});
});
