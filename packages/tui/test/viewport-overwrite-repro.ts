/**
 * TUI viewport overwrite repro
 *
 * Place this file at: packages/tui/test/viewport-overwrite-repro.ts
 * Run from repo root: npx tsx packages/tui/test/viewport-overwrite-repro.ts
 *
 * For reliable repro, run in a small terminal (8-12 rows) or a tmux session:
 *   tmux new-session -d -s tui-bug -x 80 -y 12
 *   tmux send-keys -t tui-bug "npx tsx packages/tui/test/viewport-overwrite-repro.ts" Enter
 *   tmux attach -t tui-bug
 *
 * Expected behavior:
 * - PRE-TOOL lines remain visible above tool output.
 * - POST-TOOL lines append after tool output without overwriting earlier content.
 *
 * Actual behavior (bug):
 * - When content exceeds the viewport and new lines arrive after a tool-call pause,
 *   some earlier PRE-TOOL lines near the bottom are overwritten by POST-TOOL lines.
 */

import { TuiMainScreen } from "../src/TuiMainScreen.ts";
import { ProcessTerminal } from "../src/terminal.ts";
import type { Component, TUI } from "../src/tui.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class Lines implements Component {
	private lines: string[] = [];

	set(lines: string[]): void {
		this.lines = lines;
	}

	append(lines: string[]): void {
		this.lines.push(...lines);
	}

	render(width: number): string[] {
		return this.lines.map((line) => {
			if (line.length > width) return line.slice(0, width);
			return line.padEnd(width, " ");
		});
	}

	invalidate(): void {}
}

async function streamLines(buffer: Lines, label: string, count: number, delayMs: number, ui: TUI): Promise<void> {
	for (let i = 1; i <= count; i += 1) {
		buffer.append([`${label} ${String(i).padStart(2, "0")}`]);
		ui.requestRender();
		await sleep(delayMs);
	}
}

async function main(): Promise<void> {
	const ui: TUI = new TuiMainScreen(new ProcessTerminal());
	const buffer = new Lines();
	ui.addChild(buffer);
	ui.start();

	const height = ui.terminal.rows;
	const preCount = height + 8; // Ensure content exceeds viewport
	const toolCount = height + 12; // Tool output pushes further into scrollback
	const postCount = 6;

	buffer.set([
		"TUI viewport overwrite repro",
		`Viewport rows detected: ${height}`,
		"(Resize to ~8-12 rows for best repro)",
		"",
		"=== PRE-TOOL STREAM ===",
	]);
	ui.requestRender();
	await sleep(300);

	// Phase 1: Stream pre-tool text until viewport is exceeded.
	await streamLines(buffer, "PRE-TOOL LINE", preCount, 30, ui);

	// Phase 2: Simulate tool call pause and tool output.
	buffer.append(["", "--- TOOL CALL START ---", "(pause...)", ""]);
	ui.requestRender();
	await sleep(700);

	await streamLines(buffer, "TOOL OUT", toolCount, 20, ui);

	// Phase 3: Post-tool streaming. This is where overwrite often appears.
	buffer.append(["", "=== POST-TOOL STREAM ==="]);
	ui.requestRender();
	await sleep(300);
	await streamLines(buffer, "POST-TOOL LINE", postCount, 40, ui);

	// Leave the output visible briefly, then restore terminal state.
	await sleep(1500);
	ui.stop();
}

main().catch((error) => {
	// Ensure terminal is restored if something goes wrong.
	try {
		const ui: TUI = new TuiMainScreen(new ProcessTerminal());
		ui.stop();
	} catch {
		// Ignore restore errors.
	}
	process.stderr.write(`${String(error)}\n`);
	process.exitCode = 1;
});
