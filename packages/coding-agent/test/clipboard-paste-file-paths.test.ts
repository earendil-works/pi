import { beforeEach, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const mocks = vi.hoisted(() => ({
	readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>(),
	readClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: vi.fn(),
	readClipboardText: mocks.readClipboardText,
	readClipboardFilePaths: mocks.readClipboardFilePaths,
}));
vi.mock("../src/utils/clipboard-image.ts", () => ({
	extensionForImageMimeType: () => "png",
	readClipboardImage: mocks.readClipboardImage,
}));

type PasteContext = {
	editor: { insertTextAtCursor: ReturnType<typeof vi.fn> };
	ui: { requestRender: ReturnType<typeof vi.fn> };
};

function pasteContext(): { context: PasteContext; run: () => Promise<void> } {
	const context: PasteContext = {
		editor: { insertTextAtCursor: vi.fn() },
		ui: { requestRender: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: PasteContext): Promise<void>;
	};
	return { context, run: () => prototype.handleClipboardPaste.call(context) };
}

beforeEach(() => vi.resetAllMocks());

// Regression test for #9999: a Finder file copy publishes the file icon as
// image data, so the file path must win over the image branch.
test("a file copy pastes the file path and never consults the image reader", async () => {
	mocks.readClipboardFilePaths.mockResolvedValue(["/tmp/Photos/screenshot.png"]);
	const { context, run } = pasteContext();
	await run();
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
	expect(mocks.readClipboardText).not.toHaveBeenCalled();
	expect(context.editor.insertTextAtCursor).toHaveBeenCalledWith("/tmp/Photos/screenshot.png");
	expect(context.ui.requestRender).toHaveBeenCalledExactlyOnceWith();
});

test("a multi-file copy pastes one raw path per line", async () => {
	mocks.readClipboardFilePaths.mockResolvedValue(["/tmp/a.png", "/tmp/My Photos/b.png"]);
	const { context, run } = pasteContext();
	await run();
	expect(context.editor.insertTextAtCursor).toHaveBeenCalledWith("/tmp/a.png\n/tmp/My Photos/b.png");
});

test("without file paths the image and text branches still run", async () => {
	mocks.readClipboardFilePaths.mockResolvedValue(null);
	mocks.readClipboardImage.mockResolvedValue(null);
	mocks.readClipboardText.mockResolvedValue("plain text");
	const { context, run } = pasteContext();
	await run();
	expect(mocks.readClipboardImage).toHaveBeenCalledExactlyOnceWith();
	expect(context.editor.insertTextAtCursor).toHaveBeenCalledWith("plain text");
});
