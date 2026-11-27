// The terminal screen the Terminals view shows (screen.ts): libghostty-vt (ghostty.ts, its WebAssembly loaded when a
// screen mounts, then cached by the browser) parses the terminal's output, and the screen draws its rows into the page
// as text (ghostty-rows.ts), so selecting and copying are the browser's own. Ported from p2's Terminal.tsx without its
// tabs, panel and host channel (the view and terminal-link.ts have those). Its JavaScript is in every page's plugin
// bundle (plugins have no `import()`, +13.4 KB gzip); only the WebAssembly (846 KB) waits for a screen.
//
// Output is parsed in slices within a time budget per animation frame and drawn in the same frame, so a flood (`find
// /`) still draws; what was drawn is told to the link, whose server sends only a window ahead of it. The kept output
// replayed at a (re)connection is drawn on a fresh terminal and its queries (device attributes, cursor position) are
// not answered: only live output's are, by the one screen the socket names (`answer`).
//
// Typing goes through a hidden textarea. Keys that type nothing (Enter, arrows, Ctrl+C) are encoded from keydown in
// the program's modes. Text is taken from what changes in the textarea, not from keydown: on Android every key of an
// on-screen keyboard arrives as keyCode 229 ("Unidentified"), and the keyboard composes words in the field, corrects
// them and deletes from them. Example: Gboard types "teh" (sent as typed), then corrects it to "the ": the field goes
// from "teh" to "the ", which sends two Backspaces and "he " (terminal-input.ts). The field keeps what was typed since
// the last key that moved the terminal's cursor some other way (Enter, arrows, a paste).
//
// Touch: a long press on output text is the browser's own (word selection, handles, Copy); a long press on a blank
// spot puts the textarea under the finger, so the browser offers Paste into it. A finger scrolls the scrollback (or,
// as Ghostty does, sends wheel events to a program that tracks the mouse and arrow keys to a full-screen one). While
// output is selected, rows are not redrawn: replacing a row's spans would drop the selection the moment the program
// printed. On a touch screen a row of keys phones lack (Esc, Tab, arrows, sticky Ctrl and Alt) sits below.

import { BACKGROUND_CONTEXT, reportError } from "@earendil-works/p3/v1";
import { useMessages } from "@earendil-works/p3/v1/web";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { Ghostty, type KeyInput, type MouseInput, type VtTerminal } from "./ghostty.ts";
import { drawRow, hex } from "./ghostty-rows.ts";
import styles from "./ghostty-screen.module.css";
import { MAX_CELLS } from "./kind.ts";
import { messages } from "./messages.ts";
import type { ScreenFeed, TerminalLink, TerminalScreenProps } from "./screen.ts";
import { typedChange } from "./terminal-input.ts";
import ghosttyWasm from "./vendor/ghostty/ghostty-vt.wasm?url";

/** A terminal drawn with libghostty-vt; typed into and resized where its link lets the person. */
export function GhosttyScreen({ link, label }: TerminalScreenProps) {
	const { t } = useMessages(messages);
	const frame = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const drawn = useRef<DrawnTerminal | undefined>(undefined);
	const [ctrl, setCtrl] = useState(false);
	const [alt, setAlt] = useState(false);
	const [failed, setFailed] = useState(false);
	const modifiers = useRef({ ctrl, alt });
	modifiers.current = { ctrl, alt };
	const typable = link.type !== undefined;
	useEffect(() => {
		if (frame.current === null || content.current === null) return;
		const terminal = new DrawnTerminal({
			link,
			frame: frame.current,
			screen: content.current,
			input: input.current ?? undefined,
			modifiers: () => {
				const value = modifiers.current;
				// Sticky modifiers apply once.
				if (value.ctrl) setCtrl(false);
				if (value.alt) setAlt(false);
				return value;
			},
			failed: () => setFailed(true),
		});
		drawn.current = terminal;
		terminal.start();
		return () => {
			terminal.stop();
			drawn.current = undefined;
		};
	}, [link]);
	// A tap or click focuses the input and opens the on-screen keyboard, unless it selected text to copy. On click, not
	// pointerup: a tap's mousedown follows its pointerup and took the focus away again.
	useEffect(() => {
		const area = frame.current;
		if (area === null || !typable) return;
		const focus = () => {
			const element = input.current;
			if (element === null || element.hasAttribute("data-native-menu")) return;
			if (window.getSelection()?.isCollapsed === false) return;
			// Focused already, maybe with the keyboard hidden (Android's Back): focusing again brings it back.
			if (document.activeElement === element) element.blur();
			element.focus({ preventScroll: true });
		};
		area.addEventListener("click", focus);
		return () => area.removeEventListener("click", focus);
	}, [typable]);
	// Buttons that keep the focus (and the on-screen keyboard) in the terminal.
	const keepFocus = (event: ReactPointerEvent) => event.preventDefault();
	const paste = () => {
		void navigator.clipboard.readText().then(
			(text) => drawn.current?.paste(text),
			(error: unknown) => reportError("terminals: reading the clipboard", error, BACKGROUND_CONTEXT),
		);
	};
	return (
		<div className={styles.terminal} data-terminal-screen="">
			<div
				className={styles.frame}
				onWheel={(event) => drawn.current?.scroll(event.deltaY, { x: event.clientX, y: event.clientY }, event)}
				ref={frame}
			>
				<div aria-label={label} className={styles.content} ref={content} role="log" />
				{typable ? (
					<textarea
						aria-label={t("screenInput")}
						autoCapitalize="off"
						autoComplete="off"
						autoCorrect="off"
						className={styles.input}
						data-terminal-input=""
						ref={input}
						spellCheck={false}
					/>
				) : null}
			</div>
			{failed ? <p className={styles.failed}>{t("screenFailed")}</p> : null}
			{typable ? (
				// Keycaps (Ctrl, Alt, Esc, Tab, arrows) are printed on keyboards in every language: not messages.
				<div aria-label={t("screenKeys")} className={styles.keys} role="toolbar">
					<button aria-pressed={ctrl} onClick={() => setCtrl(!ctrl)} onPointerDown={keepFocus} type="button">
						Ctrl
					</button>
					<button aria-pressed={alt} onClick={() => setAlt(!alt)} onPointerDown={keepFocus} type="button">
						Alt
					</button>
					{KEYS.map((entry) => (
						<button
							key={entry.label}
							onClick={() => {
								if (entry.text !== undefined) drawn.current?.text(entry.text);
								else drawn.current?.key({ ...entry.input, ctrl, alt });
								setCtrl(false);
								setAlt(false);
							}}
							onPointerDown={keepFocus}
							type="button"
						>
							{entry.label}
						</button>
					))}
					<button onClick={paste} onPointerDown={keepFocus} type="button">
						{t("screenPaste")}
					</button>
				</div>
			) : null}
		</div>
	);
}

