import { Editor } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";

describe("CustomEditor app action fallback", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("falls through to editor handling when an app action explicitly returns false", () => {
		const superSpy = vi.spyOn(Editor.prototype, "handleInput").mockImplementation(() => {});
		const handler = vi.fn(() => false);
		const fakeThis = {
			onExtensionShortcut: undefined,
			keybindings: {
				matches: (_data: string, action: string) => action === "app.bash.background",
			},
			onPasteImage: undefined,
			onEscape: undefined,
			onCtrlD: undefined,
			isShowingAutocomplete: () => false,
			getText: () => "",
			actionHandlers: new Map([["app.bash.background", handler]]),
		};

		(CustomEditor.prototype as unknown as { handleInput(this: unknown, data: string): void }).handleInput.call(
			fakeThis,
			"\u0002",
		);

		expect(handler).toHaveBeenCalledTimes(1);
		expect(superSpy).toHaveBeenCalledTimes(1);
	});

	it("consumes the key when an app action handles it", () => {
		const superSpy = vi.spyOn(Editor.prototype, "handleInput").mockImplementation(() => {});
		const handler = vi.fn(() => true);
		const fakeThis = {
			onExtensionShortcut: undefined,
			keybindings: {
				matches: (_data: string, action: string) => action === "app.bash.background",
			},
			onPasteImage: undefined,
			onEscape: undefined,
			onCtrlD: undefined,
			isShowingAutocomplete: () => false,
			getText: () => "",
			actionHandlers: new Map([["app.bash.background", handler]]),
		};

		(CustomEditor.prototype as unknown as { handleInput(this: unknown, data: string): void }).handleInput.call(
			fakeThis,
			"\u0002",
		);

		expect(handler).toHaveBeenCalledTimes(1);
		expect(superSpy).not.toHaveBeenCalled();
	});
});
