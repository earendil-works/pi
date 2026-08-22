/**
 * editor-scroll-demo.ts
 *
 * Scriptable minimal TUI app for capturing/verifying Editor scroll behavior.
 * Built on the same TuiMainScreen + Editor stack as pi's interactive mode so
 * layout/render behavior matches the real app.
 *
 * Usage:
 *   EDITOR_DEMO_TEXT_FILE=prompt.txt \
 *   EDITOR_DEMO_EVENT_LOG=/tmp/demo-events.jsonl \
 *   PI_TUI_WRITE_LOG=/tmp/demo-ansi.log \
 *   node test/editor-scroll-demo.ts
 *
 * Environment:
 *   EDITOR_DEMO_TEXT_FILE    initial editor text (default: generated 45-line text)
 *   EDITOR_DEMO_REWRITE_FILE text used by the F5 rewrite trigger (default: same as initial)
 *   EDITOR_DEMO_EVENT_LOG    JSONL event log (triggers, cursor/scroll observations)
 *   PI_TUI_WRITE_LOG         set by capture harness; terminal.ts records raw ANSI here
 *
 * Trigger keys (simulate app-level events that interactive-mode performs on the editor):
 *   F5  editor.setText(rewriteText)                     — fork/navigate/extension rewrite
 *   F6  addToHistory + Up/Down cycle                    — prompt history browsing
 *   F7  tui.setFocus(null) then setFocus(editor)        — focus churn
 *   F8  save/restore getText()/setText(saved)           — custom-UI restore path
 *   F9  onSubmit (submits and stops the app)
 *   Ctrl+C  exit
 *
 * All other keys are forwarded to the normal Editor handling.
 */
import * as fs from "node:fs";
import { Editor } from "../src/components/editor.ts";
import { ProcessTerminal } from "../src/terminal.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";

const EVENT_LOG = process.env.EDITOR_DEMO_EVENT_LOG || "/tmp/editor-scroll-demo-events.jsonl";

function logEvent(event: string, detail: Record<string, unknown> = {}): void {
	try {
		fs.appendFileSync(EVENT_LOG, `${JSON.stringify({ t: Date.now(), event, ...detail })}\n`);
	} catch {
		// Event log is best-effort; never crash the app over it.
	}
}

function readTextFile(path: string | undefined, fallback: string): string {
	if (!path) return fallback;
	try {
		return fs.readFileSync(path, "utf8");
	} catch {
		return fallback;
	}
}

const generatedText = Array.from({ length: 45 }, (_, i) => `line-${String(i).padStart(2, "0")} payload`).join("\n");
const initialText = readTextFile(process.env.EDITOR_DEMO_TEXT_FILE, generatedText);
const rewriteText = readTextFile(process.env.EDITOR_DEMO_REWRITE_FILE, initialText);

class ScrollDemoEditor extends Editor {
	private f5Count = 0;

	override handleInput(data: string): void {
		// Legacy F-key sequences (dumb PTY: no kitty protocol in effect).
		if (data === "\x1b[15~") {
			this.f5Count++;
			logEvent("trigger", { name: "f5-setText", count: this.f5Count, textLen: rewriteText.length });
			this.setText(rewriteText);
			return;
		}
		if (data === "\x1b[17~") {
			logEvent("trigger", { name: "f6-history-cycle" });
			this.addToHistory(initialText);
			this.handleInput("\x1b[A"); // Up → history entry
			this.handleInput("\x1b[B"); // Down → draft restore
			return;
		}
		if (data === "\x1b[18~") {
			logEvent("trigger", { name: "f7-focus-churn" });
			const tui = (this as unknown as { tui: TuiMainScreen }).tui;
			tui.setFocus(null);
			tui.setFocus(this);
			return;
		}
		if (data === "\x1b[19~") {
			logEvent("trigger", { name: "f8-save-restore", textLen: this.getText().length });
			const saved = this.getText();
			this.setText(saved);
			return;
		}
		if (data === "\x1b[20~") {
			logEvent("trigger", { name: "f9-submit", textLen: this.getText().length });
			this.onSubmit?.(this.getText());
			return;
		}
		super.handleInput(data);
	}
}

const terminal = new ProcessTerminal();
const tui = new TuiMainScreen(terminal);
const editor = new ScrollDemoEditor(tui, defaultEditorTheme);

tui.addChild(editor);
tui.setFocus(editor);
editor.setText(initialText);

logEvent("start", { textLines: initialText.split("\n").length });

editor.onSubmit = (text: string) => {
	logEvent("submitted", { textLen: text.length });
	tui.stop();
	process.exit(0);
};

tui.start();

// Ctrl+C is handled by TuiMainScreen (stop); exit cleanly when stopped.
process.on("exit", () => logEvent("exit"));
