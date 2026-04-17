import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

function createComponent(lines: string[]) {
	return {
		render: () => lines,
		invalidate: () => {},
	};
}

function createModeStub(options?: {
	above?: Map<string, any>;
	below?: Map<string, any>;
	headerLines?: string[];
	chatLines?: string[];
	pendingLines?: string[];
	statusLines?: string[];
	editorLines?: string[];
	width?: number;
	screenRowToContentRow?: (row: number) => number;
	focusedComponent?: any;
}) {
	const mode = Object.create(InteractiveMode.prototype) as any;
	const setFocus = vi.fn();
	const requestRender = vi.fn();
	const focusedComponent = options?.focusedComponent ?? null;

	mode.ui = {
		terminal: { columns: options?.width ?? 80 },
		setFocus,
		requestRender,
		getFocusedComponent: () => focusedComponent,
		screenRowToContentRow: options?.screenRowToContentRow ?? ((row: number) => row),
	};
	mode.headerContainer = createComponent(options?.headerLines ?? []);
	mode.chatContainer = createComponent(options?.chatLines ?? []);
	mode.pendingMessagesContainer = createComponent(options?.pendingLines ?? []);
	mode.statusContainer = createComponent(options?.statusLines ?? []);
	mode.editorContainer = createComponent(options?.editorLines ?? ["editor"]);
	mode.extensionWidgetsAbove = options?.above ?? new Map();
	mode.extensionWidgetsBelow = options?.below ?? new Map();

	return { mode, setFocus, requestRender };
}

describe("InteractiveMode widget mouse routing", () => {
	it("focuses and dispatches clicks to above-editor widgets with local coordinates", () => {
		const calls: Array<{ row: number; col: number }> = [];
		const widget = {
			focused: false,
			render: () => ["row 0", "row 1"],
			handleMouse: (event: { row: number; col: number }) => calls.push({ row: event.row, col: event.col }),
			invalidate: () => {},
		};
		const { mode, setFocus, requestRender } = createModeStub({
			above: new Map([["demo", widget]]),
			editorLines: ["editor"],
			screenRowToContentRow: (row: number) => row + 2,
		});

		const consumed = mode.routeWidgetMouseInput("\x1b[<0;3;1M");

		expect(consumed).toBe(true);
		expect(calls).toEqual([{ row: 1, col: 2 }]);
		expect(setFocus).toHaveBeenCalledWith(widget);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("restores editor focus when clicking outside widget regions", () => {
		const widget = {
			render: () => ["row 0", "row 1"],
			handleMouse: vi.fn(),
			invalidate: () => {},
		};
		const { mode, setFocus, requestRender } = createModeStub({
			above: new Map([["demo", widget]]),
		});

		mode.editor = { render: () => ["editor"], invalidate: () => {} };
		const consumed = mode.routeWidgetMouseInput("\x1b[<0;1;1M");

		expect(consumed).toBe(true);
		expect(widget.handleMouse).not.toHaveBeenCalled();
		expect(setFocus).toHaveBeenCalledWith(mode.editor);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("accounts for editor height when routing clicks to below-editor widgets", () => {
		const calls: Array<{ row: number; col: number }> = [];
		const widget = {
			focused: false,
			render: () => ["below 0", "below 1"],
			handleMouse: (event: { row: number; col: number }) => calls.push({ row: event.row, col: event.col }),
			invalidate: () => {},
		};
		const { mode, setFocus, requestRender } = createModeStub({
			below: new Map([["demo", widget]]),
			editorLines: ["editor 0", "editor 1"],
			screenRowToContentRow: (row: number) => row + 1,
		});

		const consumed = mode.routeWidgetMouseInput("\x1b[<0;2;4M");

		expect(consumed).toBe(true);
		expect(calls).toEqual([{ row: 1, col: 1 }]);
		expect(setFocus).toHaveBeenCalledWith(widget);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("focuses legacy interactive widgets that handle keyboard input but not mouse", () => {
		const widget = {
			focused: false,
			render: () => ["legacy"],
			handleInput: vi.fn(),
			invalidate: () => {},
		};
		const { mode, setFocus, requestRender } = createModeStub({
			above: new Map([["legacy", widget]]),
		});

		const consumed = mode.routeWidgetMouseInput("\x1b[<0;1;2M");

		expect(consumed).toBe(true);
		expect(setFocus).toHaveBeenCalledWith(widget);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("escape restores editor focus when a widget is focused", () => {
		const widget = {
			focused: true,
			render: () => ["legacy"],
			handleInput: vi.fn(),
			invalidate: () => {},
		};
		const { mode, setFocus, requestRender } = createModeStub({
			focusedComponent: widget,
		});
		mode.editor = { render: () => ["editor"], invalidate: () => {} };

		const consumed = mode.handleInteractiveWidgetEscape("\x1b");

		expect(consumed).toBe(true);
		expect(setFocus).toHaveBeenCalledWith(mode.editor);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});
