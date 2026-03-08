import assert from "node:assert";
import { type Component, type Terminal, Text, TUI } from "@kennyfrc/mu-tui";
import { describe, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { ChatLayoutComponent } from "./chat-layout.js";

const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";

class RecordingTerminal implements Terminal {
	public readonly writes: string[] = [];

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	write(data: string): void {
		this.writes.push(data);
	}
	get columns(): number {
		return 80;
	}
	get rows(): number {
		return 24;
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
}

class DummyComponent implements Component {
	render(): string[] {
		return ["dummy"];
	}

	invalidate(): void {}
}

function createChatLayout(): ChatLayoutComponent {
	return new ChatLayoutComponent({
		chatContent: new Text("chat content", 0, 0),
		composerContent: new Text("composer", 0, 0),
		inputTarget: new DummyComponent(),
		footer: new Text("footer", 0, 0),
		getComposerLabel: () => "You",
		getComposerBorderColor: () => (text: string) => text,
		updateComposerViewport: () => {},
	});
}

describe("ChatLayoutComponent mouse ownership", () => {
	it("keeps normal chat app-owned by default so scrollbar mouse interactions remain available", () => {
		initTheme("dark");
		const terminal = new RecordingTerminal();
		const ui = new TUI(terminal);
		const chatLayout = createChatLayout();

		ui.addChild(chatLayout);
		ui.setFocus(chatLayout);
		ui.start();

		const joined = terminal.writes.join("");
		assert.equal(
			joined.includes(ENABLE_MOUSE_TRACKING),
			true,
			"expected normal mu chat mode to enable mouse tracking so scrollbar mouse interactions work by default",
		);

		ui.stop();
	});
});
