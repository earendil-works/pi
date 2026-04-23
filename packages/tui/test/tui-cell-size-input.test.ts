import assert from "node:assert";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	getCapabilities,
	getCellDimensions,
	resetCapabilitiesCache,
	setCellDimensions,
} from "../src/terminal-image.js";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

function withImageTerminal<T>(fn: () => T): T {
	const prevTermProgram = process.env.TERM_PROGRAM;
	const prevTerm = process.env.TERM;
	const prevGhosttyResourcesDir = process.env.GHOSTTY_RESOURCES_DIR;

	process.env.TERM_PROGRAM = "ghostty";
	delete process.env.TERM;
	delete process.env.GHOSTTY_RESOURCES_DIR;
	resetCapabilitiesCache();

	try {
		return fn();
	} finally {
		if (prevTermProgram === undefined) delete process.env.TERM_PROGRAM;
		else process.env.TERM_PROGRAM = prevTermProgram;
		if (prevTerm === undefined) delete process.env.TERM;
		else process.env.TERM = prevTerm;
		if (prevGhosttyResourcesDir === undefined) delete process.env.GHOSTTY_RESOURCES_DIR;
		else process.env.GHOSTTY_RESOURCES_DIR = prevGhosttyResourcesDir;
		resetCapabilitiesCache();
	}
}

function withUnknownTerminal<T>(encoderPath: string, fn: () => T): T;
function withUnknownTerminal<T>(encoderPath: string, fn: () => Promise<T>): Promise<T>;
function withUnknownTerminal<T>(encoderPath: string, fn: () => T | Promise<T>): T | Promise<T> {
	const previous = {
		TERM_PROGRAM: process.env.TERM_PROGRAM,
		TERM: process.env.TERM,
		TMUX: process.env.TMUX,
		GHOSTTY_RESOURCES_DIR: process.env.GHOSTTY_RESOURCES_DIR,
		KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID,
		WEZTERM_PANE: process.env.WEZTERM_PANE,
		ITERM_SESSION_ID: process.env.ITERM_SESSION_ID,
		WT_SESSION: process.env.WT_SESSION,
		PI_TUI_IMAGE_PROTOCOL: process.env.PI_TUI_IMAGE_PROTOCOL,
		PI_TUI_SIXEL_ENCODER: process.env.PI_TUI_SIXEL_ENCODER,
	};

	delete process.env.TERM_PROGRAM;
	delete process.env.TERM;
	delete process.env.TMUX;
	delete process.env.GHOSTTY_RESOURCES_DIR;
	delete process.env.KITTY_WINDOW_ID;
	delete process.env.WEZTERM_PANE;
	delete process.env.ITERM_SESSION_ID;
	delete process.env.WT_SESSION;
	delete process.env.PI_TUI_IMAGE_PROTOCOL;
	process.env.PI_TUI_SIXEL_ENCODER = encoderPath;
	resetCapabilitiesCache();

	const restore = (): void => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		resetCapabilitiesCache();
	};

	try {
		const result = fn();
		if (result instanceof Promise) {
			return result.finally(restore);
		}
		restore();
		return result;
	} catch (error) {
		restore();
		throw error;
	}
}

function createFakeSixelEncoder(baseName = "fake-img2sixel"): { path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "pi-tui-sixel-test-"));
	const programPath = join(dir, `${baseName}.js`);
	writeFileSync(
		programPath,
		`const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-V")) {
	process.stdout.write("fake encoder 1.0\\n");
	process.exit(0);
}
process.stdout.write("\\x1bPqMOCK:" + args.join("|") + "\\x1b\\\\\\n");
`,
	);

	if (process.platform === "win32") {
		const wrapperPath = join(dir, `${baseName}.cmd`);
		writeFileSync(wrapperPath, `@echo off\r\n"${process.execPath}" "${programPath}" %*\r\n`);
		return {
			path: wrapperPath,
			cleanup: () => rmSync(dir, { recursive: true, force: true }),
		};
	}

	const wrapperPath = join(dir, baseName);
	writeFileSync(wrapperPath, `#!/bin/sh\nexec "${process.execPath}" "${programPath}" "$@"\n`);
	chmodSync(wrapperPath, 0o755);
	return {
		path: wrapperPath,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("TUI cell size responses", () => {
	it("forwards bare escape even when a cell size query was sent at startup", () => {
		withImageTerminal(() => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b");

			assert.deepStrictEqual(recorder.inputs, ["\x1b"]);
			tui.stop();
		});
	});

	it("consumes cell size responses and still forwards later user input", () => {
		withImageTerminal(() => {
			setCellDimensions({ widthPx: 9, heightPx: 18 });

			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b[6;20;10t");
			assert.deepStrictEqual(recorder.inputs, []);
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });

			terminal.sendInput("q");
			assert.deepStrictEqual(recorder.inputs, ["q"]);
			tui.stop();
		});
	});

	it("consumes DA1 SIXEL responses and enables the SIXEL backend", () => {
		const encoder = createFakeSixelEncoder();
		try {
			withUnknownTerminal(encoder.path, () => {
				const terminal = new VirtualTerminal(80, 24);
				const tui = new TUI(terminal);
				const recorder = new InputRecorder();

				tui.setFocus(recorder);
				tui.start();
				assert.strictEqual(getCapabilities().images, null);

				terminal.sendInput("\x1b[?62;4;22c");
				assert.deepStrictEqual(recorder.inputs, []);
				assert.strictEqual(getCapabilities().images, "sixel");

				terminal.sendInput("q");
				assert.deepStrictEqual(recorder.inputs, ["q"]);
				tui.stop();
			});
		} finally {
			encoder.cleanup();
		}
	});

	it("keeps SIXEL probe active long enough for higher-latency DA1 responses", async () => {
		const encoder = createFakeSixelEncoder();
		try {
			await withUnknownTerminal(encoder.path, async () => {
				const terminal = new VirtualTerminal(80, 24);
				const tui = new TUI(terminal);
				const recorder = new InputRecorder();

				tui.setFocus(recorder);
				tui.start();
				assert.strictEqual(getCapabilities().images, null);

				await sleep(500);
				terminal.sendInput("\x1b[?62;4;22c");
				assert.deepStrictEqual(recorder.inputs, []);
				assert.strictEqual(getCapabilities().images, "sixel");

				tui.stop();
			});
		} finally {
			encoder.cleanup();
		}
	});

	it("consumes late DA1 SIXEL responses that arrive after the probe timeout", async () => {
		const encoder = createFakeSixelEncoder();
		try {
			await withUnknownTerminal(encoder.path, async () => {
				const terminal = new VirtualTerminal(80, 24);
				const tui = new TUI(terminal);
				const recorder = new InputRecorder();

				tui.setFocus(recorder);
				tui.start();
				assert.strictEqual(getCapabilities().images, null);

				await sleep(2200);
				terminal.sendInput("\x1b[?62;4;22c");
				assert.deepStrictEqual(recorder.inputs, []);
				assert.strictEqual(getCapabilities().images, "sixel");

				terminal.sendInput("q");
				assert.deepStrictEqual(recorder.inputs, ["q"]);
				tui.stop();
			});
		} finally {
			encoder.cleanup();
		}
	});
});
