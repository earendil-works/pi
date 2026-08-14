/**
 * Eager-versus-windowed fullscreen transcript benchmark.
 *
 * Run from packages/tui:
 *   node test/windowed-render-churn-bench.ts
 *   PI_TUI_BENCH_LINES=100000 node test/windowed-render-churn-bench.ts
 */

import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import {
	type PreparedWindowedScrollContent,
	WINDOWED_SCROLL_CONTENT,
	type WindowedScrollContentRequest,
} from "../src/layout-node.ts";
import type { Terminal } from "../src/terminal.ts";
import { type Component, Container, CURSOR_MARKER } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";

const COLUMNS = 100;
const ROWS = 30;
const WARMUP_FRAMES = 10;
const FRAMES = 200;
const SAMPLING_INTERVAL = 4096;
const TRANSCRIPT_LINES = Math.max(1, Number.parseInt(process.env.PI_TUI_BENCH_LINES ?? "10000", 10));

class NullTerminal implements Terminal {
	bytesWritten = 0;
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytesWritten += data.length;
	}
	get columns(): number {
		return COLUMNS;
	}
	get rows(): number {
		return ROWS;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

class EditorSim implements Component {
	private text = "";
	append(char: string): void {
		this.text += char;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const border = `\x1b[90m${"─".repeat(Math.max(1, width - 2))}\x1b[39m`;
		return [border, ` > ${this.text}${CURSOR_MARKER}`, border];
	}
}

class WindowedLines implements Component {
	private readonly lines: readonly string[];
	constructor(lines: readonly string[]) {
		this.lines = lines;
	}
	invalidate(): void {}
	render(): string[] {
		return [...this.lines];
	}
	[WINDOWED_SCROLL_CONTENT](_request: WindowedScrollContentRequest): PreparedWindowedScrollContent {
		return {
			contentHeight: this.lines.length,
			revision: 1,
			renderWindow: (startRow, rowCount) => ({
				startRow,
				lines: this.lines.slice(startRow, startRow + rowCount),
			}),
			lineAt: (row) => this.lines[row],
		};
	}
}

interface SamplingNode {
	selfSize: number;
	children: SamplingNode[];
}

interface ScenarioResult {
	allocatedBytes: number;
	elapsedMs: number;
}

function sumProfile(node: SamplingNode): number {
	let total = node.selfSize;
	for (const child of node.children) total += sumProfile(child);
	return total;
}

function transcriptLines(): string[] {
	return Array.from({ length: TRANSCRIPT_LINES }, (_, index) =>
		index % 3 === 0
			? `\x1b[1m\x1b[36muser ${index}\x1b[39m\x1b[22m message with styled content`
			: `assistant ${index} response with representative transcript content`,
	);
}

function buildRoot(transcript: Component, editor: EditorSim): Component {
	const scrollView = new ScrollView(transcript, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: "auto",
	});
	const dock = new VStack([
		{ component: new Text("status: idle", 1, 0), minSize: 0 },
		{ component: editor, minSize: 3 },
		{ component: new Text("~/workspaces/pi main", 1, 0), minSize: 1 },
	]);
	return new VStack([
		{ component: scrollView, basis: 0, grow: 1, minSize: 1 },
		{ component: dock, basis: "auto", minSize: 1 },
	]);
}

async function measure(kind: "eager" | "windowed", mutateEditor: boolean): Promise<ScenarioResult> {
	const lines = transcriptLines();
	const transcript =
		kind === "windowed"
			? new WindowedLines(lines)
			: (() => {
					const eager = new Container();
					for (const line of lines) eager.addChild(new Text(line, 1, 0));
					return eager;
				})();
	const editor = new EditorSim();
	const terminal = new NullTerminal();
	const tui = new TuiAltScreen(terminal, false, "/tmp/pi-tui-windowed-bench");
	tui.setLayoutRoot(buildRoot(transcript, editor));
	tui.start();
	for (let frame = 0; frame < WARMUP_FRAMES; frame++) tui.renderNow();

	const session = new Session();
	session.connect();
	await session.post("HeapProfiler.startSampling", {
		samplingInterval: SAMPLING_INTERVAL,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	const start = performance.now();
	for (let frame = 0; frame < FRAMES; frame++) {
		if (mutateEditor) editor.append(String.fromCharCode(97 + (frame % 26)));
		tui.renderNow();
	}
	const elapsedMs = performance.now() - start;
	const { profile } = await session.post("HeapProfiler.stopSampling");
	session.disconnect();
	tui.stop();
	return { allocatedBytes: sumProfile(profile.head as SamplingNode), elapsedMs };
}

function report(label: string, result: ScenarioResult): void {
	console.log(
		`${label.padEnd(18)} ${(result.elapsedMs / FRAMES).toFixed(3).padStart(8)} ms/frame  ` +
			`${(result.allocatedBytes / FRAMES / 1024).toFixed(1).padStart(9)} KiB/frame`,
	);
}

const eagerStatic = await measure("eager", false);
const windowedStatic = await measure("windowed", false);
const eagerEditor = await measure("eager", true);
const windowedEditor = await measure("windowed", true);
console.log(`frames=${FRAMES} viewport=${COLUMNS}x${ROWS} transcript=${TRANSCRIPT_LINES} lines`);
report("eager static", eagerStatic);
report("windowed static", windowedStatic);
report("eager editor", eagerEditor);
report("windowed editor", windowedEditor);
console.log(
	`static speedup ${(eagerStatic.elapsedMs / windowedStatic.elapsedMs).toFixed(1)}x · ` +
		`editor speedup ${(eagerEditor.elapsedMs / windowedEditor.elapsedMs).toFixed(1)}x`,
);
