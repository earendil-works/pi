#!/usr/bin/env node
/**
 * analyze.mjs — ANSI capture analyzer for the pi Editor scroll bug.
 *
 * Reads a capture directory produced by capture.py:
 *   timeline.jsonl   { t, dir: "in"|"out", hex }  (authoritative, has timing)
 *   events.jsonl     demo app trigger log (optional, for correlation)
 *
 * Reconstructs a virtual terminal screen from the "out" stream and watches
 * the pi Editor's scroll indicators:
 *   top border    "─── ↑ N more "  → editor scrolled down by N
 *   top border    "───────..."     → editor at top
 *   bottom border "─── ↓ M more "  → M lines hidden below
 *
 * Detects "scroll jumped to top" anomalies (symptom b):
 *   - top border ↑N (N>0) → plain, while content still exists below the
 *     visible editor area (bottom ↓ present), or the cursor was below the
 *     top content row and stays there
 *   - cursor cell disappears from the visible editor area while the editor
 *     still has text below (cursor scrolled out of view)
 *
 * Usage:
 *   node scripts/editor-scroll-capture/analyze.mjs /tmp/editor-scroll-capture
 */
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Minimal virtual terminal (enough for the TUI output stream)
// ---------------------------------------------------------------------------

class VirtualTerminal {
	constructor(cols, rows) {
		this.cols = cols;
		this.rows = rows;
		this.screen = [];
		for (let r = 0; r < rows; r++) this.screen.push(newRow(cols));
		this.row = 0;
		this.col = 0;
		this.wrapPending = false;
		this.savedRow = 0;
		this.savedCol = 0;
		this.scrollTop = 0;
		this.scrollBottom = rows - 1;
		this.reverse = false;
		this.alt = false;
	}

	get rowsCount() {
		return this.rows;
	}

	text() {
		return this.screen.map((row) => row.map((c) => c.ch).join(""));
	}

	cursorCell() {
		return this.screen[this.row][this.col];
	}

	feed(data) {
		let i = 0;
		const s = data;
		while (i < s.length) {
			const ch = s[i];
			if (ch === "\x1b") {
				i = this.consumeEscape(s, i + 1);
			} else if (ch === "\r") {
				this.col = 0;
				this.wrapPending = false;
				i++;
			} else if (ch === "\n") {
				this.wrapPending = false;
				this.lineFeed();
				i++;
			} else if (ch === "\b") {
				this.col = Math.max(0, this.col - 1);
				i++;
			} else if (ch === "\t") {
				this.col = Math.min(this.cols - 1, this.col + 8 - (this.col % 8));
				i++;
			} else if (ch === "\x07" || ch === "\x0b" || ch === "\x0c") {
				if (ch === "\x0b" || ch === "\x0c") this.lineFeed();
				i++;
			} else {
				this.put(ch);
				i++;
			}
		}
	}

	consumeEscape(s, i) {
		// C1 / CSI / OSC / APC / DCS / generic ESC sequences
		if (i >= s.length) return i;
		const c = s[i];
		if (c === "[") return this.consumeCsi(s, i + 1);
		if (c === "]") return this.consumeOsc(s, i + 1);
		if (c === "_" || c === "^" || c === "P" || c === "X") return this.consumeStringTerminated(s, i + 1);
		if (c === "7") {
			this.savedRow = this.row;
			this.savedCol = this.col;
			return i + 1;
		}
		if (c === "8") {
			this.row = this.savedRow;
			this.col = this.savedCol;
			return i + 1;
		}
		if (c === "c") {
			// RIS - full reset
			this.screen = [];
			for (let r = 0; r < this.rows; r++) this.screen.push(newRow(this.cols));
			this.row = 0;
			this.col = 0;
			return i + 1;
		}
		if (c === "D") {
			this.lineFeed();
			return i + 1;
		}
		if (c === "M") {
			this.reverseLineFeed();
			return i + 1;
		}
		if (c === "E") {
			this.col = 0;
			this.lineFeed();
			return i + 1;
		}
		if (c === "=" || c === ">") return i + 1; // keypad modes - ignore
		// bare ESC + printable: treat as literal (ignore)
		return i + 1;
	}

