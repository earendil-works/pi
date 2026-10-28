import { beforeEach, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const mocks = vi.hoisted(() => ({
	readClipboardFilePaths: vi.fn<() => Promise<string[] | null>>(),
	readClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
	readClipboardText: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/utils/clipboard.ts", () => ({
	copyToClipboard: vi.fn(),
	readClipboardFilePaths: mocks.readClipboardFilePaths,
	readClipboardText: mocks.readClipboardText,
}));
vi.mock("../src/utils/clipboard-image.ts", () => ({
	extensionForImageMimeType: () => "png",
	readClipboardImage: mocks.readClipboardImage,
}));

beforeEach(() => vi.resetAllMocks());

test("Finder file paths take precedence over their icon image", async () => {
	// Regression test for #9999.
	const filePaths = ["/tmp/screenshot.png", "/tmp/My Photos/photo.png"];
	mocks.readClipboardFilePaths.mockResolvedValue(filePaths);
	mocks.readClipboardImage.mockResolvedValue({
		bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
		mimeType: "image/png",
	});
	mocks.readClipboardText.mockResolvedValue(null);
	const insertTextAtCursor = vi.fn<(text: string) => void>();
	const context = {
		editor: { insertTextAtCursor },
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: typeof context): Promise<void>;
	};

	await prototype.handleClipboardPaste.call(context);
	expect(insertTextAtCursor).toHaveBeenCalledExactlyOnceWith(filePaths.join("\n"));
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
});

test("clipboard file paths containing terminal control characters are rejected", async () => {
	const insertTextAtCursor = vi.fn<(text: string) => void>();
	const showError = vi.fn<(message: string) => void>();
	mocks.readClipboardFilePaths.mockResolvedValue(["/tmp/photo\x1b]0;unsafe\x07.png"]);
	const context = {
		editor: { insertTextAtCursor },
		showError,
		ui: { requestRender: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: typeof context): Promise<void>;
	};

	await prototype.handleClipboardPaste.call(context);

	expect(insertTextAtCursor).not.toHaveBeenCalled();
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
	expect(showError).toHaveBeenCalledExactlyOnceWith(
		"Failed to paste from clipboard: Clipboard file path contains control characters",
	);
});

test("native file-path errors are shown without falling through to the icon image", async () => {
	const showError = vi.fn<(message: string) => void>();
	mocks.readClipboardFilePaths.mockRejectedValue(new Error("Native clipboard file read failed"));
	const context = {
		editor: { insertTextAtCursor: vi.fn() },
		showError,
		ui: { requestRender: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: typeof context): Promise<void>;
	};

	await prototype.handleClipboardPaste.call(context);

	expect(context.editor.insertTextAtCursor).not.toHaveBeenCalled();
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
	expect(showError).toHaveBeenCalledExactlyOnceWith(
		"Failed to paste from clipboard: Native clipboard file read failed",
	);
});

test.each([
	["punctuation", "Review:", 7],
	["Unicode text", "確認", 2],
])("clipboard file paths are separated from preceding %s", async (_description, editorText, cursorCol) => {
	const insertTextAtCursor = vi.fn<(text: string) => void>();
	mocks.readClipboardFilePaths.mockResolvedValue(["/tmp/photo.png"]);
	const context = {
		editor: {
			getCursor: () => ({ line: 0, col: cursorCol }),
			getText: () => editorText,
			insertTextAtCursor,
		},
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: typeof context): Promise<void>;
	};

	await prototype.handleClipboardPaste.call(context);

	expect(insertTextAtCursor).toHaveBeenCalledExactlyOnceWith(" /tmp/photo.png");
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
});

test("bash mode shell-quotes file paths and inserts them as arguments", async () => {
	const insertTextAtCursor = vi.fn<(text: string) => void>();
	mocks.readClipboardFilePaths.mockResolvedValue([
		"/tmp/My Photos/photo.png",
		"/tmp/$(touch hacked).png",
		"/tmp/plain.png",
	]);
	const context = {
		editor: {
			getCursor: () => ({ line: 0, col: 3 }),
			getText: () => "catDEST",
			insertTextAtCursor,
		},
		isBashMode: true,
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	const prototype = InteractiveMode.prototype as unknown as {
		handleClipboardPaste(this: typeof context): Promise<void>;
	};

	await prototype.handleClipboardPaste.call(context);

	expect(insertTextAtCursor).toHaveBeenCalledExactlyOnceWith(
		" '/tmp/My Photos/photo.png' '/tmp/$(touch hacked).png' /tmp/plain.png ",
	);
	expect(mocks.readClipboardImage).not.toHaveBeenCalled();
});
