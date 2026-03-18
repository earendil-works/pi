/**
 * Modal Editor - Vim-like modal editing for pi
 *
 * A full vim-mode extension providing Normal, Insert, Visual, and Command-line
 * modes with motions, operators, counts, text objects, and an ex command line.
 *
 * Usage: pi --extension .pi/extensions/modal-editor.ts
 *
 * Modes:
 *   INSERT  - Default text entry (like standard editor)
 *   NORMAL  - Navigation and operators (Escape from insert)
 *   VISUAL  - Character-wise selection (v from normal)
 *   COMMAND - Ex command line (: from normal)
 *
 * Normal mode keys:
 *   Movement:  h j k l  w b e  0 $ ^  gg G  f{c} F{c}
 *   Insert:    i I a A o O
 *   Operators: d{motion} c{motion} y{motion}  dd cc yy  D C
 *   Actions:   x X p P u . J
 *   Visual:    v
 *   Command:   :{cmd}
 *   Counts:    {n}{motion|operator}
 *
 * Visual mode keys:
 *   Movement same as normal, plus:
 *   d/x - delete selection
 *   y   - yank selection
 *   c   - change selection
 *
 * Ex commands:
 *   :w     - submit (equivalent to Enter)
 *   :q     - abort / interrupt
 *   :wq    - submit
 *   :help  - show help
 *   :{n}   - go to line n
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ─── Types ───────────────────────────────────────────────────────────────────

type Mode = "normal" | "insert" | "visual" | "command";

/** Pending operator waiting for a motion */
type PendingOp = "d" | "c" | "y" | null;

/** A range in the buffer: [startLine, startCol, endLine, endCol] inclusive */
type BufferRange = [number, number, number, number];

// ─── Escape sequences for terminal keybindings ──────────────────────────────

const SEQ = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	home: "\x01", // ctrl+a = line start
	end: "\x05", // ctrl+e = line end
	delete: "\x1b[3~",
	backspace: "\x7f",
	wordLeft: "\x1bb", // alt+b
	wordRight: "\x1bf", // alt+f
	deleteToEnd: "\x0b", // ctrl+k
	deleteToStart: "\x15", // ctrl+u
	deleteWordBack: "\x17", // ctrl+w
} as const;

// ─── Modal Editor ────────────────────────────────────────────────────────────

class ModalEditor extends CustomEditor {
	private mode: Mode = "insert";
	private pendingOp: PendingOp = null;
	private count: number = 0;
	private statusMessage: string = "";
	private statusTimeout: ReturnType<typeof setTimeout> | null = null;

	// Command-line mode state
	private cmdBuffer: string = "";
	private cmdCursor: number = 0;

	// Visual mode anchor position
	private visualAnchorLine: number = 0;
	private visualAnchorCol: number = 0;

	// Yank/delete register (single register, like vim's unnamed register)
	private register: string = "";
	private registerLinewise: boolean = false;

	// Repeat support: last editing command
	private lastEditKeys: string[] = [];
	private recordingEdit: boolean = false;
	private replayingEdit: boolean = false;

	// Pending find character: f/F/t/T
	private pendingFind: "f" | "F" | "t" | "T" | null = null;
	private lastFind: { type: "f" | "F" | "t" | "T"; char: string } | null = null;

	// ─── Input dispatcher ─────────────────────────────────────────────────

	handleInput(data: string): void {
		switch (this.mode) {
			case "insert":
				this.handleInsertMode(data);
				break;
			case "normal":
				this.handleNormalMode(data);
				break;
			case "visual":
				this.handleVisualMode(data);
				break;
			case "command":
				this.handleCommandMode(data);
				break;
		}
	}

	// ─── Insert mode ──────────────────────────────────────────────────────

