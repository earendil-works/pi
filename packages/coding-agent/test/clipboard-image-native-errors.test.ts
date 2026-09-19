import type * as Tui from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const readClipboardText = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
vi.mock("@earendil-works/pi-tui", async (importOriginal) => ({
	...(await importOriginal<typeof Tui>()),
	getNativeClipboard: () => ({
		async getImage() {
			throw new Error("Native clipboard operation failed");
		},
	}),
}));
vi.mock("../src/utils/clipboard.ts", () => ({ copyToClipboard: vi.fn(), readClipboardText }));
vi.mock("../src/utils/clipboard-command.ts", () => ({ runClipboardCommand: vi.fn(async () => undefined) }));
afterEach(() => vi.unstubAllEnvs());

test("native image errors abort paste without reading text or changing the editor", async () => {
	vi.stubEnv("TERMUX_VERSION", "");
	const context = {
		editor: { insertTextAtCursor: vi.fn() },
		ui: { requestRender: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: typeof context): Promise<void>;
	};
	await prototype.handleClipboardPaste.call(context);
	expect(readClipboardText).not.toHaveBeenCalled();
	expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
	expect(context.ui.requestRender).not.toHaveBeenCalled();
});
