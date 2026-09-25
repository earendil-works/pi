import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type Spacer, type Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createInteractiveTui } from "../../../src/modes/interactive/tui-renderer.ts";

// Regression for https://github.com/earendil-works/pi/issues/10002
//
// Diagnostic output written while the interactive TUI owns the terminal (e.g.
// console.error from an extension) must not reach the terminal: it interleaves
// with rendered frames and garbles the display. It must stay available through
// the capture log and the chat notification path instead.

type CapturedOutputThis = {
	capturedOutputCount: number;
	capturedOutputSpacer?: Spacer;
	capturedOutputText?: Text;
	chatContainer: Container;
	ui: { requestRender: () => void };
};

type InteractiveModePrototypeWithCapture = {
	handleCapturedTerminalOutput(this: CapturedOutputThis, text: string, stream: "stdout" | "stderr"): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototypeWithCapture;
const tempDirs: string[] = [];
let agentDir: string;
let previousAgentDir: string | undefined;

function createCapturedOutputContext(): CapturedOutputThis {
	return {
		capturedOutputCount: 0,
		chatContainer: new Container(),
		ui: { requestRender: () => {} },
	};
}

function readCaptureLog(): string {
	const logPath = join(agentDir, "pi-captured-output.log");
	return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
}

function renderChatEntry(context: CapturedOutputThis): string {
	return (context.capturedOutputText as Text).render(200).join("\n");
}

beforeEach(() => {
	initTheme("dark");
	agentDir = mkdtempSync(join(tmpdir(), "pi-captured-output-"));
	tempDirs.push(agentDir);
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

describe("captured terminal output (#10002)", () => {
	test("keeps extension console output off the terminal and surfaces it through log and chat", () => {
		const context = createCapturedOutputContext();
		const tui = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: agentDir,
			onCapturedOutput: (text, stream) =>
				interactiveModePrototype.handleCapturedTerminalOutput.call(context, text, stream),
		});
		const stdoutWrites: string[] = [];
		const stderrWrites: string[] = [];
		const originalStdoutWrite = process.stdout.write;
		const originalStderrWrite = process.stderr.write;
		const originalStdinOn = process.stdin.on;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			stdoutWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderrWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stderr.write;
		process.stdin.on = (() => process.stdin) as typeof process.stdin.on;

		try {
			tui.terminal.start(
				() => {},
				() => {},
			);
			try {
				// Vitest intercepts console.* before it reaches the streams; the
				// console.error case is covered in packages/tui/test/terminal-output-capture.test.ts.
				process.stderr.write("EXTENSION_DIAGNOSTIC_SENTINEL\n");
			} finally {
				tui.terminal.stop();
			}
		} finally {
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
			process.stdin.on = originalStdinOn;
		}

		expect(stderrWrites.join("")).not.toContain("EXTENSION_DIAGNOSTIC_SENTINEL");
		// The terminal's own control writes still pass through while capture is active.
		expect(stdoutWrites.join("")).toContain("\x1b[?2004h");
		expect(readCaptureLog()).toContain("EXTENSION_DIAGNOSTIC_SENTINEL");
		const entry = renderChatEntry(context);
		expect(entry).toContain("EXTENSION_DIAGNOSTIC_SENTINEL");
		expect(entry).toContain("pi-captured-output.log");
	});

	test("coalesces consecutive captured writes into the previous chat entry", () => {
		const context = createCapturedOutputContext();
		const handle = (text: string, stream: "stdout" | "stderr"): void => {
			interactiveModePrototype.handleCapturedTerminalOutput.call(context, text, stream);
		};

		handle("first diagnostic\n", "stderr");
		handle("second diagnostic\n", "stdout");

		expect(context.chatContainer.children).toHaveLength(2);
		expect(renderChatEntry(context)).toContain("second diagnostic");
		expect(renderChatEntry(context)).toContain("×2");
		expect(readCaptureLog()).toBe("first diagnostic\nsecond diagnostic\n");
	});

	test("starts a new chat entry once other chat content was added", () => {
		const context = createCapturedOutputContext();
		const handle = (text: string, stream: "stdout" | "stderr"): void => {
			interactiveModePrototype.handleCapturedTerminalOutput.call(context, text, stream);
		};

		handle("first diagnostic\n", "stderr");
		context.chatContainer.addChild(new Container());
		handle("second diagnostic\n", "stderr");

		// 2 children from the first pair, 1 unrelated, 2 from the new pair.
		expect(context.chatContainer.children).toHaveLength(5);
		expect(renderChatEntry(context)).toContain("second diagnostic");
		expect(readCaptureLog()).toBe("first diagnostic\nsecond diagnostic\n");
	});

	test("ignores writes without content", () => {
		const context = createCapturedOutputContext();

		interactiveModePrototype.handleCapturedTerminalOutput.call(context, "\n\n", "stderr");

		expect(context.chatContainer.children).toHaveLength(0);
		expect(readCaptureLog()).toBe("");
	});
});