	private handleInsertMode(data: string): void {
		if (matchesKey(data, "escape")) {
			this.setMode("normal");
			// Move cursor back one if not at start (vim behavior)
			const cursor = this.getCursor();
			const line = this.getLines()[cursor.line] ?? "";
			if (cursor.col > 0 && cursor.col >= line.length) {
				super.handleInput(SEQ.left);
			}
			if (this.recordingEdit) {
				this.recordingEdit = false;
			}
			return;
		}

		// Record keystrokes for repeat (.)
		if (this.recordingEdit && !this.replayingEdit) {
			this.lastEditKeys.push(data);
		}

		super.handleInput(data);
	}

	// ─── Normal mode ──────────────────────────────────────────────────────

	private handleNormalMode(data: string): void {
		// Handle pending find character
		if (this.pendingFind) {
			const findType = this.pendingFind;
			this.pendingFind = null;
			if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.lastFind = { type: findType, char: data };
				this.execFind(findType, data, this.getCount());
			}
			return;
		}

		// Escape: clear pending state or pass through to abort agent
		if (matchesKey(data, "escape")) {
			if (this.pendingOp || this.count > 0) {
				this.pendingOp = null;
				this.count = 0;
				this.setStatus("");
				return;
			}
			super.handleInput(data); // abort agent
			return;
		}

		// Count prefix (digits, but "0" is line-start when no count pending)
		if (data >= "1" && data <= "9") {
			this.count = this.count * 10 + Number(data);
			this.setStatus(this.descPending());
			return;
		}
		if (data === "0" && this.count > 0) {
			this.count = this.count * 10;
			this.setStatus(this.descPending());
			return;
		}

		const n = this.getCount();

		// ── Operators ─────────────────────────────────────────────────────

		// Double operator = line-wise (dd, cc, yy)
		if (this.pendingOp && data === this.pendingOp) {
			this.execLineOp(this.pendingOp, n);
			this.clearPending();
			return;
		}

		if ((data === "d" || data === "c" || data === "y") && !this.pendingOp) {
			this.pendingOp = data;
			this.setStatus(this.descPending());
			return;
		}

		// ── Motions (also used as operator targets) ───────────────────────

		// Basic motions
		if (this.tryMotion(data, n)) return;

		// ── Insert-entering keys ──────────────────────────────────────────

		if (data === "i") {
			this.startEdit();
			this.setMode("insert");
			return;
		}
		if (data === "I") {
			this.startEdit();
			this.firstNonBlank();
			this.setMode("insert");
			return;
		}
		if (data === "a") {
			this.startEdit();
			const cursor = this.getCursor();
			const line = this.getLines()[cursor.line] ?? "";
			if (cursor.col < line.length) {
				super.handleInput(SEQ.right);
			}
			this.setMode("insert");
			return;
		}
		if (data === "A") {
			this.startEdit();
			super.handleInput(SEQ.end);
			this.setMode("insert");
			return;
		}
		if (data === "o") {
			this.startEdit();
			super.handleInput(SEQ.end);
			super.handleInput("\n");
			this.setMode("insert");
			return;
		}
		if (data === "O") {
			this.startEdit();
			super.handleInput(SEQ.home);
			super.handleInput("\n");
			super.handleInput(SEQ.up);
			this.setMode("insert");
			return;
		}

		// ── Standalone actions ────────────────────────────────────────────

		if (data === "x") {
			for (let i = 0; i < n; i++) {
				const cursor = this.getCursor();
				const line = this.getLines()[cursor.line] ?? "";
				if (cursor.col < line.length) {
					// Grab char for register before deleting
					this.register = line[cursor.col] ?? "";
					this.registerLinewise = false;
					super.handleInput(SEQ.delete);
				}
			}
			this.clampCursorToLine();
			return;
		}

		if (data === "X") {
			for (let i = 0; i < n; i++) {
				const cursor = this.getCursor();
				if (cursor.col > 0) {
					this.register = (this.getLines()[cursor.line] ?? "")[cursor.col - 1] ?? "";
					this.registerLinewise = false;
					super.handleInput(SEQ.backspace);
				}
			}
			return;
		}

		if (data === "D") {
			// Delete to end of line
			const cursor = this.getCursor();
			const line = this.getLines()[cursor.line] ?? "";
			this.register = line.slice(cursor.col);
			this.registerLinewise = false;
			super.handleInput(SEQ.deleteToEnd);
			this.clampCursorToLine();
			return;
		}