/** Keys an on-screen keyboard lacks: a key press, or text. Ctrl and Alt stay down for the next key. */
const KEYS: readonly ({ label: string; input: KeyInput; text?: undefined } | { label: string; text: string })[] = [
	{ label: "Esc", input: { code: "Escape", key: "Escape" } },
	{ label: "Tab", input: { code: "Tab", key: "Tab" } },
	{ label: "↑", input: { code: "ArrowUp", key: "ArrowUp" } },
	{ label: "↓", input: { code: "ArrowDown", key: "ArrowDown" } },
	{ label: "←", input: { code: "ArrowLeft", key: "ArrowLeft" } },
	{ label: "→", input: { code: "ArrowRight", key: "ArrowRight" } },
	{ label: "|", text: "|" },
	{ label: "~", text: "~" },
	{ label: "/", text: "/" },
	{ label: "-", text: "-" },
];

/** How long one animation frame parses output at most, in milliseconds. */
const OUTPUT_BUDGET_MS = 8;

/** The largest piece of output parsed at once. */
const OUTPUT_SLICE_BYTES = 64 * 1024;

/** How much drawn output the screen tells the link at once, or after `DRAWN_DELAY_MS`. */
const DRAWN_BATCH_BYTES = 64 * 1024;

/** How long drawn output waits to be told, unless `DRAWN_BATCH_BYTES` are reached first. */
const DRAWN_DELAY_MS = 50;

/** Lines of scrollback each terminal keeps on the page. */
const SCROLLBACK = 10_000;

/** How long a finger rests for a long press. */
const LONG_PRESS_MS = 350;

/** How long a selection of output holds the rows still after its last change. */
const SELECTION_HOLD_MS = 15_000;

/** Whether this is an Apple keyboard, whose Option types characters. */
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** Text as UTF-8. */
const encoder = new TextEncoder();

/** What a `DrawnTerminal` is made with. */
type DrawnOptions = {
	readonly link: TerminalLink;
	/** The element the pointer and the wheel act on: the content and the input inside it. */
	readonly frame: HTMLElement;
	/** Where the rows are drawn. */
	readonly screen: HTMLElement;
	/** The hidden field typed into: absent where the person may only watch. */
	readonly input: HTMLTextAreaElement | undefined;
	/** The key row's sticky Ctrl and Alt, applying once. */
	readonly modifiers: () => { ctrl: boolean; alt: boolean };
	/** The emulator could not load. */
	readonly failed: () => void;
};

/** A touch on the screen: where it went down, whether it moved, its last position and speed (for the fling). */
type Touch = {
	readonly id: number;
	readonly start: { readonly x: number; readonly y: number };
	moved: boolean;
	longPressed: boolean;
	x: number;
	y: number;
	time: number;
	/** Pixels per millisecond, positive while moving up. */
	velocity: number;
};

