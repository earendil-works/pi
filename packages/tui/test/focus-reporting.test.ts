import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";
import type { Component } from "../src/tui.js";
import { TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class InputRecorder implements Component {
	public readonly inputs: string[] = [];

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

describe("TUI terminal focus reporting", () => {
	it("enables and disables focus reporting in ProcessTerminal", () => {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];

		const originalStdoutWrite = process.stdout.write.bind(process.stdout);
		const originalStdinOn = process.stdin.on.bind(process.stdin);
		const originalStdinRemoveListener = process.stdin.removeListener.bind(process.stdin);
		const originalSetEncoding = process.stdin.setEncoding.bind(process.stdin);
		const originalResume = process.stdin.resume.bind(process.stdin);
		const originalSetRawMode = process.stdin.setRawMode?.bind(process.stdin);
		const originalIsRaw = process.stdin.isRaw;

		(process.stdout.write as unknown as (chunk: string) => boolean) = ((chunk: string | Uint8Array) => {
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stdout.write;
		(process.stdin.on as unknown as typeof process.stdin.on) = ((..._args: Parameters<typeof process.stdin.on>) => {
			return process.stdin;
		}) as typeof process.stdin.on;
		(process.stdin.removeListener as unknown as typeof process.stdin.removeListener) = ((
			..._args: Parameters<typeof process.stdin.removeListener>
		) => {
			return process.stdin;
		}) as typeof process.stdin.removeListener;
		(process.stdin.setEncoding as unknown as typeof process.stdin.setEncoding) = ((
			..._args: Parameters<typeof process.stdin.setEncoding>
		) => {}) as typeof process.stdin.setEncoding;
		(process.stdin.resume as unknown as typeof process.stdin.resume) = (() =>
			process.stdin) as typeof process.stdin.resume;
		if (process.stdin.setRawMode) {
			(process.stdin.setRawMode as unknown as NonNullable<typeof process.stdin.setRawMode>) = ((
				..._args: Parameters<NonNullable<typeof process.stdin.setRawMode>>
			) => {}) as NonNullable<typeof process.stdin.setRawMode>;
		}

		try {
			terminal.start(
				() => undefined,
				() => undefined,
			);
			terminal.stop();

			assert.equal(
				writes.some((chunk) => chunk.includes("\x1b[?1004h")),
				true,
				"expected ProcessTerminal.start() to enable focus reporting",
			);
			assert.equal(
				writes.some((chunk) => chunk.includes("\x1b[?1004l")),
				true,
				"expected ProcessTerminal.stop() to disable focus reporting",
			);
		} finally {
			(process.stdout.write as unknown as typeof process.stdout.write) = originalStdoutWrite;
			(process.stdin.on as unknown as typeof process.stdin.on) = originalStdinOn;
			(process.stdin.removeListener as unknown as typeof process.stdin.removeListener) = originalStdinRemoveListener;
			(process.stdin.setEncoding as unknown as typeof process.stdin.setEncoding) = originalSetEncoding;
			(process.stdin.resume as unknown as typeof process.stdin.resume) = originalResume;
			if (originalSetRawMode && process.stdin.setRawMode) {
				(process.stdin.setRawMode as unknown as NonNullable<typeof process.stdin.setRawMode>) = originalSetRawMode;
			}
			Object.defineProperty(process.stdin, "isRaw", {
				value: originalIsRaw,
				configurable: true,
				writable: true,
			});
			originalStdoutWrite("");
		}
	});

	it("consumes focus escape sequences instead of forwarding them to the focused component", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const ui = new TUI(terminal);
		const recorder = new InputRecorder();

		ui.addChild(recorder);
		ui.setFocus(recorder);
		ui.start();

		try {
			terminal.sendInput("\x1b[O");
			terminal.sendInput("\x1b[I");
			await terminal.flush();

			assert.deepEqual(recorder.inputs, [], "expected TUI to consume terminal focus in/out escape sequences");
		} finally {
			ui.stop();
		}
	});

	it("tracks terminal focus state across focus in/out events", async () => {
		const terminal = new VirtualTerminal(80, 12);
		const ui = new TUI(terminal);
		ui.start();

		try {
			const maybeIsTerminalFocused = (ui as unknown as { isTerminalFocused?: () => boolean }).isTerminalFocused;
			assert.equal(typeof maybeIsTerminalFocused, "function", "expected TUI to expose isTerminalFocused()");

			assert.equal(maybeIsTerminalFocused?.(), true, "expected terminal to start focused");

			terminal.sendInput("\x1b[O");
			await terminal.flush();
			assert.equal(maybeIsTerminalFocused?.(), false, "expected focus-out to mark the terminal unfocused");

			terminal.sendInput("\x1b[I");
			await terminal.flush();
			assert.equal(maybeIsTerminalFocused?.(), true, "expected focus-in to restore focused state");
		} finally {
			ui.stop();
		}
	});
});
