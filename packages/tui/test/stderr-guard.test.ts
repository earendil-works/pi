import assert from "node:assert";
import { describe, it } from "node:test";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// PICO-9: while the alt screen owns the terminal, process.stderr writes must be diverted to the
// onStderrLine sink — a raw stderr byte lands behind the row-diff renderer's previousScreen model
// and is never repainted, so out-of-band output corrupts the fullscreen display.

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

type StderrWrite = typeof process.stderr.write;

function withSpyStderr(): { writes: string[]; restore: () => void } {
	const writes: string[] = [];
	const original = process.stderr.write.bind(process.stderr) as StderrWrite;
	process.stderr.write = ((chunk: Uint8Array | string): boolean => {
		writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as StderrWrite;
	return {
		writes,
		restore: () => {
			process.stderr.write = original;
		},
	};
}

function startGuardedTui(terminal: RecordingTerminal, lines: string[]): TuiAltScreen {
	const tui = new TuiAltScreen(terminal, undefined, undefined, { onStderrLine: (line) => lines.push(line) });
	tui.start();
	return tui;
}

describe("alt-screen stderr guard", () => {
	it("diverts process.stderr writes to the sink while the alt screen is active", () => {
		const terminal = new RecordingTerminal();
		const lines: string[] = [];
		const tui = startGuardedTui(terminal, lines);
		try {
			terminal.writes.length = 0;
			process.stderr.write('Warning: No models match pattern "github-copilot/claude-opus-5.5"\n');

			assert.strictEqual(lines.length, 1, "sink must receive exactly the one line");
			assert.strictEqual(lines[0], 'Warning: No models match pattern "github-copilot/claude-opus-5.5"');
			assert.ok(
				!terminal.writes.some((data) => data.includes("github-copilot")),
				"intercepted bytes must never reach the terminal stream",
			);
		} finally {
			tui.stop();
		}
	});

	it("restores the original stderr write after stop()", () => {
		const spy = withSpyStderr();
		try {
			const terminal = new RecordingTerminal();
			const lines: string[] = [];
			const tui = startGuardedTui(terminal, lines);
			process.stderr.write("diverted\n");
			assert.deepStrictEqual(lines, ["diverted"]);
			assert.deepStrictEqual(spy.writes, [], "guard active: the spy below the guard must see nothing");

			tui.stop();
			process.stderr.write("passthrough\n");
			assert.deepStrictEqual(spy.writes, ["passthrough\n"], "after stop the original write must be back");
			assert.strictEqual(lines.length, 1, "no further diversion after stop");
		} finally {
			spy.restore();
		}
	});

	it("buffers partial writes until the newline", () => {
		const terminal = new RecordingTerminal();
		const lines: string[] = [];
		const tui = startGuardedTui(terminal, lines);
		try {
			process.stderr.write("War");
			process.stderr.write("ning: split line\n");
			assert.deepStrictEqual(lines, ["Warning: split line"]);
		} finally {
			tui.stop();
		}
	});

	it("strips ANSI codes and drops empty lines", () => {
		const terminal = new RecordingTerminal();
		const lines: string[] = [];
		const tui = startGuardedTui(terminal, lines);
		try {
			process.stderr.write("\x1b[33mWarning: colored\x1b[39m\n");
			process.stderr.write("\n");
			process.stderr.write("   \n");
			assert.deepStrictEqual(lines, ["Warning: colored"]);
		} finally {
			tui.stop();
		}
	});

	it("decodes Uint8Array chunks", () => {
		const terminal = new RecordingTerminal();
		const lines: string[] = [];
		const tui = startGuardedTui(terminal, lines);
		try {
			process.stderr.write(Buffer.from("buffer line\n"));
			assert.deepStrictEqual(lines, ["buffer line"]);
		} finally {
			tui.stop();
		}
	});

	it("flushes a trailing partial line on stop()", () => {
		const terminal = new RecordingTerminal();
		const lines: string[] = [];
		const tui = startGuardedTui(terminal, lines);
		process.stderr.write("no trailing newline");
		assert.deepStrictEqual(lines, []);
		tui.stop();
		assert.deepStrictEqual(lines, ["no trailing newline"]);
	});

	it("honors write callback semantics and the boolean return", () => {
		const terminal = new RecordingTerminal();
		const lines: string[] = [];
		const tui = startGuardedTui(terminal, lines);
		try {
			let callbackError: Error | null | undefined;
			const returned = process.stderr.write("cb line\n", "utf8", (error?: Error | null) => {
				callbackError = error;
			});
			assert.strictEqual(returned, true);
			assert.strictEqual(callbackError, undefined);
			assert.deepStrictEqual(lines, ["cb line"]);
		} finally {
			tui.stop();
		}
	});

	it("does not intercept stderr when onStderrLine is absent", () => {
		const spy = withSpyStderr();
		try {
			const tui = new TuiAltScreen(new RecordingTerminal());
			tui.start();
			try {
				process.stderr.write("unguarded\n");
				assert.deepStrictEqual(spy.writes, ["unguarded\n"]);
			} finally {
				tui.stop();
			}
		} finally {
			spy.restore();
		}
	});
});