	consumeStringTerminated(s, i) {
		// OSC/APC/DCS: skip until BEL or ST (\x1b\\)
		while (i < s.length) {
			if (s[i] === "\x07") return i + 1;
			if (s[i] === "\x1b" && s[i + 1] === "\\") return i + 2;
			i++;
		}
		return i;
	}

	consumeOsc(s, i) {
		return this.consumeStringTerminated(s, i);
	}

	consumeCsi(s, i) {
		// Parse params up to final byte (0x40-0x7E); ignore intermediates.
		let params = "";
		let final = "";
		let j = i;
		while (j < s.length) {
			const code = s.charCodeAt(j);
			if (code >= 0x40 && code <= 0x7e) {
				final = s[j];
				break;
			}
			if (code >= 0x20 && code <= 0x3f) {
				params += s[j];
				j++;
			} else {
				break;
			}
		}
		if (final === "") return j; // unterminated - ignore rest
		this.applyCsi(params, final);
		return j + 1;
	}

	applyCsi(params, final) {
		this.wrapPending = false;
		const nums = params
			.split(";")
			.map((p) => parseInt(p, 10))
			.map((n) => (Number.isNaN(n) ? 0 : n));
		const n = (idx, def) => (nums[idx] === 0 || nums[idx] === undefined ? def : nums[idx]);
		const isPrivate = params.startsWith("?") || params.startsWith(">") || params.startsWith("<") || params.startsWith("=");
		const p = isPrivate ? params.slice(1) : params;
		const pnums = p
			.split(";")
			.map((x) => parseInt(x, 10))
			.map((x) => (Number.isNaN(x) ? 0 : x));

		switch (final) {
			case "A":
				this.row = Math.max(0, this.row - n(0, 1));
				break;
			case "B":
				this.row = Math.min(this.rows - 1, this.row + n(0, 1));
				break;
			case "C":
				this.col = Math.min(this.cols - 1, this.col + n(0, 1));
				break;
			case "D":
				this.col = Math.max(0, this.col - n(0, 1));
				break;
			case "E":
				this.row = Math.min(this.rows - 1, this.row + n(0, 1));
				this.col = 0;
				break;
			case "F":
				this.row = Math.max(0, this.row - n(0, 1));
				this.col = 0;
				break;
			case "G":
				this.col = Math.max(0, Math.min(this.cols - 1, n(0, 1) - 1));
				break;
			case "d":
				this.row = Math.max(0, Math.min(this.rows - 1, n(0, 1) - 1));
				break;
			case "H":
			case "f":
				this.row = Math.max(0, Math.min(this.rows - 1, n(0, 1) - 1));
				this.col = Math.max(0, Math.min(this.cols - 1, n(1, 1) - 1));
				break;
			case "J":
				this.eraseDisplay(n(0, 0));
				break;
			case "K":
				this.eraseLine(n(0, 0));
				break;
			case "X":
				this.eraseChars(n(0, 1));
				break;
			case "P": {
				const row = this.screen[this.row];
				const cnt = Math.min(n(0, 1), this.cols - this.col);
				row.splice(this.col, cnt);
				while (row.length < this.cols) row.push(newCell());
				break;
			}
			case "@": {
				const row = this.screen[this.row];
				const cnt = Math.min(n(0, 1), this.cols - this.col);
				for (let k = 0; k < cnt; k++) row.splice(this.col, 0, newCell());
				row.length = this.cols;
				break;
			}
			case "S":
				this.scrollUp(n(0, 1));
				break;
			case "T":
				this.scrollDown(n(0, 1));
				break;
			case "r":
				this.scrollTop = Math.max(0, n(0, 1) - 1);
				this.scrollBottom = Math.min(this.rows - 1, n(1, this.rows) - 1);
				this.row = 0;
				this.col = 0;
				break;
			case "s":
				this.savedRow = this.row;
				this.savedCol = this.col;
				break;
			case "u":
				this.row = this.savedRow;
				this.col = this.savedCol;
				break;
			case "m":
				this.applySgr(pnums);
				break;
			case "n":
			case "c":
				// DSR/DA queries: the app writes these; no terminal in this
				// analyzer responds, so nothing to do.
				break;
			default:
				break;
		}
	}

	applySgr(nums) {
		if (nums.length === 0 || nums[0] === 0) {
			this.reverse = false;
			return;
		}
		for (const num of nums) {
			if (num === 7) this.reverse = true;
			else if (num === 27) this.reverse = false;
		}
	}

