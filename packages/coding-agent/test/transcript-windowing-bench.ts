import { performance } from "node:perf_hooks";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	ScrollView,
	type Terminal,
	Text,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "../../tui/src/layout.ts";
import { TranscriptContainer, TranscriptDocument } from "../src/modes/interactive/transcript-document.ts";

class CountingLine implements Component {
	renders = 0;
	private readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	invalidate(): void {}
	render(): string[] {
		this.renders += 1;
		return [this.text];
	}
}

function elapsed(run: () => void): number {
	const start = performance.now();
	run();
	return performance.now() - start;
}

function scenario(blockCount: number): void {
	const blocks = Array.from({ length: blockCount }, (_, index) => new CountingLine(`row ${index}`));
	const live = new TranscriptContainer();
	const document = new TranscriptDocument({
		header: new TranscriptContainer(),
		resources: new TranscriptContainer(),
		live,
		requestRender: () => {},
	});
	document.setHistory(blocks.map((block, index) => ({ id: `block:${index}`, create: () => block })));
	const scroll = new ScrollView(document, { follow: "end" });
	const render = (width = 80) => renderLayoutFrame(scroll, width, 25, () => {});

	const coldMs = elapsed(() => render());
	for (const block of blocks) block.renders = 0;
	const steadyFrames = 100;
	const steadyMs = elapsed(() => {
		for (let frame = 0; frame < steadyFrames; frame++) render();
	});
	const steadyRenders = blocks.reduce((sum, block) => sum + block.renders, 0);

	const provisional = new CountingLine("provisional");
	const liveAppendMs = elapsed(() => {
		live.addChild(provisional);
		render();
	});
	const canonical = new CountingLine("canonical");
	let fastReconcile = false;
	const reconcileMs = elapsed(() => {
		fastReconcile = document.appendHistoryAndClearLive([{ id: `block:${blockCount}`, create: () => canonical }]);
		render();
	});
	for (const block of blocks) block.renders = 0;
	const resizeMs = elapsed(() => render(79));
	const resizeRenders = blocks.reduce((sum, block) => sum + block.renders, 0);

	const eagerBlocks = Array.from({ length: blockCount }, (_, index) => new CountingLine(`row ${index}`));
	const eager = new Container();
	for (const block of eagerBlocks) eager.addChild(block);
	const eagerScroll = new ScrollView(eager, { follow: "end" });
	renderLayoutFrame(eagerScroll, 80, 25, () => {});
	for (const block of eagerBlocks) block.renders = 0;
	const eagerMs = elapsed(() => {
		for (let frame = 0; frame < steadyFrames; frame++) {
			renderLayoutFrame(eagerScroll, 80, 25, () => {});
		}
	});

	console.log(
		JSON.stringify({
			blocks: blockCount,
			coldMs: Number(coldMs.toFixed(3)),
			resizeMs: Number(resizeMs.toFixed(3)),
			resizeRenders,
			liveAppendMs: Number(liveAppendMs.toFixed(3)),
			reconcileMs: Number(reconcileMs.toFixed(3)),
			fastReconcile,
			steadyMsPerFrame: Number((steadyMs / steadyFrames).toFixed(4)),
			steadyHistoricalRenders: steadyRenders,
			eagerMsPerFrame: Number((eagerMs / steadyFrames).toFixed(4)),
			speedup: Number((eagerMs / steadyMs).toFixed(1)),
		}),
	);
}

class NullTerminal implements Terminal {
	readonly columns = 100;
	readonly rows = 20;
	readonly kittyProtocolActive = false;
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

class ImageEditor implements Component {
	private text = "";
	append(): void {
		this.text += "x";
	}
	invalidate(): void {}
	render(): string[] {
		return [`> ${this.text}${CURSOR_MARKER}`];
	}
}

function inlineImageScenario(): void {
	const payloadSizes = [1_000_000, 500_000, 250_000, 150_000];
	const images = payloadSizes.map(
		(size, index) => new CountingLine(`\x1b]1337;File=inline=1;name=image-${index}:${"A".repeat(size)}\x07`),
	);
	const document = new TranscriptDocument({
		header: new TranscriptContainer(),
		resources: new TranscriptContainer(),
		live: new TranscriptContainer(),
		requestRender: () => {},
	});
	document.setHistory(images.map((image, index) => ({ id: `image:${index}`, create: () => image })));
	const editor = new ImageEditor();
	const tui = new TuiAltScreen(new NullTerminal());
	tui.setLayoutRoot(
		new VStack([
			{ component: new ScrollView(document, { follow: "end", primary: true }), basis: 0, grow: 1 },
			{ component: new Text("status", 0, 0), basis: 1 },
			{ component: editor, basis: 1 },
		]),
	);
	tui.start();
	tui.renderNow();
	for (const image of images) image.renders = 0;
	const frames = 100;
	const ms = elapsed(() => {
		for (let frame = 0; frame < frames; frame++) {
			editor.append();
			tui.renderNow();
		}
	});
	tui.stop({ preserveScreen: true });
	console.log(
		JSON.stringify({
			inlineImagePayloadMiB: Number((payloadSizes.reduce((sum, size) => sum + size, 0) / 1024 / 1024).toFixed(2)),
			steadyMsPerKey: Number((ms / frames).toFixed(4)),
			imageComponentRendersAfterCold: images.reduce((sum, image) => sum + image.renders, 0),
		}),
	);
}

function giantBlockScenario(): void {
	const lines = Array.from({ length: 100_000 }, (_, row) => `giant ${row}`);
	let renders = 0;
	const document = new TranscriptDocument({
		header: new TranscriptContainer(),
		resources: new TranscriptContainer(),
		live: new TranscriptContainer(),
		requestRender: () => {},
	});
	document.setHistory([
		{
			id: "giant",
			create: () => ({
				invalidate: () => {},
				render: () => {
					renders += 1;
					return lines;
				},
			}),
		},
	]);
	const scroll = new ScrollView(document, { follow: "end" });
	renderLayoutFrame(scroll, 80, 25, () => {});
	const frames = 100;
	const ms = elapsed(() => {
		for (let frame = 0; frame < frames; frame++) renderLayoutFrame(scroll, 80, 25, () => {});
	});
	console.log(
		JSON.stringify({
			giantBlockRows: lines.length,
			steadyMsPerFrame: Number((ms / frames).toFixed(4)),
			totalComponentRendersIncludingCold: renders,
		}),
	);
}

scenario(10_000);
scenario(100_000);
giantBlockScenario();
inlineImageScenario();
