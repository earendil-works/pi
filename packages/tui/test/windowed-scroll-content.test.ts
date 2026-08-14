import assert from "node:assert";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import {
	type PreparedWindowedScrollContent,
	WINDOWED_SCROLL_CONTENT,
	type WindowedScrollContent,
	type WindowedScrollContentRequest,
} from "../src/layout-node.ts";
import {
	encodeKitty,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.ts";
import {
	TRANSCRIPT_SEMANTICS,
	type TranscriptSemanticBlock,
	type TranscriptSemantics,
	type TranscriptSemanticsComponent,
	type TranscriptTarget,
} from "../src/transcript.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";

interface WindowRequest {
	startRow: number;
	rowCount: number;
	returnedStartRow: number;
}

class TrackingWindowedTranscript implements WindowedScrollContent, TranscriptSemanticsComponent {
	readonly prepareRequests: WindowedScrollContentRequest[] = [];
	readonly windowRequests: WindowRequest[] = [];
	readonly lineAtRows: number[] = [];
	readonly semanticCalls = {
		blocks: [] as Array<{ startRow: number; endRow: number }>,
		blockAt: [] as number[],
		latestResponse: 0,
		find: [] as TranscriptTarget[],
	};
	fullRenderCount = 0;
	private revision = 0;
	private readonly sourceLines: readonly string[];
	private readonly semanticBlocks: readonly TranscriptSemanticBlock[];
	private readonly lookbehindRows: number;

	constructor(
		lines: readonly string[],
		options: { blocks?: readonly TranscriptSemanticBlock[]; lookbehindRows?: number } = {},
	) {
		this.sourceLines = lines;
		this.semanticBlocks = options.blocks ?? [];
		this.lookbehindRows = options.lookbehindRows ?? 0;
	}

	render(): string[] {
		this.fullRenderCount += 1;
		return [...this.sourceLines];
	}

	invalidate(): void {}

	advanceRevision(): void {
		this.revision += 1;
	}

	[WINDOWED_SCROLL_CONTENT](request: WindowedScrollContentRequest): PreparedWindowedScrollContent {
		this.prepareRequests.push({ ...request });
		return {
			contentHeight: this.sourceLines.length,
			revision: this.revision,
			renderWindow: (startRow, rowCount) => {
				const returnedStartRow = Math.max(0, startRow - this.lookbehindRows);
				this.windowRequests.push({ startRow, rowCount, returnedStartRow });
				return {
					startRow: returnedStartRow,
					lines: this.sourceLines.slice(returnedStartRow, startRow + rowCount),
				};
			},
			lineAt: (row) => {
				this.lineAtRows.push(row);
				return this.sourceLines[row];
			},
		};
	}

	[TRANSCRIPT_SEMANTICS](): TranscriptSemantics {
		return {
			blocks: (startRow, endRow) => {
				this.semanticCalls.blocks.push({ startRow, endRow });
				return this.semanticBlocks.filter((block) => block.endRow > startRow && block.startRow < endRow);
			},
			blockAt: (row) => {
				this.semanticCalls.blockAt.push(row);
				return this.semanticBlocks.find((block) => row >= block.startRow && row < block.endRow);
			},
			latestResponse: () => {
				this.semanticCalls.latestResponse += 1;
				let latestUserRow = -1;
				for (const block of this.semanticBlocks) {
					if (block.target.kind === "user") latestUserRow = Math.max(latestUserRow, block.startRow);
				}
				return this.semanticBlocks.find(
					(block) => block.target.kind === "assistant" && block.startRow > latestUserRow,
				);
			},
			find: (target) => {
				this.semanticCalls.find.push(target);
				return this.semanticBlocks.find(
					(block) => block.target.id === target.id && block.target.kind === target.kind,
				);
			},
		};
	}
}

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

function trimViewport(terminal: VirtualTerminal): string[] {
	return terminal.getViewport().map((line) => line.trimEnd());
}

describe("windowed fullscreen scroll content", () => {
	it("keeps ordinary frames viewport-bounded while preserving prompt navigation and full-transcript search", async () => {
		const terminal = new VirtualTerminal(30, 3);
		const lines = Array.from({ length: 30 }, (_, row) => `row ${row}`);
		lines[5] = "needle old";
		lines[10] = `${OSC133_ZONE_START}prompt 2`;
		lines[20] = `${OSC133_ZONE_START}prompt 3`;
		lines[25] = "needle latest";
		lines[27] = `${OSC133_ZONE_START}prompt 4`;
		const content = new TrackingWindowedTranscript(lines);
		const tui = new TuiAltScreen(terminal);
		tui.setLayoutRoot(new ScrollView(content, { follow: "end", primary: true }));
		tui.start();
		try {
			await terminal.waitForRender();
			content.windowRequests.length = 0;
			content.lineAtRows.length = 0;

			tui.renderNow();
			await terminal.flush();
			assert.deepStrictEqual(content.windowRequests, [{ startRow: 27, rowCount: 3, returnedStartRow: 27 }]);
			assert.deepStrictEqual(content.lineAtRows, []);
			assert.strictEqual(content.fullRenderCount, 0);

			content.windowRequests.length = 0;
			content.lineAtRows.length = 0;
			terminal.sendInput("\x1b[57419;6u");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);
			assert.strictEqual(trimViewport(terminal)[0], "prompt 3");
			assert.deepStrictEqual(content.lineAtRows.slice(0, 7), [26, 25, 24, 23, 22, 21, 20]);
			assert.ok(content.lineAtRows.length <= 7);
			assert.ok(content.windowRequests.every((request) => request.rowCount <= 3));

			content.windowRequests.length = 0;
			terminal.sendInput("\x1b[102;6u");
			terminal.sendInput("needle");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 24);
			assert.strictEqual(tui.readPrimaryTranscriptLine(25), "needle latest");
			assert.ok(terminal.getViewport().some((line) => line.includes("2/2")));
			assert.ok(content.windowRequests.every((request) => request.rowCount <= 3));
			assert.deepStrictEqual(
				[...new Set(content.lineAtRows)].sort((a, b) => a - b),
				[...Array.from({ length: lines.length }, (_, row) => row)],
			);
			const searchedRows = content.lineAtRows.length;
			tui.renderNow();
			await terminal.flush();
			assert.strictEqual(content.lineAtRows.length, searchedRows);
			content.advanceRevision();
			tui.renderNow();
			await terminal.flush();
			assert.strictEqual(content.lineAtRows.length, searchedRows);
			assert.strictEqual(content.fullRenderCount, 0);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("uses provider semantics to navigate stable targets without traversing transcript lines", async () => {
		const terminal = new VirtualTerminal(24, 4);
		const oldAssistant = { id: "assistant-old", kind: "assistant" } satisfies TranscriptTarget;
		const latestAssistant = { id: "assistant-latest", kind: "assistant" } satisfies TranscriptTarget;
		const blocks: TranscriptSemanticBlock[] = [
			{ target: { id: "user-old", kind: "user" }, startRow: 0, endRow: 2 },
			{ target: oldAssistant, startRow: 2, endRow: 10 },
			{ target: { id: "user-latest", kind: "user" }, startRow: 40, endRow: 42 },
			{ target: latestAssistant, startRow: 42, endRow: 55 },
		];
		const content = new TrackingWindowedTranscript(
			Array.from({ length: 60 }, (_, row) => `semantic row ${row}`),
			{ blocks },
		);
		const tui = new TuiAltScreen(terminal);
		tui.setLayoutRoot(new ScrollView(content, { follow: "end", primary: true }));
		tui.start();
		try {
			await terminal.waitForRender();
			content.lineAtRows.length = 0;
			content.windowRequests.length = 0;

			assert.deepStrictEqual(
				tui.getPrimaryTranscriptBlocks({ startRow: 1, endRow: 3 }).map((block) => block.target.id),
				["user-old", "assistant-old"],
			);
			assert.deepStrictEqual(content.semanticCalls.blocks, [{ startRow: 1, endRow: 3 }]);
			assert.deepStrictEqual(content.lineAtRows, []);

			assert.strictEqual(tui.scrollToTranscriptTarget({ id: oldAssistant.id, kind: oldAssistant.kind }), true);
			assert.deepStrictEqual(content.lineAtRows, []);
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 2);
			assert.deepStrictEqual(
				content.semanticCalls.find.map((target) => target.id),
				[oldAssistant.id],
			);
			assert.ok(content.windowRequests.every((request) => request.rowCount <= 4));

			content.lineAtRows.length = 0;
			assert.strictEqual(tui.scrollToLatestResponse(), true);
			assert.deepStrictEqual(content.lineAtRows, []);
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 42);
			assert.strictEqual(content.semanticCalls.latestResponse, 1);
			assert.deepStrictEqual(
				content.semanticCalls.find.map((target) => target.id),
				[oldAssistant.id, latestAssistant.id],
			);
			assert.strictEqual(content.fullRenderCount, 0);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("selects and copies transcript rows after the selection anchor scrolls offscreen", async () => {
		const terminal = new VirtualTerminal(12, 3);
		const copied: string[] = [];
		const lines = Array.from({ length: 40 }, (_, row) => `row${row.toString().padStart(2, "0")}`);
		const content = new TrackingWindowedTranscript(lines);
		const scrollView = new ScrollView(content, { primary: true });
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.setLayoutRoot(scrollView);
		tui.start();
		try {
			await terminal.waitForRender();
			content.lineAtRows.length = 0;
			content.windowRequests.length = 0;

			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;6;3M");
			for (let attempt = 0; attempt < 20 && scrollView.scrollTop < 3; attempt++) {
				await new Promise<void>((resolve) => setTimeout(resolve, 20));
			}
			assert.ok(scrollView.scrollTop >= 3);
			const endRow = scrollView.scrollTop + 2;
			terminal.sendInput("\x1b[<0;6;3m");
			await terminal.waitForRender();

			const expected = lines.slice(0, endRow + 1).join("\n");
			assert.deepStrictEqual(copied, [expected]);
			assert.strictEqual(tui.getSelectionSnapshot()?.text, expected);
			content.lineAtRows.length = 0;
			assert.strictEqual(tui.getSelectionSnapshot({ includeText: false })?.text, "");
			assert.deepStrictEqual(content.lineAtRows, []);
			assert.deepStrictEqual(tui.getSelectionSnapshot({ includeText: false })?.transcriptRange, {
				start: { row: 0, col: 0 },
				end: { row: endRow, col: 5 },
			});
			assert.ok(tui.viewportTop > 0);
			assert.ok(content.windowRequests.every((request) => request.rowCount <= 3));
			assert.ok(content.lineAtRows.every((row) => row >= 0 && row <= endRow));
			assert.ok(new Set(content.lineAtRows).size <= endRow + 1);
			assert.strictEqual(content.fullRenderCount, 0);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("sizes and positions the scrollbar from the provider's full content height", async () => {
		const terminal = new VirtualTerminal(10, 10);
		const content = new TrackingWindowedTranscript(
			Array.from({ length: 100 }, (_, row) => `row ${row.toString().padStart(3, "0")}`),
		);
		const scrollView = new ScrollView(content, {
			primary: true,
			scrollbar: "always",
			scrollbarStyle: () => "#",
		});
		const tui = new TuiAltScreen(terminal);
		tui.setLayoutRoot(scrollView);
		tui.start();
		try {
			await terminal.waitForRender();
			assert.deepStrictEqual(
				terminal.getViewport().map((line) => line.endsWith("#")),
				[true, true, false, false, false, false, false, false, false, false],
			);

			content.windowRequests.length = 0;
			scrollView.scrollTo(45);
			await terminal.waitForRender();
			assert.deepStrictEqual(
				terminal.getViewport().map((line) => line.endsWith("#")),
				[false, false, false, false, true, true, false, false, false, false],
			);
			assert.ok(content.prepareRequests.every((request) => request.width === 9));
			assert.ok(content.windowRequests.every((request) => request.rowCount <= 10));
			assert.strictEqual(content.fullRenderCount, 0);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("crops a Kitty image returned from above the requested viewport", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new RecordingTerminal(20, 3);
		const imageId = 91023;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		const content = new TrackingWindowedTranscript(["before", imageLine, "", "", "after", "end"], {
			lookbehindRows: 2,
		});
		const tui = new TuiAltScreen(terminal);
		tui.setLayoutRoot(new ScrollView(content, { follow: "end", primary: true }));
		tui.start();
		try {
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 3);
			assert.ok(
				content.windowRequests.some(
					(request) => request.startRow === 3 && request.rowCount === 3 && request.returnedStartRow === 1,
				),
			);
			assert.deepStrictEqual(content.lineAtRows.slice(0, 2), [2, 1]);
			assert.ok(terminal.writes.some((write) => write.includes(`i=${imageId}`) && write.includes("y=66,h=34,r=1")));
			assert.strictEqual(content.fullRenderCount, 0);
		} finally {
			tui.stop({ preserveScreen: true });
			resetCapabilitiesCache();
		}
	});

	it("keeps the last good frame and reports provider faults without crashing or eager fallback", async () => {
		const terminal = new VirtualTerminal(24, 3);
		let fail = false;
		let fullRenderCount = 0;
		const provider: WindowedScrollContent = {
			render: () => {
				fullRenderCount += 1;
				return ["fallback"];
			},
			invalidate: () => {},
			[WINDOWED_SCROLL_CONTENT]: () => {
				if (fail) throw new Error("injected viewport fault");
				return {
					contentHeight: 3,
					renderWindow: (startRow, rowCount) => ({
						startRow,
						lines: ["good one", "good two", "good three"].slice(startRow, startRow + rowCount),
					}),
					lineAt: (row) => ["good one", "good two", "good three"][row],
				};
			},
		};
		const tui = new TuiAltScreen(terminal);
		tui.setLayoutRoot(new ScrollView(provider, { primary: true }));
		tui.start();
		try {
			await terminal.waitForRender();
			assert.deepStrictEqual(trimViewport(terminal), ["good one", "good two", "good three"]);
			fail = true;
			assert.doesNotThrow(() => tui.renderNow());
			await terminal.flush();
			assert.ok(trimViewport(terminal)[0]?.includes("Render failed: injected"));
			assert.strictEqual(fullRenderCount, 0);

			fail = false;
			tui.renderNow();
			await terminal.flush();
			assert.deepStrictEqual(trimViewport(terminal), ["good one", "good two", "good three"]);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	});

	it("rejects malformed windows and propagates provider faults without falling back to full render", () => {
		const validLineAt = (row: number): string | undefined => (row >= 0 && row < 5 ? `row ${row}` : undefined);
		const cases: Array<{
			name: string;
			expected: RegExp;
			prepare: (request: WindowedScrollContentRequest) => PreparedWindowedScrollContent;
		}> = [
			{
				name: "invalid height",
				expected: /height must be a non-negative safe integer/,
				prepare: () => ({
					contentHeight: -1,
					renderWindow: () => ({ startRow: 0, lines: [] }),
					lineAt: validLineAt,
				}),
			},
			{
				name: "window starts after requested row",
				expected: /outside its document bounds/,
				prepare: () => ({
					contentHeight: 5,
					renderWindow: (startRow, rowCount) => ({
						startRow: startRow + 1,
						lines: Array.from({ length: rowCount }, () => "row"),
					}),
					lineAt: validLineAt,
				}),
			},
			{
				name: "window does not cover viewport",
				expected: /did not cover the requested viewport/,
				prepare: () => ({
					contentHeight: 5,
					renderWindow: (startRow) => ({ startRow, lines: [] }),
					lineAt: validLineAt,
				}),
			},
			{
				name: "window contains a non-string line",
				expected: /lines must be strings/,
				prepare: () => ({
					contentHeight: 5,
					renderWindow: (startRow) => ({ startRow, lines: ["row", 0 as unknown as string, "row"] }),
					lineAt: validLineAt,
				}),
			},
			{
				name: "provider fault",
				expected: /provider failed/,
				prepare: () => {
					throw new Error("provider failed");
				},
			},
		];

		for (const testCase of cases) {
			let fullRenderCount = 0;
			const provider: WindowedScrollContent = {
				render: () => {
					fullRenderCount += 1;
					return ["fallback"];
				},
				invalidate: () => {},
				[WINDOWED_SCROLL_CONTENT]: testCase.prepare,
			};
			assert.throws(
				() => renderLayoutFrame(new ScrollView(provider, { primary: true }), 10, 3, () => {}),
				testCase.expected,
				testCase.name,
			);
			assert.strictEqual(fullRenderCount, 0, testCase.name);
		}
	});
});
