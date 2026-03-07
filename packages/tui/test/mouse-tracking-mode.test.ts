import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";

describe("ProcessTerminal mouse tracking ownership", () => {
	it("does not enable mouse tracking during terminal start", () => {
		const writes: string[] = [];
		const originalStdoutWrite = process.stdout.write.bind(process.stdout);
		const originalStdinResume = process.stdin.resume.bind(process.stdin);
		const originalStdinSetEncoding = process.stdin.setEncoding.bind(process.stdin);
		const originalStdinOn = process.stdin.on.bind(process.stdin);
		const originalStdoutOn = process.stdout.on.bind(process.stdout);
		const originalStdinRemoveListener = process.stdin.removeListener.bind(process.stdin);
		const originalStdoutRemoveListener = process.stdout.removeListener.bind(process.stdout);
		const originalSetRawMode = process.stdin.setRawMode?.bind(process.stdin);
		const fakeStdoutWrite: typeof process.stdout.write = (chunk) => {
			writes.push(String(chunk));
			return true;
		};
		const fakeStdinResume: typeof process.stdin.resume = () => process.stdin;
		const fakeStdinSetEncoding: typeof process.stdin.setEncoding = (_encoding?: BufferEncoding) => process.stdin;
		const fakeStdinOn = ((_event: string, _listener: (...args: unknown[]) => void) =>
			process.stdin) as typeof process.stdin.on;
		const fakeStdoutOn = ((_event: string, _listener: (...args: unknown[]) => void) =>
			process.stdout) as typeof process.stdout.on;
		const fakeStdinRemoveListener = ((_event: string, _listener: (...args: unknown[]) => void) =>
			process.stdin) as typeof process.stdin.removeListener;
		const fakeStdoutRemoveListener = ((_event: string, _listener: (...args: unknown[]) => void) =>
			process.stdout) as typeof process.stdout.removeListener;
		const fakeSetRawMode = ((_: boolean) => process.stdin) as typeof process.stdin.setRawMode;

		process.stdout.write = fakeStdoutWrite;
		process.stdin.resume = fakeStdinResume;
		process.stdin.setEncoding = fakeStdinSetEncoding;
		process.stdin.on = fakeStdinOn;
		process.stdout.on = fakeStdoutOn;
		process.stdin.removeListener = fakeStdinRemoveListener;
		process.stdout.removeListener = fakeStdoutRemoveListener;
		process.stdin.setRawMode = fakeSetRawMode;

		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			terminal.stop();

			const joined = writes.join("");
			assert.equal(
				joined.includes("\x1b[?1000h\x1b[?1002h\x1b[?1006h"),
				false,
				"expected terminal start to leave mouse tracking disabled until TUI dialog mode opts in",
			);
			assert.equal(
				joined.includes("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l"),
				true,
				"expected terminal lifecycle to still emit mouse-disable cleanup",
			);
		} finally {
			process.stdout.write = originalStdoutWrite;
			process.stdin.resume = originalStdinResume;
			process.stdin.setEncoding = originalStdinSetEncoding;
			process.stdin.on = originalStdinOn;
			process.stdout.on = originalStdoutOn;
			process.stdin.removeListener = originalStdinRemoveListener;
			process.stdout.removeListener = originalStdoutRemoveListener;
			if (originalSetRawMode) {
				process.stdin.setRawMode = originalSetRawMode;
			}
		}
	});
});
