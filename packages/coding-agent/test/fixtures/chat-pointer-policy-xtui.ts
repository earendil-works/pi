import { ProcessTerminal, TUI } from "@kennyfrc/mu-tui";
import { initTheme } from "../../src/theme/theme.js";
import { ChatLayoutComponent } from "../../src/tui/chat-layout.js";

class DynamicChatContent {
	constructor(
		private readonly getPointerOwner: () => string,
		private readonly getModeLabel: () => string,
	) {}

	render(_width: number): string[] {
		const lines = Array.from({ length: 60 }, (_, i) => `chat line ${i + 1}`);
		lines.push(`XTUI_POINTER_POLICY ${this.getPointerOwner()}`);
		lines.push(`XTUI_MODE ${this.getModeLabel()}`);
		return lines;
	}

	invalidate(): void {}
}

class StaticComponent {
	constructor(private readonly lines: string[]) {}

	render(_width: number): string[] {
		return [...this.lines];
	}

	handleInput(_data: string): void {}

	invalidate(): void {}
}

class DynamicFooter {
	constructor(private readonly getModeLabel: () => string) {}

	render(_width: number): string[] {
		return [this.getModeLabel(), "footer"];
	}

	invalidate(): void {}
}

class CommandInputTarget {
	private buffer = "";
	private modeLabel = "Normal mode";

	constructor(
		private readonly ui: TUI,
		private readonly updateMode: (label: string) => void,
	) {}

	handleInput(data: string): void {
		for (const ch of data) {
			if (ch === "\r") {
				if (this.buffer.trim() === "/select") {
					this.modeLabel = "Selection mode";
					this.updateMode(this.modeLabel);
					this.ui.requestRender();
					setTimeout(() => {
						this.ui.enterSelectionMode();
					}, 50);
				}
				this.buffer = "";
				continue;
			}

			if (ch === "\x7f") {
				this.buffer = this.buffer.slice(0, -1);
				continue;
			}

			if (/^[\x20-\x7e]$/.test(ch)) {
				this.buffer += ch;
			}
		}
	}

	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

async function main(): Promise<void> {
	initTheme("dark");
	const terminal = new ProcessTerminal();
	const ui = new TUI(terminal);
	let modeLabel = "Normal mode";

	const chat = new DynamicChatContent(
		() => {
			const uiState = ui as unknown as { mouseTrackingEnabled?: boolean };
			return uiState.mouseTrackingEnabled ? "app" : "terminal";
		},
		() => modeLabel,
	);
	const composer = new StaticComponent(["composer"]);
	const inputTarget = new CommandInputTarget(ui, (label) => {
		modeLabel = label;
	});

	const layout = new ChatLayoutComponent({
		chatContent: chat as never,
		composerContent: composer as never,
		inputTarget: inputTarget as never,
		footer: new DynamicFooter(() => modeLabel) as never,
		getComposerLabel: () => "label",
		getComposerBorderColor: () => (text: string) => text,
		updateComposerViewport: () => {},
	});

	ui.addChild(layout);
	ui.setFocus(layout);
	ui.start();
	ui.requestRender();

	const shutdown = (): void => {
		ui.stop();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	await new Promise<void>(() => {
		setInterval(() => {
			ui.requestRender();
		}, 250);
	});
}

void main();
