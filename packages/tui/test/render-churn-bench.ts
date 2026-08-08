/**
 * Alt-screen render churn benchmark.
 *
 * Measures cumulative JS allocation and wall time for repeated TuiAltScreen
 * frames on a layout mirroring pi's fullscreen interactive mode:
 * VStack [ ScrollView(transcript), dock VStack [status, editor, footer] ].
 *
 * Two scenarios:
 * - static: nothing changes between frames (pure recomposite churn)
 * - editor: one character appended to the editor per frame (doc scenario
 *   "30 editor updates")
 *
 * Allocation is estimated with the V8 sampling heap profiler including
 * objects collected by minor/major GC, i.e. it measures churn, not retention.
 *
 * Run from packages/tui: node test/render-churn-bench.ts
 */

import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { Terminal } from "../src/terminal.ts";
import { type Component, Container, CURSOR_MARKER } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";

const COLUMNS = 100;
const ROWS = 30;
const WARMUP_FRAMES = 20;
const FRAMES = 300;
const SAMPLING_INTERVAL = 4096;

/** Terminal that discards output; keeps xterm parsing out of the measurement. */
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

/** Editor stand-in: caches lines per (text, width), re-renders when text changes. */
class EditorSim implements Component {
	private text = "";
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	append(char: string): void {
		this.text += char;
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const border = `\x1b[90m${"─".repeat(Math.max(1, width - 2))}\x1b[39m`;
		const lines = [border, ` > ${this.text}${CURSOR_MARKER}`, border];
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

function buildTranscript(): Container {
	const container = new Container();
	for (let i = 0; i < 150; i++) {
		const styled =
			i % 3 === 0
				? `\x1b[1m\x1b[36muser ${i}\x1b[39m\x1b[22m message with some \x1b[33mstyled\x1b[39m content padding padding`
				: `assistant ${i} plain response line with enough text to be representative of a transcript row`;
		container.addChild(new Text(styled, 1, 0));
	}
	return container;
}

interface SamplingNode {
	selfSize: number;
	children: SamplingNode[];
}

function sumProfile(node: SamplingNode): number {
	let total = node.selfSize;
	for (const child of node.children) total += sumProfile(child);
	return total;
}

interface ScenarioResult {
	allocatedBytes: number;
	elapsedMs: number;
	bytesWritten: number;
}

async function runScenario(
	session: Session,
	terminal: NullTerminal,
	tui: TuiAltScreen,
	frame: (index: number) => void,
): Promise<ScenarioResult> {
	const writtenBefore = terminal.bytesWritten;
	await session.post("HeapProfiler.startSampling", {
		samplingInterval: SAMPLING_INTERVAL,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	const start = performance.now();
	for (let i = 0; i < FRAMES; i++) {
		frame(i);
		tui.renderNow();
	}
	const elapsedMs = performance.now() - start;
	const { profile } = await session.post("HeapProfiler.stopSampling");
	return {
		allocatedBytes: sumProfile(profile.head as SamplingNode),
		elapsedMs,
		bytesWritten: terminal.bytesWritten - writtenBefore,
	};
}

function report(name: string, result: ScenarioResult): void {
	const perFrameKiB = result.allocatedBytes / FRAMES / 1024;
	const totalMiB = result.allocatedBytes / 1024 / 1024;
	const msPerFrame = result.elapsedMs / FRAMES;
	console.log(
		`${name.padEnd(8)} allocated ${totalMiB.toFixed(1).padStart(7)} MiB total  ` +
			`${perFrameKiB.toFixed(1).padStart(8)} KiB/frame  ` +
			`${msPerFrame.toFixed(3).padStart(7)} ms/frame  ` +
			`${(result.bytesWritten / FRAMES).toFixed(0).padStart(6)} written bytes/frame`,
	);
}

async function main(): Promise<void> {
	const terminal = new NullTerminal();
	const tui = new TuiAltScreen(terminal, false, "/tmp/pi-tui-bench");

	const transcript = buildTranscript();
	const editor = new EditorSim();
	const scrollView = new ScrollView(transcript, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: "auto",
	});
	const status = new Text("\x1b[2mstatus: idle\x1b[22m", 1, 0);
	const footer = new Text("\x1b[2m~/workspaces/pi  main  100k tokens\x1b[22m", 1, 0);
	const dock = new VStack([
		{ component: status, shrink: 1, minSize: 0 },
		{ component: editor, shrink: 1, minSize: 3 },
		{ component: footer, shrink: 1, minSize: 1 },
	]);
	const root = new VStack([
		{ component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);
	tui.setLayoutRoot(root);
	tui.start();

	for (let i = 0; i < WARMUP_FRAMES; i++) tui.renderNow();

	const session = new Session();
	session.connect();

	const staticResult = await runScenario(session, terminal, tui, () => {});
	const editorResult = await runScenario(session, terminal, tui, (i) => {
		editor.append(String.fromCharCode(97 + (i % 26)));
	});

	session.disconnect();
	tui.stop();

	console.log(`frames=${FRAMES} viewport=${COLUMNS}x${ROWS} transcript=${transcript.render(COLUMNS).length} lines`);
	report("static", staticResult);
	report("editor", editorResult);
}

await main();