		if (data === "C") {
			// Change to end of line
			this.startEdit();
			const cursor = this.getCursor();
			const line = this.getLines()[cursor.line] ?? "";
			this.register = line.slice(cursor.col);
			this.registerLinewise = false;
			super.handleInput(SEQ.deleteToEnd);
			this.setMode("insert");
			return;
		}

		if (data === "J") {
			// Join lines
			const cursor = this.getCursor();
			const lines = this.getLines();
			if (cursor.line < lines.length - 1) {
				super.handleInput(SEQ.end);
				super.handleInput(SEQ.delete); // delete newline
				// Ensure space between joined content
				const newCursor = this.getCursor();
				const newLine = this.getLines()[newCursor.line] ?? "";
				if (newCursor.col > 0 && newCursor.col < newLine.length && newLine[newCursor.col] !== " " && newLine[newCursor.col - 1] !== " ") {
					super.handleInput(" ");
				}
			}
			return;
		}

		if (data === "p") {
			this.paste(false, n);
			return;
		}
		if (data === "P") {
			this.paste(true, n);
			return;
		}

		if (data === "u") {
			// Undo: ctrl+z
			super.handleInput("\x1a");
			return;
		}

		if (data === ".") {
			this.repeatLastEdit();
			return;
		}

		if (data === ";") {
			// Repeat last f/F/t/T
			if (this.lastFind) {
				this.execFind(this.lastFind.type, this.lastFind.char, n);
			}
			return;
		}
		if (data === ",") {
			// Reverse repeat last f/F/t/T
			if (this.lastFind) {
				const rev: Record<string, "f" | "F" | "t" | "T"> = { f: "F", F: "f", t: "T", T: "t" };
				this.execFind(rev[this.lastFind.type]!, this.lastFind.char, n);
			}
			return;
		}

		// ── Mode switches ─────────────────────────────────────────────────

		if (data === "v") {
			const cursor = this.getCursor();
			this.visualAnchorLine = cursor.line;
			this.visualAnchorCol = cursor.col;
			this.setMode("visual");
			return;
		}

		if (data === ":") {
			this.cmdBuffer = "";
			this.cmdCursor = 0;
			this.setMode("command");
			return;
		}

		// "0" at line start
		if (data === "0") {
			if (this.pendingOp) {
				this.execOpToHome(this.pendingOp);
				this.clearPending();
			} else {
				super.handleInput(SEQ.home);
			}
			return;
		}