/** One terminal on one screen: its emulator, rows, cursor, scrollbar, input and its link. */
class DrawnTerminal {
	readonly #link: TerminalLink;
	readonly #frameElement: HTMLElement;
	readonly #screen: HTMLElement;
	readonly #input: HTMLTextAreaElement | undefined;
	readonly #modifiers: () => { ctrl: boolean; alt: boolean };
	readonly #failed: () => void;
	readonly #rows: HTMLElement;
	readonly #cursor: HTMLElement;
	/** Where the shown rows are in the scrollback, while scrolled up. */
	readonly #scrollbar: HTMLElement;
	readonly #resize: ResizeObserver;
	readonly #scheme = matchMedia("(prefers-color-scheme: dark)");
	readonly #schemeChanged = () => this.#colors();
	readonly #selectionChange = () => {
		this.#caretMoved();
		this.#holdForSelection();
	};
	readonly #listeners = new AbortController();
	#ghostty: Ghostty | undefined;
	#vt: VtTerminal | undefined;
	/** The terminal's size as the link last told it. */
	#size: { columns: number; rows: number } | undefined;
	/** Whether this screen answers the program's queries (the socket says: one screen per terminal does). */
	#answering = false;
	/** How many bytes of replayed output are still to parse, whose queries go unanswered. */
	#replay = 0;
	/** Output waiting to be parsed. */
	#queue: Uint8Array[] = [];
	/** Output parsed and not told to the link yet. */
	#undrawn = 0;
	#drawnTimer: ReturnType<typeof setTimeout> | undefined;
	#pumpFrame = 0;
	#frame = 0;
	#stopFollowing: (() => void) | undefined;
	#stopped = false;
	#cell = { width: 8, height: 16 };
	#scrolled = 0;
	/** The mouse button held down in the program (reported presses). */
	#pressed: MouseInput["button"];
	#touch: Touch | undefined;
	#fling = 0;
	#longPress: ReturnType<typeof setTimeout> | undefined;
	/** Rows are not redrawn while output is selected (`#holdForSelection`), until `#holdTimer` or `#release`. */
	#held = false;
	#holdTimer: ReturnType<typeof setTimeout> | undefined;
	/** The next frame redraws every row (after a resize, a restart or a theme change). */
	#full = false;
	/** The textarea's text the terminal got, with its cursor after it (see the top of this file). */
	#typed = "";
	#composing = false;

	constructor(options: DrawnOptions) {
		this.#link = options.link;
		this.#frameElement = options.frame;
		this.#screen = options.screen;
		this.#input = options.input;
		this.#modifiers = options.modifiers;
		this.#failed = options.failed;
		this.#rows = document.createElement("div");
		this.#cursor = element(styles.cursor);
		this.#cursor.hidden = true;
		this.#scrollbar = element(styles.scrollbar);
		this.#scrollbar.hidden = true;
		this.#screen.replaceChildren(this.#rows, this.#cursor, this.#scrollbar);
		this.#resize = new ResizeObserver(() => this.#fit());
		this.#listen();
	}

	/** Measures the cells, loads the emulator and follows the link. */
	start(): void {
		this.#measure();
		this.#resize.observe(this.#screen);
		this.#scheme.addEventListener("change", this.#schemeChanged);
		document.addEventListener("selectionchange", this.#selectionChange);
		Ghostty.load(ghosttyWasm).then(
			(ghostty) => {
				if (this.#stopped) return;
				this.#ghostty = ghostty;
				this.#made();
			},
			(error: unknown) => {
				if (this.#stopped) return;
				reportError("terminals: loading the terminal emulator", error, BACKGROUND_CONTEXT);
				this.#failed();
			},
		);
		const feed: ScreenFeed = {
			restart: (kept) => this.#restart(kept),
			output: (bytes) => {
				this.#queue.push(bytes);
				this.#pump();
			},
			size: (columns, rows) => this.#sized(columns, rows),
			answer: (yes) => {
				this.#answering = yes;
			},
		};
		this.#stopFollowing = this.#link.follow(feed);
	}

	/** Lets go of the link, the listeners and the emulator. */
	stop(): void {
		this.#stopped = true;
		this.#stopFollowing?.();
		this.#flushDrawn();
		this.#listeners.abort();
		clearTimeout(this.#longPress);
		clearTimeout(this.#holdTimer);
		clearTimeout(this.#drawnTimer);
		cancelAnimationFrame(this.#pumpFrame);
		cancelAnimationFrame(this.#frame);
		cancelAnimationFrame(this.#fling);
		this.#scheme.removeEventListener("change", this.#schemeChanged);
		document.removeEventListener("selectionchange", this.#selectionChange);
		this.#resize.disconnect();
		this.#vt?.free();
		this.#vt = undefined;
	}

	/** A key press from the key row. */
	key(input: KeyInput): void {
		this.#release();
		const bytes = this.#vt?.encodeKey(input);
		if (bytes !== undefined) this.#send(bytes);
		this.#clearInput();
	}

	/** Text from the key row. */
	text(text: string): void {
		this.#release();
		this.#send(this.#encodeText(text).bytes);
		this.#clearInput();
	}

	/** Pasted text, as the program asked for pastes (bracketed, control bytes made safe). */
	paste(text: string): void {
		this.#release();
		const bytes = this.#vt?.encodePaste(text);
		if (bytes !== undefined) this.#send(bytes);
		this.#clearInput();
		if (this.#input !== undefined) delete this.#input.dataset.nativeMenu;
	}

	/**
	 * Scrolls by `pixels` at a point in the window, as Ghostty does: wheel events for programs that track the mouse,
	 * arrow keys for full-screen programs that do not (alternate scroll mode, on by default), else the scrollback.
	 */
	scroll(
		pixels: number,
		point: { x: number; y: number },
		mods: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean },
	) {
		const vt = this.#vt;
		if (vt === undefined) return;
		this.#release();
		this.#scrolled += pixels;
		const rows = Math.trunc(this.#scrolled / this.#cell.height);
		if (rows === 0) return;
		this.#scrolled -= rows * this.#cell.height;
		const steps = Math.min(Math.abs(rows), 10);
		if (vt.mouseTracking()) {
			const button = rows < 0 ? "wheelUp" : "wheelDown";
			const at = { clientX: point.x, clientY: point.y, ...mods };
			for (let step = 0; step < steps; step++) this.#mouse({ action: "press", button }, at);
			return;
		}
		if (vt.alternateScreen() && vt.mode(1007)) {
			const code = rows < 0 ? "ArrowUp" : "ArrowDown";
			for (let step = 0; step < steps; step++) this.key({ code, key: code });
			return;
		}
		vt.scroll(rows);
		this.#schedule();
	}

	/** The listeners on the input and the frame, removed at `stop`. */
	#listen(): void {
		const options = { signal: this.#listeners.signal };
		const input = this.#input;
		// Native events: React's onBeforeInput is a polyfill without inputType.
		if (input !== undefined) {
			input.addEventListener("keydown", (event) => this.#keydown(event), options);
			input.addEventListener("beforeinput", (event) => this.#beforeInput(event), options);
			input.addEventListener("input", () => this.#typedChanged(), options);
			input.addEventListener(
				"compositionstart",
				() => {
					this.#composing = true;
				},
				options,
			);
			input.addEventListener(
				"compositionend",
				() => {
					this.#composing = false;
					this.#typedChanged();
				},
				options,
			);
			// Wherever the terminal's cursor is now, the field starts empty.
			input.addEventListener("focus", () => this.#clearInput(), options);
			input.addEventListener(
				"paste",
				(event) => {
					event.preventDefault();
					this.paste(event.clipboardData?.getData("text/plain") ?? "");
				},
				options,
			);
		}
		const frame = this.#frameElement;
		frame.addEventListener("pointerdown", (event) => this.#pointerDown(event), options);
		frame.addEventListener("pointermove", (event) => this.#pointerMove(event), options);
		frame.addEventListener("pointerup", (event) => this.#pointerUp(event), options);
		frame.addEventListener(
			"pointercancel",
			() => {
				clearTimeout(this.#longPress);
				if (this.#touch?.longPressed !== true && input !== undefined) delete input.dataset.nativeMenu;
				this.#pressed = undefined;
				this.#touch = undefined;
			},
			options,
		);
		// The right button goes to programs that track the mouse. A long press (pointerType "touch") is never a right
		// button: cancelling it would take the selection's Copy or the field's Paste menu away.
		frame.addEventListener(
			"contextmenu",
			(event) => {
				if (event.pointerType === "touch" || event.shiftKey || input?.hasAttribute("data-native-menu")) return;
				if (window.getSelection()?.isCollapsed === false || this.#vt?.mouseTracking() !== true) return;
				event.preventDefault();
			},
			options,
		);
		frame.addEventListener("copy", (event) => this.#copy(event), options);
	}

	/** A new connection: the replay that follows is drawn on a fresh terminal. */
	#restart(kept: number): void {
		cancelAnimationFrame(this.#fling);
		// What the last connection sent and was not parsed: the replay sends it again.
		this.#queue = [];
		this.#undrawn = 0;
		clearTimeout(this.#drawnTimer);
		this.#drawnTimer = undefined;
		this.#replay = kept;
		this.#answering = false;
		this.#vt?.free();
		this.#vt = undefined;
		this.#clearInput();
		this.#release();
		this.#made();
	}

	/** The link told the terminal's size: the emulator follows it. */
	#sized(columns: number, rows: number): void {
		const first = this.#size === undefined;
		this.#size = { columns, rows };
		const vt = this.#vt;
		if (vt === undefined) {
			this.#made();
			return;
		}
		if (vt.cols !== columns || vt.rows !== rows) {
			vt.resize(columns, rows, this.#cell.width, this.#cell.height);
			this.#schedule(true);
		}
		// Attached: a screen that may resize makes the terminal its own size.
		if (first) this.#fit();
	}

	/** Makes the emulator once it loaded and the size is known; output waits for it. */
	#made(): void {
		const ghostty = this.#ghostty;
		const size = this.#size;
		if (ghostty === undefined || size === undefined || this.#vt !== undefined) return;
		const type = this.#link.type;
		this.#vt = ghostty.terminal({
			cols: size.columns,
			rows: size.rows,
			scrollback: SCROLLBACK,
			colors: this.#theme(),
			// Answers to the program's queries, only for live output and only from a screen that may type.
			...(type === undefined
				? {}
				: { onReply: (bytes: Uint8Array) => this.#replay === 0 && this.#answering && type(bytes) }),
			colorScheme: () => (this.#scheme.matches ? "dark" : "light"),
		});
		this.#schedule(true);
		this.#fit();
		this.#pump();
	}

	/** The colours of the page's theme, again after it changed. */
	#colors(): void {
		this.#vt?.setColors(this.#theme());
		this.#schedule(true);
	}

	/** The screen's colours, as the page's style resolves them. */
	#theme(): { foreground: number; background: number } {
		const style = getComputedStyle(this.#screen);
		return { foreground: rgbOf(style.color, 0xe6e6e6), background: rgbOf(style.backgroundColor, 0x141414) };
	}

	/** Typed text; a sticky Ctrl or Alt from the key row applies to a single character (`modified`). */
	#encodeText(text: string): { bytes: Uint8Array; modified: boolean } {
		const { ctrl, alt } = this.#modifiers();
		if ((ctrl || alt) && [...text].length === 1) {
			const code = /^[a-z]$/i.test(text) ? `Key${text.toUpperCase()}` : /^\d$/.test(text) ? `Digit${text}` : "";
			const bytes = this.#vt?.encodeKey({ code, key: text, ctrl, alt });
			if (bytes !== undefined) return { bytes, modified: true };
		}
		return { bytes: encoder.encode(text), modified: false };
	}

	/** Empties the textarea: the terminal's cursor moved some other way than typing into it. */
	#clearInput(): void {
		this.#typed = "";
		if (this.#input !== undefined && this.#input.value !== "") this.#input.value = "";
	}

	/** Sends what changed in the textarea; the terminal's cursor is after the text it got, as the textarea's is. */
	#typedChanged(): void {
		const value = this.#input?.value ?? "";
		const { deleted, inserted } = typedChange(this.#typed, value);
		this.#typed = value;
		const parts: Uint8Array[] = [];
		const backspace = deleted > 0 ? this.#vt?.encodeKey({ code: "Backspace", key: "Backspace" }) : undefined;
		if (backspace !== undefined) for (let at = 0; at < deleted; at++) parts.push(backspace);
		let modified = false;
		if (inserted !== "") {
			const text = this.#encodeText(inserted);
			parts.push(text.bytes);
			modified = text.modified;
		}
		if (parts.length > 0) this.#send(concat(parts));
		// Ctrl+C typed with the key row's Ctrl leaves no "c" on the line, and Enter ends it; a long line starts over
		// while nothing is composed, so the field stays small.
		if (modified || inserted.includes("\r") || (!this.#composing && value.length > 500)) this.#clearInput();
	}

	/**
	 * The textarea's cursor moved without typing (Gboard's space bar slide): the terminal's cursor moves as far and the
	 * field starts over empty; further slides then arrive as arrow keys.
	 */
	#caretMoved(): void {
		const input = this.#input;
		if (input === undefined || document.activeElement !== input || this.#composing || input.value !== this.#typed) {
			return;
		}
		const { selectionStart, selectionEnd, value } = input;
		if (selectionStart !== selectionEnd || selectionEnd === value.length) return;
		const left = [...value.slice(selectionEnd)].length;
		const arrow = this.#vt?.encodeKey({ code: "ArrowLeft", key: "ArrowLeft" });
		if (arrow !== undefined) this.#send(concat(new Array<Uint8Array>(left).fill(arrow)));
		this.#clearInput();
	}

	/** The document's selection, when it is a range of the output rows. */
	#outputSelection(): Range | undefined {
		const selection = window.getSelection();
		if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined;
		const range = selection.getRangeAt(0);
		return range.intersectsNode(this.#rows) ? range : undefined;
	}

	/**
	 * Selected output keeps its rows: a redraw replaces a changed row's spans, and a selection in them is gone. Each
	 * change of the selection holds the rows for `SELECTION_HOLD_MS` more; a selection that ends draws what came
	 * meanwhile at once.
	 */
	#holdForSelection(): void {
		clearTimeout(this.#holdTimer);
		if (this.#outputSelection() === undefined) {
			this.#release();
			return;
		}
		this.#held = true;
		this.#holdTimer = setTimeout(() => this.#release(), SELECTION_HOLD_MS);
	}

	/** Draws again: the selection ended or expired, or the person typed, pasted or scrolled. */
	#release(): void {
		clearTimeout(this.#holdTimer);
		if (!this.#held) return;
		this.#held = false;
		this.#schedule();
	}

	/**
	 * Copies selected output as a terminal does: a soft-wrapped line (a long command) as one line, without the blanks
	 * that fill each row to the terminal's width.
	 */
	#copy(event: ClipboardEvent): void {
		const range = this.#outputSelection();
		if (range === undefined || event.clipboardData === null || !this.#rows.contains(range.commonAncestorContainer)) {
			return;
		}
		const rows = [...this.#rows.children].filter((row) => range.intersectsNode(row));
		let text = "";
		for (const [index, row] of rows.entries()) {
			const part = document.createRange();
			part.selectNodeContents(row);
			if (row.contains(range.startContainer)) part.setStart(range.startContainer, range.startOffset);
			if (row.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset);
			const last = index === rows.length - 1;
			if (row.hasAttribute("data-wrapped") && !last) text += part.toString();
			else text += part.toString().trimEnd() + (last ? "" : "\n");
		}
		event.preventDefault();
		event.clipboardData.setData("text/plain", text);
	}

	/**
	 * Whether a character of the output is under a point: a long press there selects it natively; on a blank cell the
	 * textarea goes under the finger for Paste. Columns come from the row's spans: ASCII runs have a character per
	 * column, other characters are cell boxes of their width (`drawRow`).
	 */
	#textAt(x: number, y: number): boolean {
		const box = this.#rows.getBoundingClientRect();
		const row = this.#rows.children[Math.floor((y - box.top) / this.#cell.height)];
		const column = Math.floor((x - box.left) / this.#cell.width);
		let start = 0;
		for (const span of row?.children ?? []) {
			const text = span.textContent ?? "";
			const cell = span instanceof HTMLElement && span.classList.contains(styles.cell ?? "");
			const width = cell ? Math.round(Number.parseFloat(span.style.width) / this.#cell.width) : text.length;
			if (column < start + width) return /\S/.test(cell ? text : (text[column - start] ?? ""));
			start += width;
		}
		return false;
	}

	#keydown(event: KeyboardEvent): void {
		if (event.isComposing || event.keyCode === 229 || event.key === "Dead" || event.key === "Unidentified") return;
		// The browser's own shortcuts: copy, paste, select all.
		if (event.metaKey || (event.ctrlKey && event.shiftKey && (event.code === "KeyC" || event.code === "KeyV"))) {
			return;
		}
		const named = event.key.length > 1;
		const sticky = this.#modifiers();
		// macOS types characters with Option; it is Alt only for keys that type nothing.
		const alt = (event.altKey && !(MAC && !named)) || sticky.alt;
		const ctrl = event.ctrlKey || sticky.ctrl;
		// Plain characters arrive as text input, which also covers on-screen keyboards and input methods.
		if (!named && !ctrl && !alt) return;
		const bytes = this.#vt?.encodeKey({
			code: event.code,
			key: event.key,
			shift: event.shiftKey,
			ctrl,
			alt,
			repeat: event.repeat,
		});
		if (bytes === undefined) return;
		event.preventDefault();
		this.#send(bytes);
		this.#clearInput();
	}

	/** Text, compositions, corrections and deletions change the textarea (`#typedChanged`); Enter does not. */
	#beforeInput(event: InputEvent): void {
		switch (event.inputType) {
			// Enter from a keyboard whose keydown said nothing (keyCode 229).
			case "insertLineBreak":
			case "insertParagraph":
				event.preventDefault();
				this.key({ code: "Enter", key: "Enter" });
				return;
			case "historyUndo":
			case "historyRedo":
				event.preventDefault();
				return;
		}
	}

	/** A mouse event at a point in the window for the program, if it tracks the mouse; whether it does. */
	#mouse(
		input: Pick<MouseInput, "action" | "button">,
		event: { clientX: number; clientY: number; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
	): boolean {
		const vt = this.#vt;
		if (vt?.mouseTracking() !== true) return false;
		const box = this.#screen.getBoundingClientRect();
		const bytes = vt.encodeMouse({
			...input,
			x: event.clientX - box.left,
			y: event.clientY - box.top,
			width: box.width,
			height: box.height,
			cellWidth: this.#cell.width,
			cellHeight: this.#cell.height,
			shift: event.shiftKey ?? false,
			ctrl: event.ctrlKey ?? false,
			alt: event.altKey ?? false,
		});
		if (bytes !== undefined) this.#send(bytes);
		return true;
	}

	// Mouse buttons go to programs that track the mouse; Shift keeps the browser's text selection. A finger taps,
	// long-presses for the native menu, or scrolls. Capture only once it moves: capture during a stationary long press
	// interferes with Chrome's text menu. Never cancel a touch's pointerdown: that takes the long press's menus away.
	#pointerDown(event: PointerEvent): void {
		const input = this.#input;
		if (event.pointerType === "touch") {
			cancelAnimationFrame(this.#fling);
			clearTimeout(this.#longPress);
			if (input !== undefined) delete input.dataset.nativeMenu;
			// A second finger ends the scroll; an existing selection is Chrome's (its Copy menu and handles).
			if (!event.isPrimary || this.#outputSelection() !== undefined) {
				this.#touch = undefined;
				return;
			}
			this.#scrolled = 0;
			const { clientX: x, clientY: y } = event;
			const touch: Touch = {
				id: event.pointerId,
				start: { x, y },
				moved: false,
				longPressed: false,
				x,
				y,
				time: event.timeStamp,
				velocity: 0,
			};
			this.#touch = touch;
			// On output text the long press is the browser's: it selects the word. On a blank spot a real, transparent
			// editing target goes under the finger before the browser's long-press deadline, for Paste.
			const text = this.#textAt(x, y);
			if (!text && input !== undefined) {
				const box = this.#frameElement.getBoundingClientRect();
				input.dataset.nativeMenu = "";
				const left = x - box.left - input.offsetLeft - 22;
				input.style.transform = `translate(${left}px, ${y - box.top - input.offsetTop - 22}px)`;
			}
			this.#longPress = setTimeout(() => {
				if (this.#touch !== touch || touch.moved || this.#outputSelection() !== undefined) return;
				touch.longPressed = true;
				if (!text) input?.focus({ preventScroll: true });
			}, LONG_PRESS_MS);
			return;
		}
		if (event.shiftKey || this.#vt?.mouseTracking() !== true) return;
		const button = (["left", "middle", "right"] as const)[event.button];
		if (button === undefined) return;
		// No text selection while the program has the mouse.
		event.preventDefault();
		this.#screen.setPointerCapture(event.pointerId);
		this.#pressed = button;
		this.#mouse({ action: "press", button }, event);
	}

	#pointerMove(event: PointerEvent): void {
		if (event.pointerType !== "touch") {
			this.#mouse({ action: "motion", ...(this.#pressed === undefined ? {} : { button: this.#pressed }) }, event);
			return;
		}
		const touch = this.#touch;
		if (touch === undefined || event.pointerId !== touch.id || touch.longPressed) return;
		if (!touch.moved && Math.hypot(event.clientX - touch.start.x, event.clientY - touch.start.y) <= 8) return;
		clearTimeout(this.#longPress);
		if (this.#input !== undefined) delete this.#input.dataset.nativeMenu;
		if (!touch.moved) this.#frameElement.setPointerCapture(event.pointerId);
		touch.moved = true;
		const pixels = touch.y - event.clientY;
		// Mostly the latest movement, so a finger that slows down before lifting does not fling.
		touch.velocity = 0.8 * (pixels / Math.max(1, event.timeStamp - touch.time)) + 0.2 * touch.velocity;
		touch.x = event.clientX;
		touch.y = event.clientY;
		touch.time = event.timeStamp;
		this.scroll(pixels, touch, { shiftKey: false, ctrlKey: false, altKey: false });
	}

	#pointerUp(event: PointerEvent): void {
		if (event.pointerType === "touch") {
			const touch = this.#touch;
			if (touch === undefined || event.pointerId !== touch.id) return;
			this.#touch = undefined;
			clearTimeout(this.#longPress);
			if (touch.longPressed) return;
			if (this.#input !== undefined) delete this.#input.dataset.nativeMenu;
			if (touch.moved) this.#coast(touch, event.timeStamp);
			else if (this.#mouse({ action: "press", button: "left" }, event)) {
				this.#mouse({ action: "release", button: "left" }, event);
			}
			return;
		}
		const button = this.#pressed;
		if (button === undefined) return;
		this.#pressed = undefined;
		this.#mouse({ action: "release", button }, event);
	}

	/** A finger lifted while moving keeps scrolling, slowing down, until the next touch or input. */
	#coast(touch: Touch, now: number): void {
		if (now - touch.time > 80 || Math.abs(touch.velocity) < 0.3) return;
		let velocity = touch.velocity;
		let last = performance.now();
		const step = (time: number) => {
			const elapsed = Math.max(0, time - last);
			last = time;
			velocity *= 0.996 ** elapsed;
			if (Math.abs(velocity) < 0.05 || this.#vt === undefined) {
				this.#fling = 0;
				return;
			}
			this.scroll(velocity * elapsed, touch, { shiftKey: false, ctrlKey: false, altKey: false });
			this.#fling = requestAnimationFrame(step);
		};
		this.#fling = requestAnimationFrame(step);
	}

	/** Types `bytes`: back to the bottom, as a terminal does, and a fling stops. */
	#send(bytes: Uint8Array): void {
		const type = this.#link.type;
		if (type === undefined || bytes.length === 0) return;
		cancelAnimationFrame(this.#fling);
		this.#vt?.scroll("bottom");
		this.#schedule();
		type(bytes);
	}

	/** Says that `bytes` more were drawn, in batches. */
	#drawn(bytes: number): void {
		this.#undrawn += bytes;
		if (this.#undrawn >= DRAWN_BATCH_BYTES) this.#flushDrawn();
		else this.#drawnTimer ??= setTimeout(() => this.#flushDrawn(), DRAWN_DELAY_MS);
	}

	#flushDrawn(): void {
		clearTimeout(this.#drawnTimer);
		this.#drawnTimer = undefined;
		if (this.#undrawn === 0) return;
		this.#link.drawn(this.#undrawn);
		this.#undrawn = 0;
	}

	#pump(): void {
		if (this.#pumpFrame !== 0 || this.#queue.length === 0) return;
		this.#pumpFrame = requestAnimationFrame(() => {
			this.#pumpFrame = 0;
			this.#parse();
		});
	}

	/** Parses queued output for up to `OUTPUT_BUDGET_MS`, draws, and goes on next frame if more is queued. */
	#parse(): void {
		const vt = this.#vt;
		// The emulator is made once it loaded and the size came: `#made` pumps again.
		if (vt === undefined) return;
		const deadline = performance.now() + OUTPUT_BUDGET_MS;
		let parsed = 0;
		while (this.#queue.length > 0 && performance.now() < deadline) {
			let bytes = this.#queue[0]!;
			// The replay's end is a piece of its own, so the queries before it go unanswered and those after it not.
			const slice = this.#replay > 0 ? Math.min(OUTPUT_SLICE_BYTES, this.#replay) : OUTPUT_SLICE_BYTES;
			if (bytes.length > slice) {
				this.#queue[0] = bytes.subarray(slice);
				bytes = bytes.subarray(0, slice);
			} else this.#queue.shift();
			vt.write(bytes);
			this.#replay = Math.max(0, this.#replay - bytes.length);
			parsed += bytes.length;
		}
		if (parsed > 0) {
			this.#drawn(parsed);
			cancelAnimationFrame(this.#frame);
			this.#frame = 0;
			this.#draw();
		}
		this.#pump();
	}

	/** The size of a cell in the screen's font. */
	#measure(): void {
		const probe = document.createElement("span");
		probe.textContent = "W".repeat(100);
		probe.style.visibility = "hidden";
		this.#rows.append(probe);
		const box = probe.getBoundingClientRect();
		probe.remove();
		const lineHeight = Number.parseFloat(getComputedStyle(this.#screen).lineHeight);
		this.#cell = {
			width: box.width / 100 || 8,
			height: Number.isFinite(lineHeight) ? lineHeight : box.height || 16,
		};
		this.#screen.style.setProperty("--cell-width", `${this.#cell.width}px`);
		this.#screen.style.setProperty("--cell-height", `${this.#cell.height}px`);
	}

	/** How many cells fit the screen. */
	#cells(): { columns: number; rows: number } {
		return {
			columns: Math.max(10, Math.min(MAX_CELLS, Math.floor(this.#screen.clientWidth / this.#cell.width))),
			rows: Math.max(3, Math.min(MAX_CELLS, Math.floor(this.#screen.clientHeight / this.#cell.height))),
		};
	}

	/** Sizes the terminal to the screen, where the screen may resize it; the program's terminal follows. */
	#fit(): void {
		const vt = this.#vt;
		const resize = this.#link.resize;
		if (vt === undefined || resize === undefined || this.#screen.clientWidth === 0) return;
		const { columns, rows } = this.#cells();
		if (columns === vt.cols && rows === vt.rows) return;
		vt.resize(columns, rows, this.#cell.width, this.#cell.height);
		resize(columns, rows);
		this.#schedule(true);
	}

	#schedule(all = false): void {
		if (all) this.#full = true;
		if (this.#frame !== 0) return;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = 0;
			this.#draw();
		});
	}

	/** Draws what changed since the last frame: rows, the cursor, the scrollbar. */
	#draw(): void {
		const vt = this.#vt;
		// libghostty keeps the changes until the next frame, so the release draws everything that came meanwhile.
		if (vt === undefined || (this.#held && this.#outputSelection() !== undefined)) return;
		const all = this.#full;
		this.#full = false;
		const frame = vt.frame(all);
		while (this.#rows.children.length < frame.rows) this.#rows.append(element(styles.row));
		while (this.#rows.children.length > frame.rows) this.#rows.lastElementChild?.remove();
		for (const { y, cells, wrapped } of frame.changed) {
			const row = this.#rows.children[y];
			if (!(row instanceof HTMLElement)) continue;
			drawRow(row, cells, this.#cell.width);
			// Copying joins it with the next row (`#copy`).
			row.toggleAttribute("data-wrapped", wrapped);
		}
		const cursor = frame.cursor;
		this.#cursor.hidden = cursor === undefined;
		if (cursor !== undefined) {
			const left = `${cursor.x * this.#cell.width}px`;
			const top = `${cursor.y * this.#cell.height}px`;
			this.#cursor.style.transform = `translate(${left}, ${top})`;
			this.#cursor.dataset.style = cursor.style;
			if (cursor.color !== undefined) this.#cursor.style.setProperty("--cursor", hex(cursor.color));
			// The input method's popup appears where the text goes.
			const input = this.#input;
			if (input !== undefined && !input.hasAttribute("data-native-menu")) {
				input.style.transform = `translate(${left}, ${top})`;
			}
		}
		const { total, offset, length } = vt.scrollbar();
		const scrolledBack = length > 0 && offset + length < total;
		this.#scrollbar.hidden = !scrolledBack;
		if (scrolledBack) {
			this.#scrollbar.style.top = `${(offset / total) * 100}%`;
			this.#scrollbar.style.height = `${Math.max((length / total) * 100, 4)}%`;
		}
	}
}

/** A `div` of class `name`. */
function element(name: string | undefined): HTMLElement {
	const made = document.createElement("div");
	made.className = name ?? "";
	return made;
}

/** `parts` in one array. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
	const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}
	return bytes;
}

/** A computed CSS colour (`rgb(…)`) as 0xRRGGBB, `fallback` for one that is not (transparent). */
function rgbOf(color: string, fallback: number): number {
	const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(color);
	if (match === null || match[4] === "0") return fallback;
	return (Number(match[1]) << 16) | (Number(match[2]) << 8) | Number(match[3]);
}
