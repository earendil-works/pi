import assert from "node:assert";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { encodeKitty, registerKittyImageMetadata } from "../src/terminal-image.ts";
import { stripTerminalSequences } from "../src/utils.ts";

function visibleLines(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line).trimEnd());
}

describe("viewport layout", () => {
	it("allocates vertical grow space deterministically", () => {
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("top", 0, 0), basis: 1, shrink: 0 },
				{ component: new Text("body", 0, 0), basis: 0, grow: 1 },
			]),
			10,
			4,
			() => {},
		);

		assert.deepStrictEqual(
			frame.root.children.map((child) => child.rect.height),
			[1, 3],
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["top", "body", "", ""]);
	});

	it("does not render fixed-basis scroll content during stack measurement", () => {
		let renderCount = 0;
		const transcript = new ScrollView({
			render: () => {
				renderCount += 1;
				return ["one", "two", "three"];
			},
			invalidate: () => {},
		});
		const root = new VStack([
			{ component: transcript, basis: 0, grow: 1 },
			{ component: new Text("dock", 0, 0), basis: "auto" },
		]);
		renderLayoutFrame(root, 10, 3, () => {});
		assert.strictEqual(renderCount, 1);
	});

	it("paints only clipped rows from very large scroll content", () => {
		const lineCount = 1_000_000_000;
		const lines: string[] = [];
		lines.length = lineCount;
		lines[lineCount - 4] = "before";
		lines[lineCount - 3] = "visible 1";
		lines[lineCount - 2] = "visible 2";
		lines[lineCount - 1] = "visible 3";
		const transcript = new ScrollView(
			{
				render: () => lines,
				invalidate: () => {},
			},
			{ follow: "end" },
		);

		const frame = renderLayoutFrame(transcript, 10, 3, () => {});
		assert.deepStrictEqual(visibleLines(frame.lines), ["visible 1", "visible 2", "visible 3"]);
	});

	it("shrinks entries to their minimum sizes", () => {
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("a1\na2\na3", 0, 0), shrink: 1, minSize: 1 },
				{ component: new Text("b1\nb2\nb3", 0, 0), shrink: 0 },
			]),
			10,
			4,
			() => {},
		);

		assert.deepStrictEqual(
			frame.root.children.map((child) => child.rect.height),
			[1, 3],
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["a1", "b1", "b2", "b3"]);
	});

	it("includes nested minimum sizes in intrinsic stack measurement", () => {
		const dock = new VStack([
			new Text("top1\ntop2\ntop3", 0, 0),
			{ component: new Text("selector", 0, 0), minSize: 3 },
			new Text("below", 0, 0),
			{ component: new Text("footer", 0, 0), minSize: 1 },
		]);
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("body", 0, 0), basis: 0, grow: 1, minSize: 1 },
				{ component: dock, basis: "auto", minSize: 1 },
			]),
			10,
			9,
			() => {},
		);

		assert.deepStrictEqual(visibleLines(frame.lines), [
			"body",
			"top1",
			"top2",
			"top3",
			"selector",
			"",
			"",
			"below",
			"footer",
		]);
	});

	it("omits gaps around invisible entries", () => {
		const stack = new VStack(
			[new Text("one", 0, 0), { component: new Text("hidden", 0, 0), visible: () => false }, new Text("two", 0, 0)],
			{ gap: 1 },
		);
		assert.deepStrictEqual(
			stack.render(10).map((line) => line.trimEnd()),
			["one", "", "two"],
		);
	});

	it("crops Kitty images at a scroll view's lower boundary", () => {
		const imageId = 124;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		const transcript = new ScrollView({
			render: () => ["one", "two", imageLine, "", ""],
			invalidate: () => {},
		});
		const frame = renderLayoutFrame(
			new VStack([{ component: transcript, basis: 0, grow: 1 }, new Text("dock", 0, 0)]),
			20,
			4,
			() => {},
		);

		assert.ok(frame.lines[2]?.includes("y=0,h=34,r=1"));
	});

	it("composes horizontal children at allocated widths", () => {
		const frame = renderLayoutFrame(
			new HStack([
				{ component: new Text("left", 0, 0), basis: 6, shrink: 0 },
				{ component: new Text("right", 0, 0), basis: 6, shrink: 0 },
			]),
			12,
			1,
			() => {},
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["left  right"]);
	});

	it("does not paint zero-width horizontal children", () => {
		const frame = renderLayoutFrame(
			new HStack([
				{ component: new Text("hidden", 0, 0), basis: 0, shrink: 0 },
				{ component: new Text("shown", 0, 0), basis: 0, grow: 1 },
			]),
			5,
			1,
			() => {},
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["shown"]);
	});

	it("tracks follow-end state and returns unused scroll delta", () => {
		const scrollView = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0), {
			follow: "end",
			primary: true,
		});
		renderLayoutFrame(scrollView, 10, 3, () => {});
		assert.strictEqual(scrollView.scrollTop, 3);
		assert.strictEqual(scrollView.isFollowingEnd, true);

		assert.strictEqual(scrollView.scrollBy(-2), 0);
		assert.strictEqual(scrollView.scrollTop, 1);
		assert.strictEqual(scrollView.isFollowingEnd, false);
		assert.strictEqual(scrollView.scrollBy(-3), -2);
		assert.strictEqual(scrollView.scrollTop, 0);
		assert.strictEqual(scrollView.scrollBy(10), 7);
		assert.strictEqual(scrollView.scrollTop, 3);
		assert.strictEqual(scrollView.isFollowingEnd, true);
	});

	it("renders a proportional glyph scrollbar with an expanded active thumb", async () => {
		const sourceLines = ["abcd界", "abcde2", "abcde3", "abcde4", "abcde5", "abcde6", "abcde7", "abcde8"];
		const contentBackground = "\x1b[42m";
		const trackColor = "\x1b[38;5;2m";
		const thumbColor = "\x1b[38;5;1m";
		const scrollbarTrackStyle = (text: string) => `${trackColor}${text}\x1b[39m`;
		const scrollbarThumbStyle = (text: string) => `${thumbColor}${text}\x1b[39m`;
		const content = new Text(sourceLines.join("\n"), 0, 0, (text) => `${contentBackground}${text}\x1b[49m`);
		const scrollView = new ScrollView(content, {
			scrollbar: "auto",
			scrollbarTrackStyle,
			scrollbarThumbStyle,
			scrollbarHideDelayMs: 10,
		});
		const render = () => renderLayoutFrame(scrollView, 6, 4, () => {}).lines;
		const visible = (lines: string[]) => lines.map(stripTerminalSequences);

		let lines = render();
		assert.deepStrictEqual(visible(lines), sourceLines.slice(0, 4));

		scrollView.scrollBy(2);
		lines = render();
		assert.deepStrictEqual(visible(lines), ["abcde│", "abcde┃", "abcde┃", "abcde│"]);
		assert.deepStrictEqual(
			lines.map((line) => line.includes(trackColor)),
			[true, false, false, true],
		);
		assert.deepStrictEqual(
			lines.map((line) => line.includes(thumbColor)),
			[false, true, true, false],
		);

		scrollView.setScrollbarActive(true);
		lines = render();
		assert.deepStrictEqual(visible(lines), ["abcde│", "abcde█", "abcde█", "abcde│"]);
		assert.deepStrictEqual(
			lines.map((line) => line.includes(thumbColor)),
			[false, true, true, false],
		);
		assert.ok(lines[1]!.lastIndexOf(contentBackground) < lines[1]!.lastIndexOf(thumbColor));

		scrollView.setScrollbarActive(false);
		await new Promise((resolve) => setTimeout(resolve, 30));
		lines = render();
		assert.deepStrictEqual(visible(lines), sourceLines.slice(2, 6));

		scrollView.scrollToEnd();
		lines = render();
		assert.deepStrictEqual(visible(lines), ["abcde│", "abcde│", "abcde┃", "abcde┃"]);

		scrollView.scrollToStart();
		lines = render();
		assert.strictEqual(visible(lines)[0], "abcd ┃");

		const followedContent = new Text(sourceLines.join("\n"), 0, 0);
		const followed = new ScrollView(followedContent, {
			follow: "end",
			scrollbar: "auto",
			scrollbarTrackStyle,
			scrollbarThumbStyle,
		});
		renderLayoutFrame(followed, 6, 4, () => {});
		assert.strictEqual(followed.scrollTop, 4);
		followedContent.setText(`${sourceLines.join("\n")}\nabcde9`);
		const growthFrame = renderLayoutFrame(followed, 6, 4, () => {});
		assert.strictEqual(followed.scrollTop, 5);
		assert.ok(growthFrame.lines.every((line) => !/[│┃]/.test(stripTerminalSequences(line))));

		const fittingContent = new Text("1\n2", 0, 0);
		const automatic = new ScrollView(fittingContent, { scrollbar: "auto", scrollbarThumbStyle });
		renderLayoutFrame(automatic, 6, 4, () => {});
		automatic.scrollBy(1);
		assert.ok(
			renderLayoutFrame(automatic, 6, 4, () => {}).lines.every((line) => !/[│┃]/.test(stripTerminalSequences(line))),
		);

		const alwaysFitting = new ScrollView(fittingContent, { scrollbar: "always", scrollbarThumbStyle });
		const alwaysFittingFrame = renderLayoutFrame(alwaysFitting, 6, 4, () => {});
		assert.strictEqual(alwaysFittingFrame.root.children[0]?.rect.width, 5);
		assert.ok(visible(alwaysFittingFrame.lines).every((line) => line.endsWith("┃")));

		const alwaysOverflowing = new ScrollView(content, {
			scrollbar: "always",
			scrollbarTrackStyle,
			scrollbarThumbStyle,
		});
		const alwaysOverflowingFrame = renderLayoutFrame(alwaysOverflowing, 6, 4, () => {});
		assert.strictEqual(alwaysOverflowingFrame.root.children[0]?.rect.width, 5);
		assert.strictEqual(visible(alwaysOverflowingFrame.lines).filter((line) => line.endsWith("┃")).length, 2);
		assert.strictEqual(visible(alwaysOverflowingFrame.lines).filter((line) => line.endsWith("│")).length, 2);
		for (const line of alwaysOverflowingFrame.lines) {
			const scrollbarStyleIndex = Math.max(line.lastIndexOf(trackColor), line.lastIndexOf(thumbColor));
			const reservedColumnResetIndex = line.lastIndexOf("\x1b[0m\x1b]8;;\x07", scrollbarStyleIndex);
			assert.ok(reservedColumnResetIndex > line.lastIndexOf(contentBackground));
		}

		const thumbHeightFor = (contentHeight: number) => {
			const sized = new ScrollView(new Text(Array.from({ length: contentHeight }, () => "x").join("\n"), 0, 0), {
				scrollbar: "auto",
				scrollbarThumbStyle,
			});
			renderLayoutFrame(sized, 6, 20, () => {});
			sized.scrollBy(1);
			return renderLayoutFrame(sized, 6, 20, () => {}).lines.filter((line) =>
				stripTerminalSequences(line).endsWith("┃"),
			).length;
		};
		assert.strictEqual(thumbHeightFor(21), 19);
		assert.strictEqual(thumbHeightFor(40), 10);
		assert.strictEqual(thumbHeightFor(100), 4);
		assert.strictEqual(thumbHeightFor(400), 2);
	});

	it("preserves only the underlying background beneath overlay scrollbar glyphs", () => {
		const background = "\x1b[42m";
		const borderForeground = "\x1b[31m";
		const content = {
			render: (width: number) =>
				Array.from(
					{ length: 8 },
					() => `${background}${"x".repeat(width - 1)}${borderForeground}│\x1b[39m\x1b[49m`,
				),
			invalidate: () => {},
		};
		const scrollView = new ScrollView(content, {
			scrollbar: "auto",
			scrollbarTrackStyle: (text) => text,
			scrollbarThumbStyle: (text) => text,
		});
		renderLayoutFrame(scrollView, 6, 4, () => {});
		scrollView.scrollBy(1);
		const frame = renderLayoutFrame(scrollView, 6, 4, () => {});

		assert.deepStrictEqual(frame.lines.map(stripTerminalSequences), ["xxxxx│", "xxxxx┃", "xxxxx┃", "xxxxx│"]);
		for (const line of frame.lines) {
			assert.ok(line.includes(background));
			assert.ok(!line.includes(borderForeground));
			assert.ok(line.includes(`\x1b[0m\x1b]8;;\x07${background}`));
		}
	});

	it("updates reserved scrollbar layout at runtime", () => {
		const scrollView = new ScrollView(new Text("123456", 0, 0), { scrollbar: "always" });
		const render = () => renderLayoutFrame(new HStack([scrollView], { align: "start" }), 6, 2, () => {});
		const always = render();
		assert.deepStrictEqual(visibleLines(always.lines), ["12345┃", "6    ┃"]);
		assert.strictEqual(always.root.children[0]?.rect.width, 6);
		assert.strictEqual(always.root.children[0]?.children[0]?.rect.width, 5);

		scrollView.setScrollbar("hidden");
		assert.strictEqual(render().root.children[0]?.children[0]?.rect.width, 6);
		assert.strictEqual(scrollView.isScrollbarVisible, false);
	});

	it("measures nested scroll content from constrained child geometry", () => {
		const inner = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0));
		const outer = new ScrollView(new VStack([{ component: inner, basis: 2 }, new Text("tail", 0, 0)]));
		renderLayoutFrame(outer, 10, 2, () => {});

		assert.strictEqual(inner.viewportHeight, 2);
		assert.strictEqual(outer.scrollBy(10), 9);
		assert.strictEqual(outer.scrollTop, 1);
	});

	it("rebuilds geometry after content changes", () => {
		const text = new Text("one", 0, 0);
		const root = new VStack([text]);
		const first = renderLayoutFrame(root, 10, 4, () => {});
		text.setText("one\ntwo\nthree");
		const second = renderLayoutFrame(root, 10, 4, () => {});

		assert.strictEqual(first.root.children[0]?.lines?.length, 1);
		assert.strictEqual(second.root.children[0]?.lines?.length, 3);
	});
});
