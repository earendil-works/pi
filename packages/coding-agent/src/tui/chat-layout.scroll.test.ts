import assert from "node:assert";
import { type Component, Container, Text } from "@kennyfrc/mu-tui";
import { describe, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { ChatLayoutComponent } from "./chat-layout.js";

class StubComponent implements Component {
	public constructor(private readonly lines: string[]) {}

	render(): string[] {
		return this.lines;
	}

	handleInput(_data: string): void {}

	invalidate(): void {}
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

function createChatLines(count: number): Container {
	const chatContent = new Container();
	for (let i = 1; i <= count; i++) {
		chatContent.addChild(new Text(`line-${String(i).padStart(2, "0")}`, 0, 0));
	}
	return chatContent;
}

function createLayout(chatContent: Container): ChatLayoutComponent {
	return new ChatLayoutComponent({
		chatContent,
		composerContent: new StubComponent(["prompt"]),
		inputTarget: new StubComponent([]),
		footer: new StubComponent(["footer"]),
		getComposerLabel: () => "Composer",
		getComposerBorderColor: () => (text: string) => text,
		updateComposerViewport: () => {},
	});
}

function visibleChatLines(layout: ChatLayoutComponent, width: number): string[] {
	const rendered = layout.render(width);
	const composerStart = rendered.findIndex((line) => line.includes("Composer"));
	const chatLines = composerStart === -1 ? rendered : rendered.slice(0, composerStart - 1);
	return chatLines.map((line) => line.replace(/[█░]$/u, "").trimEnd());
}

describe("ChatLayoutComponent scrolling during streaming", () => {
	it("keeps the visible viewport fixed when the user scrolls up with the mouse wheel", () => {
		initTheme("dark");
		withTerminalSize(24, 80, () => {
			const chatContent = createChatLines(50);
			const layout = createLayout(chatContent);

			visibleChatLines(layout, 80);
			layout.handleInput("\x1b[<64;1;1M");
			const before = visibleChatLines(layout, 80);

			chatContent.addChild(new Text("line-51", 0, 0));
			chatContent.addChild(new Text("line-52", 0, 0));
			const after = visibleChatLines(layout, 80);

			assert.equal(after[0], before[0]);
		});
	});

	it("continues following the bottom when the user has not scrolled up", () => {
		initTheme("dark");
		withTerminalSize(24, 80, () => {
			const chatContent = createChatLines(50);
			const layout = createLayout(chatContent);

			const before = visibleChatLines(layout, 80);

			chatContent.addChild(new Text("line-51", 0, 0));
			chatContent.addChild(new Text("line-52", 0, 0));
			const after = visibleChatLines(layout, 80);

			assert.notEqual(after[0], before[0]);
			assert.equal(after.at(-1), "line-52");
		});
	});

	it("resumes bottom-follow after scrolling back down with the mouse wheel", () => {
		initTheme("dark");
		withTerminalSize(24, 80, () => {
			const chatContent = createChatLines(50);
			const layout = createLayout(chatContent);

			visibleChatLines(layout, 80);
			layout.handleInput("\x1b[<64;1;1M");
			const scrolledUp = visibleChatLines(layout, 80);

			layout.handleInput("\x1b[<65;1;1M");
			const backAtBottom = visibleChatLines(layout, 80);
			chatContent.addChild(new Text("line-51", 0, 0));
			const afterAppend = visibleChatLines(layout, 80);

			assert.notEqual(scrolledUp[0], backAtBottom[0]);
			assert.equal(afterAppend.at(-1), "line-51");
			assert.notEqual(afterAppend[0], backAtBottom[0]);
		});
	});

	it("maps scrollbar track clicks using the visible top-line space rather than bottom-relative space", () => {
		initTheme("dark");
		withTerminalSize(24, 80, () => {
			const chatContent = createChatLines(50);
			const layout = createLayout(chatContent);

			visibleChatLines(layout, 80);
			layout.handleInput("\x1b[<0;79;1M");
			const afterClick = visibleChatLines(layout, 80);

			assert.equal(afterClick[0], "line-01");
		});
	});
});
