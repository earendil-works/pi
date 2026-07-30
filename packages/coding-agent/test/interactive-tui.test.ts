import type { Component, Terminal } from "@earendil-works/pi-tui";
import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

describe("createInteractiveTui", () => {
	it("selects the alternate-screen renderer only when requested", async () => {
		const mainTerminal = new RecordingTerminal();
		const mainTui = createInteractiveTui({
			alt: false,
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: mainTerminal,
		});
		mainTui.start();
		await mainTerminal.waitForRender();
		expect(mainTerminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(false);
		mainTui.stop();

		const altTerminal = new RecordingTerminal();
		const altTui = createInteractiveTui({
			alt: true,
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: altTerminal,
		});
		altTui.start();
		await altTerminal.waitForRender();
		expect(altTerminal.writes.some((write) => write.includes("\x1b[?1049h"))).toBe(true);
		altTui.stop();
	});
});

type ClearStatusContext = {
	activeStatusIndicator: { kind: "working"; dispose: () => void } | undefined;
	statusContainer: Container;
	options: { alt?: boolean };
	ui: { getClearOnShrink: () => boolean };
	idleStatus: Component;
};

type InteractiveModePrototype = {
	clearStatusIndicator(this: ClearStatusContext, kind?: "working"): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("clear-on-shrink status spacing", () => {
	it("reserves status height only on the main-screen renderer", () => {
		for (const [alt, expectedChildren] of [
			[false, 1],
			[true, 0],
		] as const) {
			const dispose = vi.fn();
			const context: ClearStatusContext = {
				activeStatusIndicator: { kind: "working", dispose },
				statusContainer: new Container(),
				options: { alt },
				ui: { getClearOnShrink: () => true },
				idleStatus: new Text("", 0, 0),
			};

			interactiveModePrototype.clearStatusIndicator.call(context);

			expect(dispose).toHaveBeenCalledOnce();
			expect(context.statusContainer.children).toHaveLength(expectedChildren);
		}
	});
});
