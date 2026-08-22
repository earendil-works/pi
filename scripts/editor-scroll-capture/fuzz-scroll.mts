/**
 * fuzz-scroll.mts — property-based search for the editor scroll-jump bug.
 *
 * Invariant: after every operation + render(), if the editor holds any text,
 * the rendered output MUST contain the reverse-video cursor cell somewhere.
 * A missing cursor means the view is showing a scroll position where the
 * cursor is not visible (symptom: "editor scroll returned to top, cursor lost").
 *
 * Prints the first failing operation sequence (for deterministic replay).
 *
 * Run: node scripts/editor-scroll-capture/fuzz-scroll.mts [iterations] [seed]
 */
import { Editor } from "../../packages/tui/src/components/editor.ts";
import { TuiMainScreen } from "../../packages/tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../packages/tui/test/virtual-terminal.ts";
import { defaultEditorTheme } from "../../packages/tui/test/test-themes.ts";

const ITER = Number(process.argv[2] ?? 2000);
const SEED = Number(process.argv[3] ?? 42);

// Deterministic PRNG (mulberry32)
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const rand = mulberry32(SEED);
const ri = (n: number): number => Math.floor(rand() * n);
const pick = <T,>(arr: T[]): T => arr[ri(arr.length)]!;

const WORDS = ["foo", "bar", "baz", "word", "longword", "あいう", "日本語", "x", "y", "zz", "🚀", "ab", "cd"];
const PUNCT = [" ", "  ", "   ", ", ", ".\n", "\n", "\n\n", "", " - "];

function randomLine(maxLen: number): string {
	const line: string[] = [];
	let len = 0;
	while (len < maxLen && rand() < 0.9) {
		const w = pick(WORDS);
		line.push(w);
		len += w.length;
		if (len < maxLen) {
			const p = pick(PUNCT);
			line.push(p);
			len += p.length;
		}
	}
	return line.join("");
}

function randomText(): string {
	const n = 1 + ri(40);
	const lines: string[] = [];
	for (let i = 0; i < n; i++) {
		lines.push(ri(4) === 0 ? "" : randomLine(20 + ri(120)));
	}
	return lines.join("\n");
}

const KEYS = [
	"\x1b[A", // up
	"\x1b[B", // down
	"\x1b[C", // right
	"\x1b[D", // left
	"\x1b[H", // home (line start)
	"\x1b[F", // end (line end)
	"\x1b[5~", // pgup
	"\x1b[6~", // pgdn
	"\x01", // ctrl+a (line start)
	"\x05", // ctrl+e (line end)
	"\x7f", // backspace
	"\x1b[3~", // delete
	"\x15", // ctrl+u (delete to line start)
	"\x0b", // ctrl+k (delete to line end)
	"\x17", // ctrl+w (delete word back)
	"\x1a", // ctrl+z... actually ctrl+- is undo; use \x1f? test below
];

function randomOp(editor: Editor, tui: TuiMainScreen): string {
	const r = rand();
	if (r < 0.45) {
		const k = pick(KEYS);
		editor.handleInput(k);
		return `key ${JSON.stringify(k)}`;
	}
	if (r < 0.55) {
		// type a printable char / word
		const s = rand() < 0.7 ? pick(WORDS) : pick(PUNCT);
		editor.handleInput(s);
		return `type ${JSON.stringify(s)}`;
	}
	if (r < 0.65) {
		// setText (app-level rewrite)
		editor.setText(randomText());
		return "setText(random)";
	}
	if (r < 0.7) {
		// setText(same) — save/restore
		const t = editor.getText();
		editor.setText(t);
		return "setText(same)";
	}
	if (r < 0.75) {
		// insertTextAtCursor
		editor.insertTextAtCursor(randomText());
		return "insertTextAtCursor(random)";
	}
	if (r < 0.8) {
		// history cycle
		editor.addToHistory(randomText());
		editor.handleInput("\x1b[A");
		editor.handleInput("\x1b[B");
		return "history-cycle";
	}
	if (r < 0.85) {
		// focus churn
		tui.setFocus(null);
		tui.setFocus(editor);
		return "focus-churn";
	}
	if (r < 0.9) {
		// undo (ctrl+-)
		editor.handleInput("\x1f");
		return "undo";
	}
	if (r < 0.95) {
		// bracketed paste (single-line only to keep it simple)
		editor.handleInput(`\x1b[200~${randomLine(60)}\x1b[201~`);
		return "paste";
	}
	// multiline paste
	editor.handleInput(`\x1b[200~${randomText()}\x1b[201~`);
	return "paste-multi";
}

function cursorVisible(editor: Editor, width: number): { visible: boolean; lines: string[] } {
	const lines = editor.render(width);
	for (const l of lines) {
		if (l.includes("\x1b[7m")) return { visible: true, lines };
	}
	return { visible: false, lines };
}

const COLS = 100;
const ROWS = 30;
const WIDTH = COLS - 2; // editor render width (matches app padding)

let failures = 0;
let lastFailingOps: string[] = [];
let lastFailWidth = WIDTH;

for (let iter = 0; iter < ITER; iter++) {
	const vt = new VirtualTerminal(COLS, ROWS);
	const tui = new TuiMainScreen(vt);
	const editor = new Editor(tui, defaultEditorTheme);
	tui.addChild(editor);
	tui.setFocus(editor);

	const ops: string[] = [];
	const text = randomText();
	editor.setText(text);
	ops.push("setText(initial)");

	let width = WIDTH;
	for (let step = 0; step < 60; step++) {
		const op = randomOp(editor, tui);
		ops.push(op);

		// occasional resize (changes wrapping + maxVisibleLines)
		if (rand() < 0.08) {
			width = 20 + ri(90);
			ops.push(`resize-width ${width}`);
		}

		if (editor.getText().trim() !== "") {
			const { visible, lines } = cursorVisible(editor, width);
			if (!visible) {
				failures++;
				lastFailingOps = [...ops];
				lastFailWidth = width;
				if (failures <= 3) {
					console.log(`\nFAIL #${failures} iter=${iter} step=${step} width=${width}`);
					console.log(`  ops: ${ops.join(" | ")}`);
					console.log(`  cursor missing; rendered rows=${lines.length}`);
					console.log(`  top=${JSON.stringify(stripAnsi(lines[0] ?? ""))}`);
					console.log(`  bottom=${JSON.stringify(stripAnsi(lines.at(-1) ?? ""))}`);
				}
				break;
			}
		}
	}
}

console.log(`\n=== fuzz done: ${ITER} iterations, ${failures} failures (seed=${SEED}) ===`);
if (failures > 0) {
	console.log("first failing sequence:");
	for (const op of lastFailingOps) console.log(`  ${op}`);
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_[^\x07]*\x07/g, "");
}
