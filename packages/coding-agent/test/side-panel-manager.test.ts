import { describe, expect, it, vi } from "vitest";
import { SidePanelManager } from "../src/modes/interactive/components/side-panel-manager.js";

function createMockOverlayHandle() {
	return {
		hide: vi.fn(),
		setHidden: vi.fn(),
		isHidden: vi.fn(() => false),
		focus: vi.fn(),
		unfocus: vi.fn(),
		isFocused: vi.fn(() => false),
	};
}

describe("SidePanelManager", () => {
	it("shows a non-capturing right-aligned overlay with defaults", () => {
		const handle = createMockOverlayHandle();
		const showOverlay = vi.fn(() => handle);
		const tui = { showOverlay } as any;
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;

		const manager = new SidePanelManager(tui, theme);
		manager.set(["Line 1", "Line 2"]);

		expect(showOverlay).toHaveBeenCalledTimes(1);
		const [, options] = showOverlay.mock.calls[0]!;
		expect(options.nonCapturing).toBe(true);
		expect(options.anchor).toBe("right-center");
		expect(options.minWidth).toBe(24);
		expect(options.margin).toBe(1);
	});

	it("hides and disposes the previous side panel when replaced or cleared", () => {
		const firstHandle = createMockOverlayHandle();
		const secondHandle = createMockOverlayHandle();
		const showOverlay = vi.fn()
			.mockReturnValueOnce(firstHandle)
			.mockReturnValueOnce(secondHandle);
		const tui = { showOverlay } as any;
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
		const firstDispose = vi.fn();
		const secondDispose = vi.fn();

		const manager = new SidePanelManager(tui, theme);
		manager.set(() => ({ render: () => ["one"], invalidate() {}, dispose: firstDispose } as any));
		manager.set(() => ({ render: () => ["two"], invalidate() {}, dispose: secondDispose } as any));

		expect(firstHandle.hide).toHaveBeenCalledTimes(1);
		expect(firstDispose).toHaveBeenCalledTimes(1);

		manager.clear();
		expect(secondHandle.hide).toHaveBeenCalledTimes(1);
		expect(secondDispose).toHaveBeenCalledTimes(1);
	});

	it("applies visibleMinWidth through overlay visibility callback", () => {
		const handle = createMockOverlayHandle();
		const showOverlay = vi.fn(() => handle);
		const tui = { showOverlay } as any;
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;

		const manager = new SidePanelManager(tui, theme);
		manager.set(["Line 1"], { visibleMinWidth: 100 });

		const [, options] = showOverlay.mock.calls[0]!;
		expect(options.visible(120, 40)).toBe(true);
		expect(options.visible(80, 40)).toBe(false);
	});
});
