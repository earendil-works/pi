import { type Component, Container, ScrollView } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderLayoutFrame } from "../../tui/src/layout.ts";
import { TranscriptContainer, TranscriptDocument } from "../src/modes/interactive/transcript-document.ts";

class CountingLine implements Component {
	readonly text: string;
	renders = 0;

	constructor(text: string) {
		this.text = text;
	}

	invalidate(): void {}

	render(): string[] {
		this.renders += 1;
		return [this.text];
	}
}

function createWindowed(blocks: readonly CountingLine[]) {
	const header = new TranscriptContainer();
	const resources = new TranscriptContainer();
	const live = new TranscriptContainer();
	const document = new TranscriptDocument({ header, resources, live, requestRender: () => {} });
	document.setHistory(
		blocks.map((block, index) => ({
			id: `block:${index}`,
			create: () => block,
		})),
	);
	return { document, live };
}

describe("fullscreen transcript work bounds", () => {
	it("does no whole-transcript component work on steady frames", () => {
		const blockCount = 10_000;
		const eagerBlocks = Array.from({ length: blockCount }, (_, index) => new CountingLine(`row ${index}`));
		const windowedBlocks = Array.from({ length: blockCount }, (_, index) => new CountingLine(`row ${index}`));
		const eager = new Container();
		for (const block of eagerBlocks) eager.addChild(block);
		const { document } = createWindowed(windowedBlocks);
		const eagerScroll = new ScrollView(eager, { follow: "end" });
		const windowedScroll = new ScrollView(document, { follow: "end" });

		// Warm exact height indexes and the tail viewport before measuring steady work.
		renderLayoutFrame(eagerScroll, 80, 25, () => {});
		renderLayoutFrame(windowedScroll, 80, 25, () => {});
		for (const block of eagerBlocks) block.renders = 0;
		for (const block of windowedBlocks) block.renders = 0;

		for (let frame = 0; frame < 30; frame++) {
			renderLayoutFrame(eagerScroll, 80, 25, () => {});
			renderLayoutFrame(windowedScroll, 80, 25, () => {});
		}
		const eagerRenders = eagerBlocks.reduce((sum, block) => sum + block.renders, 0);
		const windowedRenders = windowedBlocks.reduce((sum, block) => sum + block.renders, 0);
		expect(eagerRenders).toBe(blockCount * 30);
		expect(windowedRenders).toBe(0);
	});

	it("bounds random viewport and append work to affected blocks", () => {
		const blocks = Array.from({ length: 10_000 }, (_, index) => new CountingLine(`row ${index}`));
		const { document, live } = createWindowed(blocks);
		const scroll = new ScrollView(document, { follow: "end" });
		const render = () => renderLayoutFrame(scroll, 80, 25, () => {});
		render();
		for (const block of blocks) block.renders = 0;

		scroll.scrollToStart();
		render();
		expect(blocks.reduce((sum, block) => sum + block.renders, 0)).toBeLessThanOrEqual(25);
		for (const block of blocks) block.renders = 0;
		render();
		expect(blocks.reduce((sum, block) => sum + block.renders, 0)).toBe(0);

		const appended = new CountingLine("appended");
		live.addChild(appended);
		render();
		expect(appended.renders).toBe(1);
		expect(blocks.reduce((sum, block) => sum + block.renders, 0)).toBe(0);
	});
});
