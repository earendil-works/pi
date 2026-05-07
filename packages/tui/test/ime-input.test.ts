/**
 * Integration tests for IME input: StdinBuffer → Editor pipeline.
 *
 * Test scenario: Chinese IME sends CSI-u sequences (Kitty keyboard protocol)
 * followed by raw UTF-8 characters. The StdinBuffer dedup logic should
 * suppress duplicates so the Editor only inserts each character once.
 *
 * Pipeline:
 *   StdinBuffer.process(data) → 'data' events → VirtualTerminal.sendInput()
 *   → TUI.handleInput() → Editor.handleInput() → text inserted
 */
import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import { StdinBuffer } from "../src/stdin-buffer.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

/**
 * Create StdinBuffer → Editor integration test pipeline.
 *
 * VirtualTerminal provides a mock Terminal interface, allowing TUI/Editor
 * to initialize and render. StdinBuffer's 'data' events are forwarded
 * to VirtualTerminal.sendInput(), which triggers TUI.handleInput() →
 * Editor.handleInput().
 *
 * CSI-u sequences in the Editor path: Editor.handleInput() receives the
 * string → KeybindingsManager.matches() checks keybindings → if no match,
 * decodePrintableKey() decodes CSI-u codepoints into characters →
 * insertTextAtCursor(). When forward dedup emits CSI-u sequences, the
 * Editor correctly decodes them to the corresponding CJK characters.
 */
function createTestPipeline() {
	const buffer = new StdinBuffer({ timeout: 10 });
	const term = new VirtualTerminal(120, 40);
	const tui = new TUI(term);
	const editor = new Editor(tui, defaultEditorTheme);

	tui.addChild(editor);
	tui.setFocus(editor);

	// StdinBuffer 'data' → VirtualTerminal.sendInput → TUI.handleInput → Editor.handleInput
	buffer.on("data", (sequence: string) => {
		term.sendInput(sequence);
	});

	// Record submitted texts
	const submittedTexts: string[] = [];
	editor.onSubmit = (text) => submittedTexts.push(text);

	tui.start();

	return { buffer, editor, tui, term, submittedTexts };
}

function createImeTestPipeline() {
	const { buffer, editor, tui, term, submittedTexts } = createTestPipeline();
	const processInput = (data: string) => {
		buffer.process(data);
	};
	const processInputAndFlush = (data: string) => {
		buffer.process(data);
		const flushed = buffer.flush();
		for (const seq of flushed) {
			if (seq) term.sendInput(seq);
		}
	};
	return { buffer, editor, tui, term, submittedTexts, processInput, processInputAndFlush };
}

describe("IME input integration (StdinBuffer → Editor)", () => {
	let editor: Editor;
	let processInput: (data: string) => void;
	let processInputAndFlush: (data: string) => void;

	beforeEach(() => {
		const pipeline = createImeTestPipeline();
		editor = pipeline.editor;
		processInput = pipeline.processInput;
		processInputAndFlush = pipeline.processInputAndFlush;
	});

	it("should correctly insert multi-char CJK via CSI-u (forward dedup)", () => {
		// CSI-u sequences arrive first, raw characters follow (same batch)
		processInputAndFlush("\x1b[20320u\x1b[22909u\x1b[19990u你好世");
		assert.strictEqual(editor.getText(), "你好世");
	});

	it("should correctly insert multi-char CJK via raw (reverse dedup)", () => {
		// Raw characters arrive first, CSI-u sequences follow (same batch)
		processInputAndFlush("你好世\x1b[20320u\x1b[22909u\x1b[19990u");
		assert.strictEqual(editor.getText(), "你好世");
	});

	it("should correctly insert interleaved CJK", () => {
		processInputAndFlush("\x1b[20320u你\x1b[22909u好");
		assert.strictEqual(editor.getText(), "你好");
	});

	it("should insert CJK after slash without doubling", () => {
		editor.handleInput("/");
		processInputAndFlush("\x1b[20320u\x1b[22909u你好");
		assert.strictEqual(editor.getText(), "/你好");
	});

	it("should keep non-matching raw char after CSI-u", () => {
		// CSI-u is "你" (20320), raw is "好" (22909) — no match
		processInputAndFlush("\x1b[20320u好");
		assert.strictEqual(editor.getText(), "你好");
	});

	// ====== Cross-batch tests ======

	it("should correctly insert CJK across separate chunks (forward dedup)", () => {
		// CSI-u in first process(), raw in second process()
		processInput("\x1b[20320u\x1b[22909u");
		processInputAndFlush("你好");
		assert.strictEqual(editor.getText(), "你好");
	});

	it("should insert CJK between existing Chinese text without doubling", () => {
		// Simulate original bug scenario: existing Chinese text, insert in the middle
		editor.handleInput("你好世界");
		// Move cursor between "好" and "世" (cursorLine=0, cursorCol=2)
		editor.handleInput("\x1b[D");
		editor.handleInput("\x1b[D");
		processInputAndFlush("\x1b[32654u\x1b[20029u美丽"); // 32654=美, 20029=丽
		assert.strictEqual(editor.getText(), "你好美丽世界");
	});

	it("should handle non-BMP emoji (known limitation: no dedup)", () => {
		// Non-BMP emoji (U+1F600): sequence.length > 1, not eligible for rawCodepoint check
		// Known: both CSI-u and raw are emitted, Editor inserts two copies
		processInputAndFlush("\x1b[128512u😀");
		assert.strictEqual(editor.getText(), "😀😀");
	});
});
