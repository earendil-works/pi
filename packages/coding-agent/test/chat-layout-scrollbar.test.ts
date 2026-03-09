import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { initTheme } from "../src/theme/theme.js";
import { ChatLayoutComponent } from "../src/tui/chat-layout.js";

class StaticComponent {
	constructor(private readonly lines: string[]) {}

	render(_width: number): string[] {
		return [...this.lines];
	}

	handleInput(_data: string): void {}
}

class CountingComponent {
	public readonly widths: number[] = [];

	constructor(private readonly lines: string[]) {}

	render(width: number): string[] {
		this.widths.push(width);
		return [...this.lines];
	}

	handleInput(_data: string): void {}
}

class SinkInput {
	public readonly seen: string[] = [];

	handleInput(data: string): void {
		this.seen.push(data);
	}
}

function makeChatLines(count: number): string[] {
	return Array.from({ length: count }, (_, i) => `chat line ${String(i + 1).padStart(2, "0")}`);
}

function buildLayout() {
	const sink = new SinkInput();
	const layout = new ChatLayoutComponent({
		chatContent: new StaticComponent(makeChatLines(60)) as never,
		composerContent: new StaticComponent(["composer"]) as never,
		inputTarget: sink as never,
		footer: new StaticComponent(["footer a", "footer b"]) as never,
		getComposerLabel: () => "label",
		getComposerBorderColor: () => (text: string) => text,
		updateComposerViewport: () => {},
	});
	return { layout, sink };
}

function topChatLine(layout: ChatLayoutComponent): string {
	const rows = layout.render(80);
	const composerStart = rows.findIndex((line) => line.includes("label"));
	assert.notEqual(composerStart, -1, "expected composer label row to exist");
	return rows[0] ?? "";
}

describe("ChatLayoutComponent chat scrollbar", () => {
	const originalRows = process.stdout.rows;

	beforeEach(() => {
		initTheme("dark");
		Object.defineProperty(process.stdout, "rows", { value: 20, configurable: true });
	});

	afterEach(() => {
		if (originalRows === undefined) {
			delete (process.stdout as { rows?: number }).rows;
		} else {
			Object.defineProperty(process.stdout, "rows", { value: originalRows, configurable: true });
		}
	});

	it("jumps when clicking the chat scrollbar track", () => {
		const { layout, sink } = buildLayout();
		const before = topChatLine(layout);

		layout.handleInput("\x1b[<0;79;10M");

		const after = topChatLine(layout);
		assert.notEqual(after, before, "expected clicking the chat scrollbar track to change the viewport");
		assert.deepEqual(sink.seen, [], "expected chat scrollbar clicks not to leak to the editor input target");
	});

	it("drags the chat scrollbar thumb to update the viewport", () => {
		const { layout, sink } = buildLayout();
		topChatLine(layout);
		layout.handleInput("\x1b[<0;79;10M");
		const beforeDrag = topChatLine(layout);

		layout.handleInput("\x1b[<0;79;10M");
		layout.handleInput("\x1b[<32;79;5M");

		const afterDrag = topChatLine(layout);
		assert.notEqual(afterDrag, beforeDrag, "expected dragging the chat scrollbar thumb to change the viewport");
		assert.deepEqual(sink.seen, [], "expected chat scrollbar drag events not to leak to the editor input target");
	});

	it("renders overflowing chat content once at the scrollbar content width", () => {
		const chatContent = new CountingComponent(makeChatLines(60));
		const layout = new ChatLayoutComponent({
			chatContent: chatContent as never,
			composerContent: new StaticComponent(["composer"]) as never,
			inputTarget: new SinkInput() as never,
			footer: new StaticComponent(["footer a", "footer b"]) as never,
			getComposerLabel: () => "label",
			getComposerBorderColor: () => (text: string) => text,
			updateComposerViewport: () => {},
		});

		layout.render(80);

		assert.deepEqual(
			chatContent.widths,
			[78],
			"expected overflowing chats to render once using the scrollbar content width",
		);
	});
});