		// Pass control sequences through (ctrl+c, ctrl+d, etc.)
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			// Unknown normal mode key -- ignore printable chars
			return;
		}
		super.handleInput(data);
	}

	// ─── Motion execution ─────────────────────────────────────────────────

	private tryMotion(data: string, n: number): boolean {
		// h/l/j/k  basic movement
		if (data === "h") return this.doMotion("h", n);
		if (data === "l") return this.doMotion("l", n);
		if (data === "j") return this.doMotion("j", n);
		if (data === "k") return this.doMotion("k", n);

		// w/b/e  word movement
		if (data === "w") return this.doMotion("w", n);
		if (data === "b") return this.doMotion("b", n);
		if (data === "e") return this.doMotion("e", n);

		// $ ^ line end/first-non-blank
		if (data === "$") return this.doMotion("$", n);
		if (data === "^") return this.doMotion("^", n);

		// gg / G  buffer start/end
		if (data === "g") {
			// Wait for second g
			if (this.pendingOp === null && this.count === 0) {
				// Simple gg check: we set a marker
				this.setStatus("g");
				this.pendingOp = null;
				// Use a trick: store 'g' as a pseudo-pending for next keypress
				const origHandler = this.handleNormalMode.bind(this);
				const self = this;
				// Override next call
				(this as any)._pendingG = true;
				return true;
			}
			// If already pending g, go to line
			return false;
		}

		// Second g of gg
		if ((this as any)._pendingG && data === "g") {
			delete (this as any)._pendingG;
			if (this.pendingOp) {
				// Operator to start of buffer
				this.execOpToPos(this.pendingOp, 0, 0);
				this.clearPending();
			} else {
				// Go to top
				const lines = this.getLines();
				const cursor = this.getCursor();
				for (let i = cursor.line; i > 0; i--) {
					super.handleInput(SEQ.up);
				}
				super.handleInput(SEQ.home);
			}
			this.setStatus("");
			return true;
		}
		if ((this as any)._pendingG) {
			// g followed by non-g: cancel
			delete (this as any)._pendingG;
			this.setStatus("");
			return false;
		}

		if (data === "G") {
			if (this.pendingOp) {
				const lines = this.getLines();
				const lastLine = lines[lines.length - 1] ?? "";
				this.execOpToPos(this.pendingOp, lines.length - 1, lastLine.length);
				this.clearPending();
			} else {
				const lines = this.getLines();
				const cursor = this.getCursor();
				for (let i = cursor.line; i < lines.length - 1; i++) {
					super.handleInput(SEQ.down);
				}
				super.handleInput(SEQ.end);
			}
			return true;
		}

		// f/F/t/T  find char
		if (data === "f" || data === "F" || data === "t" || data === "T") {
			this.pendingFind = data;
			this.setStatus(data);
			return true;
		}

		return false;
	}

	/**
	 * Execute a motion, applying any pending operator if present.
	 * Returns true if the key was handled.
	 */
	private doMotion(motion: string, n: number): boolean {
		if (this.pendingOp) {
			this.execOpWithMotion(this.pendingOp, motion, n);
			this.clearPending();
			return true;
		}

		// Pure movement
		for (let i = 0; i < n; i++) {
			switch (motion) {
				case "h":
					super.handleInput(SEQ.left);
					break;
				case "l":
					super.handleInput(SEQ.right);
					break;
				case "j":
					super.handleInput(SEQ.down);
					break;
				case "k":
					super.handleInput(SEQ.up);
					break;
				case "w":
					super.handleInput(SEQ.wordRight);
					break;
				case "b":
					super.handleInput(SEQ.wordLeft);
					break;
				case "e":
					this.moveToEndOfWord();
					break;
				case "$":
					super.handleInput(SEQ.end);
					break;
				case "^":
					this.firstNonBlank();
					break;
			}
		}
		return true;
	}

	// ─── Operator execution ───────────────────────────────────────────────

	/** Execute operator + motion. Captures text, deletes for d/c, enters insert for c. */
	private execOpWithMotion(op: PendingOp, motion: string, n: number): void {
		if (!op) return;
		const before = this.getCursor();

		// Perform motion to find target position
		for (let i = 0; i < n; i++) {
			switch (motion) {
				case "h":
					super.handleInput(SEQ.left);
					break;
				case "l":
					super.handleInput(SEQ.right);
					break;
				case "j":
					super.handleInput(SEQ.down);
					break;
				case "k":
					super.handleInput(SEQ.up);
					break;
				case "w":
					super.handleInput(SEQ.wordRight);
					break;
				case "b":
					super.handleInput(SEQ.wordLeft);
					break;
				case "e":
					this.moveToEndOfWord();
					break;
				case "$":
					super.handleInput(SEQ.end);
					break;
				case "^":
					this.firstNonBlank();
					break;
			}
		}

		const after = this.getCursor();

		// Determine range
		const [startLine, startCol, endLine, endCol] = this.orderPositions(
			before.line,
			before.col,
			after.line,
			after.col,
		);

		// Extract text in range
		const text = this.extractRange(startLine, startCol, endLine, endCol);
		this.register = text;
		this.registerLinewise = false;

		if (op === "y") {
			// Yank only: restore cursor to before position
			this.goToPos(before.line, before.col);
			this.setStatus(`${text.length} chars yanked`);
			return;
		}

		// For d/c: navigate to start and delete to end
		this.goToPos(startLine, startCol);
		this.deleteRange(startLine, startCol, endLine, endCol);

		if (op === "c") {
			this.startEdit();
			this.setMode("insert");
		} else {
			this.clampCursorToLine();
		}
	}

	/** Line-wise operator: dd, cc, yy */
	private execLineOp(op: PendingOp, n: number): void {
		if (!op) return;
		const cursor = this.getCursor();
		const lines = this.getLines();
		const startLine = cursor.line;
		const endLine = Math.min(startLine + n - 1, lines.length - 1);

		// Capture lines
		const captured = lines.slice(startLine, endLine + 1).join("\n");
		this.register = captured;
		this.registerLinewise = true;

		if (op === "y") {
			this.setStatus(`${endLine - startLine + 1} lines yanked`);
			return;
		}

		// Delete the lines
		this.goToPos(startLine, 0);
		for (let i = startLine; i <= endLine; i++) {
			super.handleInput(SEQ.home);
			super.handleInput(SEQ.deleteToEnd);
			// Delete the newline to join with next, or backspace to join with previous
			if (startLine < lines.length - 1) {
				super.handleInput(SEQ.delete); // delete newline char
			} else if (startLine > 0) {
				super.handleInput(SEQ.backspace);
			}
		}

		if (op === "c") {
			// Open a new line for editing
			if (lines.length > 1) {
				super.handleInput(SEQ.home);
				super.handleInput("\n");
				super.handleInput(SEQ.up);
			}
			this.startEdit();
			this.setMode("insert");
		}
	}

	private execOpToHome(op: PendingOp): void {
		if (!op) return;
		const before = this.getCursor();
		const startCol = 0;
		const text = this.extractRange(before.line, startCol, before.line, before.col);
		this.register = text;
		this.registerLinewise = false;

		if (op === "y") {
			this.setStatus(`${text.length} chars yanked`);
			return;
		}

		super.handleInput(SEQ.deleteToStart);
		if (op === "c") {
			this.startEdit();
			this.setMode("insert");
		}
	}

	private execOpToPos(op: PendingOp, targetLine: number, targetCol: number): void {
		if (!op) return;
		const before = this.getCursor();
		const [sl, sc, el, ec] = this.orderPositions(before.line, before.col, targetLine, targetCol);
		const text = this.extractRange(sl, sc, el, ec);
		this.register = text;
		this.registerLinewise = false;

		if (op === "y") {
			this.goToPos(before.line, before.col);
			this.setStatus(`${text.length} chars yanked`);
			return;
		}

		this.goToPos(sl, sc);
		this.deleteRange(sl, sc, el, ec);
		if (op === "c") {
			this.startEdit();
			this.setMode("insert");
		}
	}

	// ─── Visual mode ──────────────────────────────────────────────────────

	private handleVisualMode(data: string): void {
		if (matchesKey(data, "escape") || data === "v") {
			this.setMode("normal");
			return;
		}

		const n = 1;

		// Movement in visual mode
		if (data === "h") {
			super.handleInput(SEQ.left);
			return;
		}
		if (data === "l") {
			super.handleInput(SEQ.right);
			return;
		}
		if (data === "j") {
			super.handleInput(SEQ.down);
			return;
		}
		if (data === "k") {
			super.handleInput(SEQ.up);
			return;
		}
		if (data === "w") {
			super.handleInput(SEQ.wordRight);
			return;
		}
		if (data === "b") {
			super.handleInput(SEQ.wordLeft);
			return;
		}
		if (data === "$") {
			super.handleInput(SEQ.end);
			return;
		}
		if (data === "0") {
			super.handleInput(SEQ.home);
			return;
		}
		if (data === "^") {
			this.firstNonBlank();
			return;
		}

		// Operators on visual selection
		if (data === "d" || data === "x") {
			this.visualOp("d");
			return;
		}
		if (data === "y") {
			this.visualOp("y");
			return;
		}
		if (data === "c") {
			this.visualOp("c");
			return;
		}

		// Unknown key in visual - ignore printable
		if (data.length === 1 && data.charCodeAt(0) >= 32) return;
		super.handleInput(data);
	}

	private visualOp(op: "d" | "y" | "c"): void {
		const cursor = this.getCursor();
		const [sl, sc, el, ec] = this.orderPositions(
			this.visualAnchorLine,
			this.visualAnchorCol,
			cursor.line,
			cursor.col,
		);

		const text = this.extractRange(sl, sc, el, ec + 1); // inclusive end
		this.register = text;
		this.registerLinewise = false;

		if (op === "y") {
			this.setMode("normal");
			this.goToPos(sl, sc);
			this.setStatus(`${text.length} chars yanked`);
			return;
		}

		this.goToPos(sl, sc);
		this.deleteRange(sl, sc, el, ec + 1); // inclusive

		if (op === "c") {
			this.startEdit();
			this.setMode("insert");
		} else {
			this.setMode("normal");
			this.clampCursorToLine();
		}
	}

	// ─── Command-line mode ────────────────────────────────────────────────

	private handleCommandMode(data: string): void {
		if (matchesKey(data, "escape")) {
			this.setMode("normal");
			return;
		}

		if (matchesKey(data, "return") || data === "\r" || data === "\n") {
			this.execCommand(this.cmdBuffer.trim());
			this.setMode("normal");
			return;
		}

		if (matchesKey(data, "backspace") || data === "\x7f") {
			if (this.cmdBuffer.length > 0) {
				this.cmdBuffer = this.cmdBuffer.slice(0, -1);
				this.cmdCursor = this.cmdBuffer.length;
			} else {
				this.setMode("normal");
			}
			return;
		}

		// Printable character
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.cmdBuffer += data;
			this.cmdCursor = this.cmdBuffer.length;
			return;
		}
	}

	private execCommand(cmd: string): void {
		if (!cmd) return;

		// :{n} - go to line
		const lineNum = Number(cmd);
		if (!Number.isNaN(lineNum) && lineNum > 0) {
			const lines = this.getLines();
			const target = Math.min(lineNum - 1, lines.length - 1);
			this.goToPos(target, 0);
			this.setStatus(`Line ${target + 1}`);
			return;
		}

		switch (cmd) {
			case "w":
			case "wq":
				// Submit
				super.handleInput("\r");
				break;
			case "q":
			case "q!":
				// Abort/interrupt
				super.handleInput("\x1b"); // escape to abort
				break;
			case "help":
				this.setStatus("hjkl:move i/a:insert d/c/y:ops v:visual :{n}:goto :w:submit :q:quit");
				break;
			default:
				this.setStatus(`Unknown command: ${cmd}`);
				break;
		}
	}

	// ─── Find character (f/F/t/T) ─────────────────────────────────────────

	private execFind(type: "f" | "F" | "t" | "T", char: string, n: number): void {
		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		const forward = type === "f" || type === "t";
		const till = type === "t" || type === "T";
		let found = -1;
		let count = 0;

		if (forward) {
			for (let i = cursor.col + 1; i < line.length; i++) {
				if (line[i] === char) {
					count++;
					if (count === n) {
						found = till ? i - 1 : i;
						break;
					}
				}
			}
		} else {
			for (let i = cursor.col - 1; i >= 0; i--) {
				if (line[i] === char) {
					count++;
					if (count === n) {
						found = till ? i + 1 : i;
						break;
					}
				}
			}
		}

		if (found >= 0 && found !== cursor.col) {
			if (this.pendingOp) {
				const [sl, sc, el, ec] = this.orderPositions(cursor.line, cursor.col, cursor.line, found);
				const text = this.extractRange(sl, sc, el, ec + 1);
				this.register = text;
				this.registerLinewise = false;

				if (this.pendingOp === "y") {
					this.setStatus(`${text.length} chars yanked`);
				} else {
					this.goToPos(sl, sc);
					this.deleteRange(sl, sc, el, ec + 1);
					if (this.pendingOp === "c") {
						this.startEdit();
						this.setMode("insert");
					}
				}
				this.clearPending();
			} else {
				// Just move cursor
				if (found > cursor.col) {
					for (let i = cursor.col; i < found; i++) super.handleInput(SEQ.right);
				} else {
					for (let i = cursor.col; i > found; i--) super.handleInput(SEQ.left);
				}
			}
		}
	}

	// ─── Paste ────────────────────────────────────────────────────────────

	private paste(before: boolean, n: number): void {
		if (!this.register) return;

		for (let i = 0; i < n; i++) {
			if (this.registerLinewise) {
				if (before) {
					super.handleInput(SEQ.home);
					super.handleInput(this.register + "\n");
					super.handleInput(SEQ.up);
				} else {
					super.handleInput(SEQ.end);
					super.handleInput("\n" + this.register);
				}
			} else {
				if (!before) {
					// Move right first (paste after cursor)
					const cursor = this.getCursor();
					const line = this.getLines()[cursor.line] ?? "";
					if (cursor.col < line.length) {
						super.handleInput(SEQ.right);
					}
				}
				// Insert register text character by character to handle multi-line
				for (const ch of this.register) {
					if (ch === "\n") {
						super.handleInput("\n");
					} else {
						super.handleInput(ch);
					}
				}
			}
		}
	}

	// ─── Repeat (.) ───────────────────────────────────────────────────────

	private startEdit(): void {
		if (!this.replayingEdit) {
			this.lastEditKeys = [];
			this.recordingEdit = true;
		}
	}

	private repeatLastEdit(): void {
		if (this.lastEditKeys.length === 0) return;
		this.replayingEdit = true;
		for (const key of this.lastEditKeys) {
			this.handleInsertMode(key);
		}
		this.replayingEdit = false;
		this.setMode("normal");
	}

	// ─── Helpers ──────────────────────────────────────────────────────────

	private setMode(mode: Mode): void {
		this.mode = mode;
		this.pendingOp = null;
		this.count = 0;
		this.pendingFind = null;
		delete (this as any)._pendingG;
		if (mode === "normal") this.setStatus("");
		if (mode === "command") this.setStatus(":");
	}

	private getCount(): number {
		return this.count > 0 ? this.count : 1;
	}

	private clearPending(): void {
		this.pendingOp = null;
		this.count = 0;
		this.setStatus("");
	}

	private descPending(): string {
		let s = "";
		if (this.count > 0) s += this.count;
		if (this.pendingOp) s += this.pendingOp;
		return s;
	}

	private setStatus(msg: string): void {
		if (this.statusTimeout) {
			clearTimeout(this.statusTimeout);
			this.statusTimeout = null;
		}
		this.statusMessage = msg;
		if (msg && this.mode !== "command") {
			this.statusTimeout = setTimeout(() => {
				this.statusMessage = "";
			}, 3000);
		}
	}

	/** Navigate cursor to an absolute position using arrow keys */
	private goToPos(targetLine: number, targetCol: number): void {
		const cursor = this.getCursor();
		// Move to correct line
		if (targetLine < cursor.line) {
			for (let i = cursor.line; i > targetLine; i--) super.handleInput(SEQ.up);
		} else {
			for (let i = cursor.line; i < targetLine; i++) super.handleInput(SEQ.down);
		}
		// Move to start of line first, then to target col
		super.handleInput(SEQ.home);
		for (let i = 0; i < targetCol; i++) super.handleInput(SEQ.right);
	}

	/** Move cursor to first non-blank character on current line */
	private firstNonBlank(): void {
		super.handleInput(SEQ.home);
		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		for (let i = 0; i < line.length; i++) {
			if (line[i] !== " " && line[i] !== "\t") break;
			super.handleInput(SEQ.right);
		}
	}

	/** Move to end of current word */
	private moveToEndOfWord(): void {
		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		let col = cursor.col;

		// Skip current word chars
		if (col < line.length) col++;
		// Skip whitespace
		while (col < line.length && /\s/.test(line[col]!)) col++;
		// Move to end of word
		while (col < line.length - 1 && !/\s/.test(line[col + 1]!)) col++;

		// Move cursor
		const delta = col - cursor.col;
		for (let i = 0; i < delta; i++) super.handleInput(SEQ.right);
	}

	/** Ensure cursor is not past end of line (vim normal mode behavior) */
	private clampCursorToLine(): void {
		const cursor = this.getCursor();
		const line = this.getLines()[cursor.line] ?? "";
		if (line.length > 0 && cursor.col >= line.length) {
			super.handleInput(SEQ.left);
		}
	}

	/** Order two positions so start <= end */
	private orderPositions(
		l1: number,
		c1: number,
		l2: number,
		c2: number,
	): BufferRange {
		if (l1 < l2 || (l1 === l2 && c1 <= c2)) {
			return [l1, c1, l2, c2];
		}
		return [l2, c2, l1, c1];
	}

	/** Extract text from startLine:startCol to endLine:endCol (exclusive end col) */
	private extractRange(sl: number, sc: number, el: number, ec: number): string {
		const lines = this.getLines();
		if (sl === el) {
			return (lines[sl] ?? "").slice(sc, ec);
		}
		const parts: string[] = [];
		parts.push((lines[sl] ?? "").slice(sc));
		for (let i = sl + 1; i < el; i++) {
			parts.push(lines[i] ?? "");
		}
		parts.push((lines[el] ?? "").slice(0, ec));
		return parts.join("\n");
	}

	/** Delete text in range by selecting and deleting char by char */
	private deleteRange(sl: number, sc: number, el: number, ec: number): void {
		// Calculate total characters to delete
		const lines = this.getLines();
		let total = 0;
		if (sl === el) {
			total = ec - sc;
		} else {
			total = (lines[sl] ?? "").length - sc; // rest of first line
			total += 1; // newline
			for (let i = sl + 1; i < el; i++) {
				total += (lines[i] ?? "").length + 1; // line + newline
			}
			total += ec; // beginning of last line
		}

		for (let i = 0; i < total; i++) {
			super.handleInput(SEQ.delete);
		}
	}

	// ─── Render ───────────────────────────────────────────────────────────

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		// Build mode indicator
		let modeLabel: string;
		switch (this.mode) {
			case "normal":
				modeLabel = " NORMAL ";
				break;
			case "insert":
				modeLabel = " INSERT ";
				break;
			case "visual":
				modeLabel = " VISUAL ";
				break;
			case "command":
				modeLabel = ` :${this.cmdBuffer} `;
				break;
		}

		// Add status message or pending info
		let rightLabel = "";
		if (this.statusMessage && this.mode !== "command") {
			rightLabel = ` ${this.statusMessage} `;
		}

		// Cursor position
		const cursor = this.getCursor();
		const posLabel = ` ${cursor.line + 1}:${cursor.col + 1} `;

		const last = lines.length - 1;
		const lastLine = lines[last]!;
		const lastWidth = visibleWidth(lastLine);

		// Compose: [mode] ... [status] [pos]
		const totalLabelWidth = visibleWidth(modeLabel) + visibleWidth(rightLabel) + visibleWidth(posLabel);
		if (lastWidth >= totalLabelWidth) {
			lines[last] =
				truncateToWidth(lastLine, visibleWidth(modeLabel), "") +
				modeLabel +
				truncateToWidth(
					lastLine.slice(visibleWidth(modeLabel) + modeLabel.length),
					width - totalLabelWidth,
					"",
				).padEnd(width - totalLabelWidth) +
				rightLabel +
				posLabel;

			// Simpler approach: just replace the bottom border line
			const fill = width - visibleWidth(modeLabel) - visibleWidth(rightLabel) - visibleWidth(posLabel);
			if (fill >= 0) {
				lines[last] = modeLabel + "─".repeat(fill) + rightLabel + posLabel;
			} else {
				lines[last] = truncateToWidth(lastLine, width - visibleWidth(modeLabel), "") + modeLabel;
			}
		}

		return lines;
	}
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb));
	});
}