	put(ch) {
		if (this.row >= this.rows) return;
		if (this.wrapPending) {
			this.wrapPending = false;
			this.col = 0;
			this.lineFeed();
		}
		const cell = this.screen[this.row][this.col];
		cell.ch = ch;
		cell.reverse = this.reverse;
		this.col++;
		if (this.col >= this.cols) {
			this.col = this.cols - 1; // stay at last column, wrap pending
			this.wrapPending = true;
		}
	}

	lineFeed() {
		if (this.row === this.scrollBottom) {
			this.screen.splice(this.scrollTop, 1);
			this.screen.splice(this.scrollBottom, 0, newRow(this.cols));
		} else if (this.row < this.rows - 1) {
			this.row++;
		}
	}

	reverseLineFeed() {
		if (this.row === this.scrollTop) {
			this.screen.splice(this.scrollTop, 0, newRow(this.cols));
			this.screen.splice(this.scrollBottom + 1, 1);
		} else if (this.row > 0) {
			this.row--;
		}
	}

	scrollUp(n) {
		for (let k = 0; k < n; k++) {
			this.screen.splice(this.scrollTop, 1);
			this.screen.splice(this.scrollBottom, 0, newRow(this.cols));
		}
	}

	scrollDown(n) {
		for (let k = 0; k < n; k++) {
			this.screen.splice(this.scrollBottom, 0, newRow(this.cols));
			this.screen.splice(this.scrollTop, 1);
		}
	}

	eraseDisplay(mode) {
		if (mode === 2 || mode === 3) {
			for (let r = 0; r < this.rows; r++) {
				this.screen[r] = newRow(this.cols);
			}
		} else if (mode === 1) {
			for (let r = 0; r <= this.row; r++) {
				const row = this.screen[r];
				const upto = r === this.row ? this.col + 1 : this.cols;
				for (let c = 0; c < upto; c++) row[c] = newCell();
			}
		} else {
			for (let r = this.row; r < this.rows; r++) {
				const row = this.screen[r];
				const from = r === this.row ? this.col : 0;
				for (let c = from; c < this.cols; c++) row[c] = newCell();
			}
		}
	}

	eraseLine(mode) {
		const row = this.screen[this.row];
		if (mode === 2) {
			for (let c = 0; c < this.cols; c++) row[c] = newCell();
		} else if (mode === 1) {
			for (let c = 0; c <= this.col; c++) row[c] = newCell();
		} else {
			for (let c = this.col; c < this.cols; c++) row[c] = newCell();
		}
	}

	eraseChars(n) {
		const row = this.screen[this.row];
		for (let c = this.col; c < Math.min(this.cols, this.col + n); c++) row[c] = newCell();
	}
}

function newCell() {
	return { ch: " ", reverse: false };
}

function newRow(cols) {
	const row = [];
	for (let c = 0; c < cols; c++) row.push(newCell());
	return row;
}

// ---------------------------------------------------------------------------
// Editor state extraction from a screen snapshot
// ---------------------------------------------------------------------------

const BORDER_RE = /^─*─── (↑|↓) (\d+) more ─*$/;

/**
 * Locate the editor box (bottom-most bordered region) and extract:
 *   topIndicator / bottomIndicator, cursor row/col within the editor box,
 *   content rows (visible text).
 */
