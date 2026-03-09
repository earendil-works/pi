import assert from "node:assert/strict";
import type { AssistantMessage, Usage } from "@kennyfrc/mu-ai";
import { Container, Text } from "@kennyfrc/mu-tui";
import { afterEach, beforeEach, describe, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { ChatLayoutComponent } from "./chat-layout.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

class SinkInput {
	public readonly seen: string[] = [];

	handleInput(data: string): void {
		this.seen.push(data);
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function stripChatScrollbar(text: string): string {
	return text.replace(/[█░]$/u, "");
}

function makeUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "openai",
		model: "gpt-4o-mini",
		api: "openai-responses",
		timestamp: Date.now(),
		stopReason: "stop",
		usage: makeUsage(),
	};
}

function buildTranscriptLayout(): { layout: ChatLayoutComponent; sink: SinkInput } {
	return buildTranscriptLayoutWithCopySpy().base;
}

function buildTranscriptLayoutWithCopySpy(): {
	base: { layout: ChatLayoutComponent; sink: SinkInput };
	copied: string[];
} {
	const sink = new SinkInput();
	const copied: string[] = [];
	const chatContent = new Container();
	chatContent.addChild(new Text("top chrome", 0, 0));
	chatContent.addChild(new UserMessageComponent("user selectable body", true));
	chatContent.addChild(new AssistantMessageComponent(makeAssistantMessage("assistant selectable body")));
	const tool = new ToolExecutionComponent("bash", { command: 'printf "tool selectable body"' });
	tool.updateResult({
		content: [{ type: "text", text: "tool selectable body" }],
		isError: false,
	});
	chatContent.addChild(tool);

	const layout = new ChatLayoutComponent({
		chatContent,
		composerContent: new Text("composer", 0, 0),
		inputTarget: sink,
		footer: new Text("footer", 0, 0),
		getComposerLabel: () => "You",
		getComposerBorderColor: () => (text: string) => text,
		updateComposerViewport: () => {},
		onTranscriptSelectionCopy: (text) => {
			copied.push(text);
		},
	});

	return { base: { layout, sink }, copied };
}

function withTerminalSize(rows: number, columns: number, fn: () => void): void {
	const originalRows = process.stdout.rows;
	const originalColumns = process.stdout.columns;
	Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
	try {
		fn();
	} finally {
		Object.defineProperty(process.stdout, "rows", { value: originalRows, configurable: true });
		Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
	}
}

function findRenderedRow(layout: ChatLayoutComponent, width: number, needle: string): number {
	const rows = layout.render(width).map((line) => stripChatScrollbar(stripAnsi(line)).trimEnd());
	const index = rows.findIndex((line) => line.includes(needle));
	assert.notEqual(index, -1, `expected to find rendered row containing ${needle}`);
	return index + 1;
}

function renderedRowRaw(layout: ChatLayoutComponent, width: number, row: number): string {
	return layout.render(width)[row - 1] ?? "";
}

function columnForNeedle(layout: ChatLayoutComponent, width: number, row: number, needle: string): number {
	const rendered = stripChatScrollbar(stripAnsi(renderedRowRaw(layout, width, row)));
	const index = rendered.indexOf(needle);
	assert.notEqual(index, -1, `expected row ${row} to contain ${needle}`);
	return index + 1;
}

function dragSelection(layout: ChatLayoutComponent, x: number, startRow: number, endRow: number): void {
	layout.handleInput(`\x1b[<0;${x};${startRow}M`);
	layout.handleInput(`\x1b[<32;${x};${endRow}M`);
	layout.handleInput(`\x1b[<0;${x};${endRow}m`);
}

function startSelection(layout: ChatLayoutComponent, x: number, startRow: number, endRow: number): void {
	layout.handleInput(`\x1b[<0;${x};${startRow}M`);
	layout.handleInput(`\x1b[<32;${x};${endRow}M`);
}

describe("ChatLayoutComponent transcript drag selection spec", () => {
	beforeEach(() => {
		initTheme("dark");
	});

	afterEach(() => {
		// no-op hook keeps test structure parallel with other chat layout suites
	});

	it("consumes drag gestures over user messages instead of leaking them to the input target", () => {
		withTerminalSize(20, 80, () => {
			const { layout, sink } = buildTranscriptLayout();
			const row = findRenderedRow(layout, 80, "user selectable body");

			dragSelection(layout, 10, row, row);

			assert.deepEqual(
				sink.seen,
				[],
				"expected dragging across a rendered user message to stay inside transcript selection handling",
			);
		});
	});

	it("consumes drag gestures over assistant messages instead of leaking them to the input target", () => {
		withTerminalSize(20, 80, () => {
			const { layout, sink } = buildTranscriptLayout();
			const row = findRenderedRow(layout, 80, "assistant selectable body");

			dragSelection(layout, 10, row, row);

			assert.deepEqual(
				sink.seen,
				[],
				"expected dragging across a rendered assistant message to stay inside transcript selection handling",
			);
		});
	});

	it("consumes drag gestures over tool execution rows instead of leaking them to the input target", () => {
		withTerminalSize(20, 80, () => {
			const { layout, sink } = buildTranscriptLayout();
			const row = findRenderedRow(layout, 80, "tool selectable body");

			dragSelection(layout, 10, row, row);

			assert.deepEqual(
				sink.seen,
				[],
				"expected dragging across a rendered tool execution block to stay inside transcript selection handling",
			);
		});
	});

	it("consumes drag gestures over chat chrome rows instead of leaking them to the input target", () => {
		withTerminalSize(20, 80, () => {
			const { layout, sink } = buildTranscriptLayout();
			const row = findRenderedRow(layout, 80, "top chrome");

			dragSelection(layout, 10, row, row);

			assert.deepEqual(
				sink.seen,
				[],
				"expected dragging across visible chat-pane chrome to stay inside transcript selection handling",
			);
		});
	});

	it("renders a visible highlight while dragging across selectable transcript rows", () => {
		withTerminalSize(20, 80, () => {
			const { layout } = buildTranscriptLayout();
			const row = findRenderedRow(layout, 80, "assistant selectable body");
			const before = renderedRowRaw(layout, 80, row);

			startSelection(layout, 10, row, row);

			const during = renderedRowRaw(layout, 80, row);
			assert.notEqual(
				during,
				before,
				"expected an active transcript drag selection to visibly change the selected row render",
			);
		});
	});

	it("renders a visible highlight when dragging over visible chat chrome rows", () => {
		withTerminalSize(20, 80, () => {
			const { layout } = buildTranscriptLayout();
			const row = findRenderedRow(layout, 80, "top chrome");
			const before = renderedRowRaw(layout, 80, row);

			startSelection(layout, 10, row, row);

			const during = renderedRowRaw(layout, 80, row);
			assert.notEqual(during, before, "expected visible chat chrome rows to participate in selection highlight");
		});
	});

	it("copies the selected visible transcript text on mouseup and clears the highlight", () => {
		withTerminalSize(20, 80, () => {
			const {
				base: { layout },
				copied,
			} = buildTranscriptLayoutWithCopySpy();
			const row = findRenderedRow(layout, 80, "assistant selectable body");
			const endX = columnForNeedle(layout, 80, row, "body") + "body".length - 1;
			const before = renderedRowRaw(layout, 80, row);

			startSelection(layout, 1, row, row);
			layout.handleInput(`\x1b[<32;${endX};${row}M`);
			const during = renderedRowRaw(layout, 80, row);
			layout.handleInput(`\x1b[<0;${endX};${row}m`);
			const after = renderedRowRaw(layout, 80, row);

			assert.deepEqual(copied, ["assistant selectable body"]);
			assert.notEqual(during, before, "expected active selection to remain visible until mouseup");
			assert.equal(after, before, "expected selection highlight to clear after copying on mouseup");
		});
	});

	it("copies visible chat chrome text too", () => {
		withTerminalSize(20, 80, () => {
			const {
				base: { layout },
				copied,
			} = buildTranscriptLayoutWithCopySpy();
			const row = findRenderedRow(layout, 80, "top chrome");
			const endX = columnForNeedle(layout, 80, row, "chrome") + "chrome".length - 1;

			layout.handleInput(`\x1b[<0;1;${row}M`);
			layout.handleInput(`\x1b[<32;${endX};${row}M`);
			layout.handleInput(`\x1b[<0;${endX};${row}m`);

			assert.deepEqual(copied, ["top chrome"], "expected visible chat-pane chrome drags to produce copied text");
		});
	});

	it("does not copy on a plain click without a drag", () => {
		withTerminalSize(20, 80, () => {
			const {
				base: { layout },
				copied,
			} = buildTranscriptLayoutWithCopySpy();
			const row = findRenderedRow(layout, 80, "assistant selectable body");

			layout.handleInput(`\x1b[<0;10;${row}M`);
			layout.handleInput(`\x1b[<0;10;${row}m`);

			assert.deepEqual(copied, [], "expected a click without drag not to copy transcript text");
		});
	});

	it("copies only the dragged column span for a single chat line", () => {
		withTerminalSize(20, 80, () => {
			const {
				base: { layout },
				copied,
			} = buildTranscriptLayoutWithCopySpy();
			const row = findRenderedRow(layout, 80, "assistant selectable body");
			const startX = columnForNeedle(layout, 80, row, "assistant");
			const endX = columnForNeedle(layout, 80, row, "selectable") + "selectable".length - 1;

			layout.handleInput(`\x1b[<0;${startX};${row}M`);
			layout.handleInput(`\x1b[<32;${endX};${row}M`);
			layout.handleInput(`\x1b[<0;${endX};${row}m`);

			assert.deepEqual(
				copied,
				["assistant selectable"],
				"expected chat-pane copy to respect the dragged horizontal span on a single line",
			);
		});
	});

	it("does not start selection from the scrollbar column", () => {
		withTerminalSize(20, 80, () => {
			const {
				base: { layout },
				copied,
			} = buildTranscriptLayoutWithCopySpy();
			const row = findRenderedRow(layout, 80, "assistant selectable body");
			const before = renderedRowRaw(layout, 80, row);

			layout.handleInput(`\x1b[<0;79;${row}M`);
			layout.handleInput(`\x1b[<32;79;${row}M`);
			layout.handleInput(`\x1b[<0;79;${row}m`);

			assert.deepEqual(copied, [], "expected scrollbar drags not to copy chat text");
			assert.equal(
				renderedRowRaw(layout, 80, row),
				before,
				"expected scrollbar drags not to apply chat-row selection highlight",
			);
		});
	});

	it("uses the full visible chat width when no scrollbar is present", () => {
		withTerminalSize(12, 30, () => {
			const copied: string[] = [];
			const layout = new ChatLayoutComponent({
				chatContent: new Text("123456789012345678901234567890", 0, 0),
				composerContent: new Text("composer", 0, 0),
				inputTarget: new SinkInput(),
				onTranscriptSelectionCopy: (text) => {
					copied.push(text);
				},
				footer: new Text("footer", 0, 0),
				getComposerLabel: () => "You",
				getComposerBorderColor: () => (text: string) => text,
				updateComposerViewport: () => {},
			});

			const firstRender = layout.render(30);
			assert.equal(
				stripAnsi(firstRender[0] ?? "").trimEnd(),
				"123456789012345678901234567890",
				"expected a chat line that fits the pane to stay on one visible row when no scrollbar is present",
			);
			assert.equal(
				stripAnsi(firstRender[1] ?? "").trimEnd(),
				"",
				"expected no wrapped spill line before the composer",
			);

			layout.handleInput("\x1b[<0;1;1M");
			layout.handleInput("\x1b[<32;30;1M");
			layout.handleInput("\x1b[<0;30;1m");

			assert.deepEqual(
				copied,
				["123456789012345678901234567890"],
				"expected no-scrollbar horizontal selection to match the full visible row width",
			);
		});
	});
});
