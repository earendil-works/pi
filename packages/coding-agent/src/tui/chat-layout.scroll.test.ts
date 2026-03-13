import assert from "node:assert";
import { type Component, Container, Text, visibleWidth } from "@kennyfrc/mu-tui";
import { Terminal } from "@xterm/headless";
import { describe, it } from "vitest";
import { initTheme, theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
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

	it("truncates long composer meta labels so the composer frame stays within width", () => {
		initTheme("dark");
		withTerminalSize(24, 80, () => {
			const layout = new ChatLayoutComponent({
				chatContent: createChatLines(3),
				composerContent: new StubComponent(["prompt"]),
				inputTarget: new StubComponent([]),
				footer: new StubComponent(["footer"]),
				getComposerLabel: () => "Composer",
				getComposerMetaLabel: () =>
					[
						theme.fg("muted", "(sub) 0% of 262k"),
						theme.fg("muted", "mission levell-readiness"),
						theme.fg("muted", "iter 1"),
						theme.fg("muted", "running"),
						theme.fg("muted", "0/10 done"),
						theme.fg("muted", "task L1-001: Define and document the Level 1 baseline"),
					].join(theme.fg("muted", " • ")),
				getComposerBorderColor: () => (text: string) => text,
				updateComposerViewport: () => {},
			});

			const width = 56;
			const rendered = layout.render(width);
			const composerBottomLine = rendered[rendered.length - 1] ?? "";

			assert.ok(visibleWidth(composerBottomLine) <= width, composerBottomLine);
			assert.ok(composerBottomLine.includes("…"), composerBottomLine);
		});
	});

	it("does not leak thinking italics into the composer when overflow shows a mid-thinking slice", async () => {
		initTheme("dark");
		withTerminalSize(8, 40, () => {
			const chatContent = new Container();
			for (let i = 1; i <= 3; i++) {
				chatContent.addChild(new Text(`filler-${i}`, 0, 0));
			}

			chatContent.addChild(
				new AssistantMessageComponent({
					role: "assistant",
					content: [
						{
							type: "thinking",
							thinking:
								"This is a long thinking block that should wrap across several visual lines and stay italic until its final wrapped line closes the style.",
						},
					],
					api: "openai-completions",
					provider: "openai",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				}),
			);

			const layout = createLayout(chatContent);
			layout.render(40);
			layout.handleInput("\x1b[<64;1;1M");
			const rendered = layout.render(40);

			const terminal = new Terminal({ cols: 40, rows: 8, allowProposedApi: true, disableStdin: true });
			return new Promise<void>((resolve, reject) => {
				terminal.write(rendered.join("\r\n"), () => {
					try {
						const promptRow = rendered.findIndex((line) => line.includes("prompt"));
						assert.ok(promptRow >= 0, "expected prompt row to be visible");
						const line = terminal.buffer.active.getLine(promptRow);
						const italicPromptChars: string[] = [];
						for (let x = 0; x < 40; x++) {
							const cell = line?.getCell(x);
							if (!cell) continue;
							const ch = cell.getChars();
							if (!ch || !/[a-z]/i.test(ch)) continue;
							if ((cell.isItalic?.() ?? 0) !== 0) italicPromptChars.push(ch);
						}
						assert.deepEqual(italicPromptChars, [], "expected composer prompt to stay non-italic");
						resolve();
					} catch (error) {
						reject(error);
					}
				});
			});
		});
	});
});