function extractEditor(screenText) {
	const rows = screenText;
	const lastNonEmpty = (() => {
		for (let r = rows.length - 1; r >= 0; r--) {
			if (rows[r].trim() !== "") return r;
		}
		return -1;
	})();
	if (lastNonEmpty < 0) return null;

	// Bottom border: last non-empty row; may be plain dashes or a ↓ indicator.
	const bottomRow = lastNonEmpty;
	const bottomText = rows[bottomRow].trim();
	const bottomMatch = bottomText.match(BORDER_RE);
	if (!bottomText.includes("─") && !bottomMatch) return null;

	// Walk up from the bottom border to find the top border.
	let topRow = -1;
	for (let r = bottomRow - 1; r >= 0; r--) {
		const t = rows[r].trim();
		if (t.includes("─") && (t.startsWith("─") || t.includes("───"))) {
			topRow = r;
			break;
		}
	}
	if (topRow < 0) return null;

	const topMatch = rows[topRow].trim().match(BORDER_RE);
	const botMatch = bottomText.match(BORDER_RE);

	// Cursor: reverse-video cell within the editor box rows.
	const screen = null; // replaced below by caller for reverse scan
	return {
		topRow,
		bottomRow,
		topIndicator: topMatch ? { dir: topMatch[1], n: parseInt(topMatch[2], 10) } : null,
		bottomIndicator: botMatch ? { dir: botMatch[1], n: parseInt(botMatch[2], 10) } : null,
		content: rows.slice(topRow + 1, bottomRow),
	};
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function readTimeline(dir) {
	const p = path.join(dir, "timeline.jsonl");
	if (!fs.existsSync(p)) return [];
	return fs
		.readFileSync(p, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

function main() {
	const args = process.argv.slice(2);
	const dumpScreen = args.includes("--dump-screen");
	let dumpAt = null;
	const dumpAtArg = args.find((a) => a.startsWith("--dump-at="));
	if (dumpAtArg) dumpAt = parseFloat(dumpAtArg.split("=")[1]);
	const dir = args.find((a) => !a.startsWith("--"));
	if (!dir) {
		console.error("usage: node analyze.mjs <capture-dir> [--dump-screen]");
		process.exit(1);
	}
	const timeline = readTimeline(dir);
	const decoder = new TextDecoder();

	let cols = 100;
	let rows = 30;
	// Determine size from the first full-screen render if possible (fall back to defaults)
	const vt = new VirtualTerminal(cols, rows);
	const states = [];
	let lastAnomaly = null;
	const anomalies = [];
	let pendingInput = "";
	const inputEvents = [];

	// Track editor state over time (sampled after each input and every 50ms of output)
	let lastSampleT = -1;
	let lastInHex = "";

	for (const ev of timeline) {
		if (ev.dir === "in") {
			lastInHex = ev.hex;
			inputEvents.push({ t: ev.t, hex: ev.hex });
		} else {
			const buf = Buffer.from(ev.hex, "hex");
			const text = decoder.decode(buf, { stream: true });
			if (text) vt.feed(text);
			// sample
			const sample = () => {
				const screenText = vt.text();
				const editor = extractEditor(screenText);
				const cursor = findCursorCell(vt, editor);
				const state = {
					t: ev.t,
					input: lastInHex,
					top: editor?.topIndicator ?? null,
					bottom: editor?.bottomIndicator ?? null,
					cursorInEditor: cursor !== null,
					cursorRow: cursor?.row ?? -1,
					cursorCol: cursor?.col ?? -1,
					editorRows: editor ? editor.bottomRow - editor.topRow - 1 : 0,
				};
				states.push(state);
				detectAnomaly(state, states, anomalies);
			};
			if (lastSampleT < 0 || ev.t - lastSampleT >= 50) {
				sample();
				lastSampleT = ev.t;
			}
		}
	}
	// flush any partial UTF-8 sequence, then final sample
	vt.feed(decoder.decode());
	{
		const screenText = vt.text();
		const editor = extractEditor(screenText);
		const cursor = findCursorCell(vt, editor);
		states.push({
			t: timeline.at(-1)?.t ?? 0,
			input: lastInHex,
			top: editor?.topIndicator ?? null,
			bottom: editor?.bottomIndicator ?? null,
			cursorInEditor: cursor !== null,
			cursorRow: cursor?.row ?? -1,
			cursorCol: cursor?.col ?? -1,
			editorRows: editor ? editor.bottomRow - editor.topRow - 1 : 0,
		});
	}

	if (dumpScreen) {
		console.log("==== final screen dump ====");
		const rows = vt.text();
		rows.forEach((r, i) => console.log(String(i).padStart(3) + "|" + r.replace(/\s+$/, "") + "|"));
		console.log("==========================");
	}

	if (dumpAt !== null) {
		const target = states.find((s) => s.t >= dumpAt);
		if (target) {
			console.log(`==== screen dump at t=${target.t}ms ====`);
			// Replay up to that timestamp
			const vt2 = new VirtualTerminal(cols, rows);
			const dec2 = new TextDecoder();
			for (const ev of timeline) {
				if (ev.dir === "out" && ev.t <= target.t) {
					vt2.feed(dec2.decode(Buffer.from(ev.hex, "hex"), { stream: true }));
				}
			}
			vt2.feed(dec2.decode());
			vt2.text().forEach((r, i) => console.log(String(i).padStart(3) + "|" + r.replace(/\s+$/, "") + "|"));
			console.log("==========================");
		}
	}


	// ---- report ----
	console.log(`timeline events: ${timeline.length} (in=${inputEvents.length})`);
	console.log(`samples: ${states.length}`);
	console.log(`anomalies detected: ${anomalies.length}`);
	console.log("");
	if (anomalies.length === 0) {
		console.log("No scroll-jump anomalies detected in this capture.");
		console.log("Sample editor states (every few frames):");
		for (const s of states.filter((_, i) => i % Math.max(1, Math.floor(states.length / 8)) === 0)) {
			console.log(`  t=${String(s.t).padEnd(7)} ${describeState(s)}`);
		}
		return;
	}
	for (const a of anomalies) {
		console.log("=".repeat(70));
		console.log(`ANOMALY at t=${a.t}ms  (after input: ${describeInput(a.input)})`);
		console.log(`  ${a.reason}`);
		console.log(`  before: ${describeState(a.before)}`);
		console.log(`  after : ${describeState(a.after)}`);
	}
}

function findCursorCell(vt, editor) {
	if (!editor) return null;
	for (let r = editor.topRow + 1; r < editor.bottomRow; r++) {
		const row = vt.screen[r];
		for (let c = 0; c < row.length; c++) {
			if (row[c].reverse) return { row: r, col: c };
		}
	}
	return null;
}

function describeState(s) {
	if (!s) return "n/a";
	const top = s.top ? `${s.top.dir}${s.top.n}` : "top(plain)";
	const bottom = s.bottom ? `${s.bottom.dir}${s.bottom.n}` : "bottom(plain)";
	return `top=${top} bottom=${bottom} cursor=${s.cursorInEditor ? `r${s.cursorRow}c${s.cursorCol}` : "LOST"} editorRows=${s.editorRows}`;
}

function describeInput(hex) {
	if (!hex) return "(none)";
	const b = Buffer.from(hex, "hex");
	const s = b.toString("latin1");
	if (s === "\x1b[A") return "Up";
	if (s === "\x1b[B") return "Down";
	if (s === "\x1b[15~") return "F5(setText)";
	if (s === "\x1b[17~") return "F6(history)";
	if (s === "\x1b[18~") return "F7(focus)";
	if (s === "\x1b[19~") return "F8(save/restore)";
	if (s === "\x1b[20~") return "F9(submit)";
	if (s === "\r") return "Enter";
	if (s.length > 1) return JSON.stringify(s.slice(0, 30));
	return s;
}

function detectAnomaly(state, states, anomalies) {
	if (states.length < 2) return;
	const prev = states[states.length - 2];
	// Only compare states separated by an input event boundary (or new frames)
	// Jump to top: top indicator was ↑N (N>0) and becomes plain/absent,
	// while the editor still has content below (bottom ↓ present) — or the
	// cursor is below the first editor content row.
	const wasScrolled = prev.top && prev.top.dir === "↑" && prev.top.n > 0;
	const nowTop = !state.top || state.top.dir !== "↑" || state.top.n === 0;
	if (wasScrolled && nowTop) {
		const hasContentBelow = state.bottom && state.bottom.dir === "↓";
		const cursorBelowTop = state.cursorInEditor && state.cursorRow > (state.editorRows > 0 ? 0 : 0);
		if (hasContentBelow || cursorBelowTop) {
			anomalies.push({
				t: state.t,
				input: state.input,
				reason: "editor scroll jumped to top (top indicator ↑N → plain) while content/cursor remained below",
				before: prev,
				after: state,
			});
			return;
		}
	}
	// Cursor lost: was in editor, now gone, while bottom still shows content below
	if (prev.cursorInEditor && !state.cursorInEditor && state.bottom && state.bottom.dir === "↓") {
		anomalies.push({
			t: state.t,
			input: state.input,
			reason: "editor cursor cell vanished from view while lines remain below (cursor scrolled out)",
			before: prev,
			after: state,
		});
	}
}

main();
