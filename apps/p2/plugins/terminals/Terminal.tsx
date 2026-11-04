import type { Held } from "@p2/app/v1";
import { BACKGROUND_CONTEXT, whenLive } from "@p2/app/v1";
import {
	browserEnvironment,
	CloseIcon,
	HideIcon,
	KeyboardIcon,
	keepConnected,
	PanelBottomIcon,
	PanelSideIcon,
	PlusIcon,
	type ReconnectLink,
	type SocketEvents,
} from "@p2/app/v1/web";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { Terminals } from "./contract.ts";
import {
	BOLD,
	type Cell,
	FAINT,
	Ghostty,
	INVERSE,
	INVISIBLE,
	ITALIC,
	type KeyInput,
	type MouseInput,
	OVERLINE,
	STRIKETHROUGH,
	UNDERLINE,
	type VtTerminal,
} from "./ghostty.ts";
import type { TerminalEvent, TerminalInfo, TerminalTheme } from "./protocol.ts";
import { typedChange } from "./terminal-input.ts";
import ghosttyWasm from "./vendor/ghostty/ghostty-vt.wasm?url";
import "./terminal-clipboard.css";

// Terminals of a session, in the workspace panel (owner only). The programs run in the terminal host on the session's
// machine (detached.ts); this view renders one with libghostty-vt into DOM rows, so text selection and
// copying are the browser's own, and sends keys, text and pastes back. A reconnect attaches again and starts from the
// host's snapshot.
//
// Typing goes through a hidden textarea. Keys that type nothing (Enter, arrows, Ctrl+C) are encoded from keydown.
// Text is taken from what changes in the textarea, not from keydown: on Android every key of an on-screen keyboard
// arrives as keyCode 229 ("Unidentified"), and the keyboard composes words in the field, corrects them and deletes
// from them. Example: Gboard types "teh" (sent as typed), then corrects it to "the ": the field goes from "teh" to
// "the ", which sends two Backspaces and "he ". The field keeps what was typed since the last key that moved the
// terminal's cursor some other way (Enter, arrows, a paste), so the keyboard's idea of the text matches the field. A
// field kept empty by cancelling every insertion does not: the keyboard deletes and corrects text the field never
// had, which changes nothing and sends nothing.

/** Where terminals open: a tab of the workspace panel, or a panel below the chat. Kept per browser. */
export type TerminalPlacement = "side" | "bottom";
/** Main-thread time per animation frame for parsing output, and the largest piece parsed at once. */
const OUTPUT_BUDGET_MS = 8;
const OUTPUT_SLICE_BYTES = 64 * 1024;
/** Acknowledge output in batches: at least this much, or after this delay. */
const ACK_BATCH_BYTES = 64 * 1024;
const ACK_DELAY_MS = 50;
/** The server pings every 15 s (TERMINAL_PING_MS in service.ts): a socket silent for three of them is replaced. */
const SILENCE_TIMEOUT_MS = 45_000;
const PLACEMENT = "p2-terminal-position";

export function terminalPlacement(): TerminalPlacement {
	try {
		return localStorage.getItem(PLACEMENT) === "bottom" ? "bottom" : "side";
	} catch {
		return "side";
	}
}

export function setTerminalPlacement(placement: TerminalPlacement): void {
	try {
		localStorage.setItem(PLACEMENT, placement);
	} catch {}
}

/** Whether the row of extra keys shows. Kept per browser; by default only on touch screens. */
const KEY_ROW = "p2-terminal-keys";

function keyRowShown(): boolean {
	try {
		const stored = localStorage.getItem(KEY_ROW);
		if (stored !== null) return stored === "on";
	} catch {}
	return matchMedia("(pointer: coarse)").matches;
}

let ghostty: Promise<Ghostty> | undefined;
function loadGhostty(): Promise<Ghostty> {
	ghostty ??= fetch(ghosttyWasm)
		.then((response) => response.arrayBuffer())
		.then((bytes) => Ghostty.load(bytes));
	return ghostty;
}

const encoder = new TextEncoder();
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const NO_MODIFIERS = { shift: false, ctrl: false, alt: false };

function concat(parts: Uint8Array[]): Uint8Array {
	const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}
	return bytes;
}

function hex(color: number): string {
	return `#${color.toString(16).padStart(6, "0")}`;
}

/** A CSS color as 0xRRGGBB, resolved by the browser (custom properties, names, rgb()). */
function cssColor(element: HTMLElement, property: string, fallback: number): number {
	const probe = document.createElement("span");
	probe.style.color = `var(${property})`;
	element.append(probe);
	const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
	probe.remove();
	return match ? (Number(match[1]) << 16) | (Number(match[2]) << 8) | Number(match[3]) : fallback;
}

/**
 * Block elements (U+2580–U+259F) as rectangles of the cell in eighths, [left, top, right, bottom], or a shade's
 * opacity. Font glyphs for them stop short of the line box and come from fallback fonts with other metrics, so half
 * block art (Pi's logo) gets gaps and offsets; terminals draw these themselves.
 */
const BLOCKS: Record<string, [number, number, number, number][] | number> = {
	"▀": [[0, 0, 8, 4]],
	"▁": [[0, 7, 8, 8]],
	"▂": [[0, 6, 8, 8]],
	"▃": [[0, 5, 8, 8]],
	"▄": [[0, 4, 8, 8]],
	"▅": [[0, 3, 8, 8]],
	"▆": [[0, 2, 8, 8]],
	"▇": [[0, 1, 8, 8]],
	"█": [[0, 0, 8, 8]],
	"▉": [[0, 0, 7, 8]],
	"▊": [[0, 0, 6, 8]],
	"▋": [[0, 0, 5, 8]],
	"▌": [[0, 0, 4, 8]],
	"▍": [[0, 0, 3, 8]],
	"▎": [[0, 0, 2, 8]],
	"▏": [[0, 0, 1, 8]],
	"▐": [[4, 0, 8, 8]],
	"░": 0.25,
	"▒": 0.5,
	"▓": 0.75,
	"▔": [[0, 0, 8, 1]],
	"▕": [[7, 0, 8, 8]],
	"▖": [[0, 4, 4, 8]],
	"▗": [[4, 4, 8, 8]],
	"▘": [[0, 0, 4, 4]],
	"▙": [
		[0, 0, 4, 8],
		[4, 4, 8, 8],
	],
	"▚": [
		[0, 0, 4, 4],
		[4, 4, 8, 8],
	],
	"▛": [
		[0, 0, 8, 4],
		[0, 4, 4, 8],
	],
	"▜": [
		[0, 0, 8, 4],
		[4, 4, 8, 8],
	],
	"▝": [[4, 0, 8, 4]],
	"▞": [
		[4, 0, 8, 4],
		[0, 4, 4, 8],
	],
	"▟": [
		[4, 0, 8, 8],
		[0, 4, 4, 8],
	],
};

/** CSS background layers that draw a block element in `color` over a cell `cellWidth` pixels wide. */
function blockBackground(block: [number, number, number, number][] | number, color: string, cellWidth: number): string {
	if (typeof block === "number")
		return `linear-gradient(color-mix(in srgb, ${color} ${block * 100}%, transparent), color-mix(in srgb, ${color} ${block * 100}%, transparent))`;
	return block
		.map(([left, top, right, bottom]) => {
			const x = `${(left / 8) * cellWidth}px`;
			const y = `calc(var(--cell-height) * ${top / 8})`;
			const width = `${((right - left) / 8) * cellWidth}px`;
			const height = `calc(var(--cell-height) * ${(bottom - top) / 8})`;
			return `linear-gradient(${color}, ${color}) ${x} ${y} / ${width} ${height} no-repeat`;
		})
		.join(", ");
}

/** Draw one row: ASCII runs of equal style as text, other characters in boxes of their cell width. */
function drawRow(element: HTMLElement, cells: readonly Cell[], cellWidth: number): void {
	const fragment = document.createDocumentFragment();
	let run: HTMLSpanElement | undefined;
	let runKey = "";
	for (const cell of cells) {
		if (cell.width === 0) continue;
		let color = cell.fg === -1 ? "" : hex(cell.fg);
		let background = cell.bg === -1 ? "" : hex(cell.bg);
		if (cell.flags & INVERSE) {
			const foreground = color || "var(--term-fg)";
			color = background || "var(--term-bg)";
			background = foreground;
		}
		const text = cell.flags & INVISIBLE || !cell.text ? " " : cell.text;
		const style = cell.flags & (BOLD | ITALIC | FAINT | UNDERLINE | STRIKETHROUGH | OVERLINE);
		const key = `${color}|${background}|${style}`;
		const ascii = cell.width === 1 && text.length === 1 && text.charCodeAt(0) < 0x7f;
		if (ascii && run && key === runKey) {
			run.textContent += text;
			continue;
		}
		const block = BLOCKS[text];
		if (block !== undefined) {
			const span = document.createElement("span");
			span.className = "cell block";
			span.style.width = `${cell.width * cellWidth}px`;
			const layers = blockBackground(block, color || "var(--term-fg)", cell.width * cellWidth);
			span.style.background = background ? `${layers}, ${background}` : layers;
			fragment.append(span);
			run = undefined;
			continue;
		}
		const span = document.createElement("span");
		span.textContent = text;
		if (color) span.style.color = color;
		if (background) span.style.background = background;
		if (style & BOLD) span.style.fontWeight = "bold";
		if (style & ITALIC) span.style.fontStyle = "italic";
		if (style & FAINT) span.style.opacity = "0.6";
		const lines = [
			style & UNDERLINE && "underline",
			style & STRIKETHROUGH && "line-through",
			style & OVERLINE && "overline",
		]
			.filter(Boolean)
			.join(" ");
		if (lines) span.style.textDecoration = lines;
		if (!ascii) {
			// Fallback fonts have other advances: keep every non-ASCII character on its cells.
			span.className = "cell";
			span.style.width = `${cell.width * cellWidth}px`;
			run = undefined;
		} else {
			run = span;
			runKey = key;
		}
		fragment.append(span);
	}
	element.replaceChildren(fragment);
}

type ViewState = {
	terminals: TerminalInfo[];
	current?: TerminalInfo;
	connected: boolean;
	error?: string;
	/** The host runs older code than the server; restarting it ends `running` terminals. */
	outdated?: { running?: number };
	/** Closing the shown terminal waits for confirmation: its shell runs `program`. */
	busy?: { terminalId: string; program?: string };
};

/** One connection to /terminal and the terminal it shows. */
class TerminalSession {
	readonly #control: Held<typeof Terminals>;
	#commands: Promise<unknown> = Promise.resolve();
	readonly #screen: HTMLElement;
	readonly #input: HTMLTextAreaElement;
	readonly #onState: (state: ViewState) => void;
	readonly #onTerminal: (terminalId: string) => void;
	readonly #onEmpty: () => void;
	readonly #modifiers: () => { ctrl: boolean; alt: boolean };
	readonly #rows: HTMLElement;
	readonly #cursor: HTMLElement;
	/** Where the shown rows are in the scrollback, while scrolled up. */
	readonly #scrollbar: HTMLElement;
	#preferred?: string;
	#state: ViewState = { terminals: [], connected: false };
	#socket?: WebSocket;
	#vt?: VtTerminal;
	#snapshot = false;
	/**
	 * Output bytes processed but not yet acknowledged to the host, which stops streaming to viewers too far behind and
	 * resyncs them with a snapshot (TERMINAL_OUTPUT_WINDOW in protocol.ts). Never discarded: the host counts on
	 * every byte being acknowledged eventually.
	 */
	#unacked = 0;
	#ackTimer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * Output waiting to be parsed. Parsing everything as it arrived starved rendering during floods (`find /`): the
	 * screen only updated when the main thread found a gap. Output is parsed in slices within a time budget per animation
	 * frame and drawn in the same frame; acknowledgements follow parsing, so the host slows down for a busy browser.
	 */
	#queue: Uint8Array[] = [];
	#pumpFrame = 0;
	/** The terminal for the current `attached` exists; output before it waits. */
	#ready = false;
	#frame = 0;
	#connection?: { stop(): void };
	#stopped = false;
	/** Open a terminal if the first listing has none (`start`); later reconnects only reattach. */
	#autoOpen: boolean;
	#cell = { width: 8, height: 16 };
	#resize: ResizeObserver;
	/** The app's light/dark switch, which programs in the terminal hear about through the host. */
	#themeObserver: MutationObserver;
	#scrolled = 0;
	/** The mouse button held down in the program (reported presses). */
	#pressed?: MouseInput["button"];
	/**
	 * The finger on the screen: where it went down, whether it moved (a scroll, not a tap), its last position and speed
	 * (pixels per millisecond, positive while moving up) for the fling.
	 */
	#touch?: {
		id: number;
		start: { x: number; y: number };
		moved: boolean;
		longPressed: boolean;
		x: number;
		y: number;
		time: number;
		velocity: number;
	};
	#fling = 0;
	#longPress?: ReturnType<typeof setTimeout>;
	/** The next frame redraws every row (after a resize, a snapshot or a theme change). */
	#full = false;
	/** The textarea's text the terminal got, with its cursor after it (see the top of this file). */
	#typed = "";
	#composing = false;
	readonly #conversation: () => number;
	readonly #selectionChange = () => this.#caretMoved();

	constructor(options: {
		control: Held<typeof Terminals>;
		/** The viewed conversation: new terminals open where it works. */
		conversation: () => number;
		terminalId?: string;
		start: boolean;
		screen: HTMLElement;
		input: HTMLTextAreaElement;
		onState: (state: ViewState) => void;
		onTerminal: (terminalId: string) => void;
		/** The last terminal was closed. */
		onEmpty: () => void;
		modifiers: () => { ctrl: boolean; alt: boolean };
	}) {
		this.#control = options.control;
		this.#conversation = options.conversation;
		if (options.terminalId) this.#preferred = options.terminalId;
		this.#autoOpen = options.start;
		this.#screen = options.screen;
		this.#input = options.input;
		this.#onState = options.onState;
		this.#onTerminal = options.onTerminal;
		this.#onEmpty = options.onEmpty;
		this.#modifiers = options.modifiers;
		this.#rows = document.createElement("div");
		this.#rows.className = "terminal-rows";
		this.#cursor = document.createElement("div");
		this.#cursor.className = "terminal-cursor";
		this.#scrollbar = document.createElement("div");
		this.#scrollbar.className = "terminal-scrollbar";
		this.#scrollbar.hidden = true;
		this.#screen.replaceChildren(this.#rows, this.#cursor, this.#scrollbar);
		this.#resize = new ResizeObserver(() => this.#fit());
		this.#themeObserver = new MutationObserver(() =>
			this.#request((control) => control.theme(this.#theme(), BACKGROUND_CONTEXT)),
		);
		// Native events: React's onBeforeInput is a polyfill without inputType.
		const input = this.#input;
		input.addEventListener("keydown", (event) => this.#keydown(event));
		input.addEventListener("beforeinput", (event) => this.#beforeInput(event));
		input.addEventListener("input", () => this.#typedChanged());
		input.addEventListener("compositionstart", () => {
			this.#composing = true;
		});
		input.addEventListener("compositionend", () => {
			this.#composing = false;
			this.#typedChanged();
		});
		// Wherever the terminal's cursor is now, the field starts empty.
		input.addEventListener("focus", () => this.#clearInput());
		input.addEventListener("paste", (event) => {
			event.preventDefault();
			this.paste(event.clipboardData?.getData("text/plain") ?? "");
		});
		const screen = this.#screen.parentElement ?? this.#screen;
		screen.addEventListener("pointerdown", (event) => this.#pointerDown(event));
		screen.addEventListener("pointermove", (event) => this.#pointerMove(event));
		screen.addEventListener("pointerup", (event) => this.#pointerUp(event));
		screen.addEventListener("pointercancel", () => {
			clearTimeout(this.#longPress);
			if (!this.#touch?.longPressed) delete input.dataset.nativeMenu;
			this.#pressed = undefined;
			this.#touch = undefined;
		});
		// The right button goes to programs that track the mouse.
		screen.addEventListener("contextmenu", (event) => {
			if (
				!input.hasAttribute("data-native-menu") &&
				window.getSelection()?.isCollapsed !== false &&
				this.#vt?.mouseTracking() &&
				!event.shiftKey
			)
				event.preventDefault();
		});
	}

	restartHost(): void {
		this.#request((control) => control.restartHost({}, BACKGROUND_CONTEXT));
	}

	start(): void {
		this.#measure();
		this.#resize.observe(this.#screen);
		this.#themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		document.addEventListener("selectionchange", this.#selectionChange);
		this.#connect();
	}

	stop(): void {
		this.#stopped = true;
		this.#connection?.stop();
		clearTimeout(this.#longPress);
		clearTimeout(this.#ackTimer);
		cancelAnimationFrame(this.#pumpFrame);
		cancelAnimationFrame(this.#frame);
		cancelAnimationFrame(this.#fling);
		document.removeEventListener("selectionchange", this.#selectionChange);
		this.#resize.disconnect();
		this.#themeObserver.disconnect();
		this.#vt?.free();
		this.#vt = undefined;
	}

	open(): void {
		const { cols, rows } = this.#size();
		const conversation = this.#conversation();
		this.#request((control) => control.open({ cols, rows, conversation }, BACKGROUND_CONTEXT), true);
	}

	attach(terminalId: string): void {
		if (terminalId === this.#state.current?.id) return;
		cancelAnimationFrame(this.#fling);
		this.#clearInput();
		this.#emit({ busy: undefined });
		this.#request((control) => control.attach({ terminalId }, BACKGROUND_CONTEXT), true);
	}

	/** Kill the shown terminal's program; unless `force`, the host first reports a job running in it (`busy`). */
	close(force = false): void {
		this.#emit({ busy: undefined });
		this.#request((control) => control.close(force ? { force: true } : {}, BACKGROUND_CONTEXT));
	}

	/** Keep the terminal after all. */
	keep(): void {
		this.#emit({ busy: undefined });
	}

	/** Keys from the on-screen key row. */
	key(input: KeyInput): void {
		const bytes = this.#vt?.encodeKey(input);
		if (bytes) this.#send(bytes);
		this.#clearInput();
	}

	/** Text from the key row. */
	text(text: string): void {
		this.#send(this.#encodeText(text).bytes);
		this.#clearInput();
	}

	async pasteClipboard(): Promise<void> {
		const terminal = this.#state.current?.id;
		const text = await navigator.clipboard.readText();
		// Permission prompts can outlive an attachment or a session switch.
		if (!this.#stopped && terminal && terminal === this.#state.current?.id) this.paste(text);
	}

	paste(text: string): void {
		const bytes = this.#vt?.encodePaste(text);
		if (bytes) this.#send(bytes);
		this.#clearInput();
		delete this.#input.dataset.nativeMenu;
	}

	/** Typed text; a sticky Ctrl or Alt from the key row applies to a single character (`modified`). */
	#encodeText(text: string): { bytes: Uint8Array; modified: boolean } {
		const { ctrl, alt } = this.#modifiers();
		if ((ctrl || alt) && [...text].length === 1) {
			const code = /^[a-z]$/i.test(text) ? `Key${text.toUpperCase()}` : /^\d$/.test(text) ? `Digit${text}` : "";
			const bytes = this.#vt?.encodeKey({ code, key: text, ctrl, alt });
			if (bytes) return { bytes, modified: true };
		}
		return { bytes: encoder.encode(text), modified: false };
	}

	/** Empty the textarea: the terminal's cursor moved some other way than typing into it. */
	#clearInput(): void {
		this.#typed = "";
		if (this.#input.value) this.#input.value = "";
	}

	/** Send what changed in the textarea; the terminal's cursor is after the text it got, as the textarea's is. */
	#typedChanged(): void {
		const value = this.#input.value;
		const { deleted, inserted } = typedChange(this.#typed, value);
		this.#typed = value;
		const parts: Uint8Array[] = [];
		const backspace = deleted ? this.#vt?.encodeKey({ code: "Backspace", key: "Backspace" }) : undefined;
		if (backspace) for (let index = 0; index < deleted; index++) parts.push(backspace);
		let modified = false;
		if (inserted) {
			const text = this.#encodeText(inserted);
			parts.push(text.bytes);
			modified = text.modified;
		}
		if (parts.length) this.#send(concat(parts));
		// Ctrl+C typed with the key row's Ctrl leaves no "c" on the line, and Enter ends it; a long line starts over
		// while nothing is composed, so the field stays small.
		if (modified || inserted.includes("\r") || (!this.#composing && value.length > 500)) this.#clearInput();
	}

	/**
	 * The textarea's cursor moved without typing, e.g. Gboard's space bar slide: move the terminal's cursor as far and
	 * start over with an empty field; further slides then arrive as arrow keys.
	 */
	#caretMoved(): void {
		const input = this.#input;
		if (document.activeElement !== input || this.#composing || input.value !== this.#typed) return;
		const { selectionStart, selectionEnd, value } = input;
		if (selectionStart !== selectionEnd || selectionEnd === value.length) return;
		const left = [...value.slice(selectionEnd)].length;
		const arrow = this.#vt?.encodeKey({ code: "ArrowLeft", key: "ArrowLeft" });
		if (arrow) this.#send(concat(new Array<Uint8Array>(left).fill(arrow)));
		this.#clearInput();
	}

	#keydown(event: KeyboardEvent): void {
		if (event.isComposing || event.keyCode === 229 || event.key === "Dead" || event.key === "Unidentified") return;
		// The browser's own shortcuts: copy, paste, select all.
		if (event.metaKey || (event.ctrlKey && event.shiftKey && (event.code === "KeyC" || event.code === "KeyV")))
			return;
		const named = event.key.length > 1;
		const sticky = this.#modifiers();
		// macOS types characters with Option; it is Alt only for keys that type nothing.
		const alt = (event.altKey && !(mac && !named)) || sticky.alt;
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
		if (!bytes) return;
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

	/** A mouse event at a point in the window for the program, if it tracks the mouse and wants this event. */
	#mouse(
		input: Pick<MouseInput, "action" | "button">,
		event: { clientX: number; clientY: number } & Partial<Pick<MouseEvent, "shiftKey" | "ctrlKey" | "altKey">>,
	): boolean {
		const vt = this.#vt;
		if (!vt?.mouseTracking()) return false;
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
		if (bytes) this.#send(bytes);
		return true;
	}

	// Mouse buttons go to programs that track the mouse, as in a terminal; Shift keeps the browser's text selection.
	// A finger taps, long-presses for the native menu, or scrolls (`scroll`). Capture only once it moves: rows can be
	// replaced while scrolling, but capture during a stationary long press interferes with Chrome's text menu.
	#pointerDown(event: PointerEvent): void {
		if (event.pointerType === "touch") {
			cancelAnimationFrame(this.#fling);
			// A second finger ends the scroll.
			if (!event.isPrimary) {
				clearTimeout(this.#longPress);
				delete this.#input.dataset.nativeMenu;
				this.#touch = undefined;
				return;
			}
			clearTimeout(this.#longPress);
			delete this.#input.dataset.nativeMenu;
			// Leave an existing output selection alone: Chrome owns its Copy menu and handles.
			if (window.getSelection()?.isCollapsed === false) return;
			this.#scrolled = 0;
			const { clientX: x, clientY: y } = event;
			const touch = {
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
			// Put a real, transparent editing target under the finger BEFORE Chrome's long-press deadline.
			// Do not capture the pointer or cancel touch/contextmenu: those suppress the native text menu.
			const box = (this.#input.parentElement ?? this.#screen).getBoundingClientRect();
			this.#input.dataset.nativeMenu = "";
			this.#input.style.transform = `translate(${x - box.left - this.#input.offsetLeft - 22}px, ${y - box.top - this.#input.offsetTop - 22}px)`;
			this.#longPress = setTimeout(() => {
				if (this.#touch !== touch || touch.moved || window.getSelection()?.isCollapsed === false) return;
				touch.longPressed = true;
				this.#input.focus({ preventScroll: true });
			}, 350);
			return;
		}
		if (event.shiftKey || !this.#vt?.mouseTracking()) return;
		const button = (["left", "middle", "right"] as const)[event.button];
		if (!button) return;
		// No text selection while the program has the mouse.
		event.preventDefault();
		this.#screen.setPointerCapture(event.pointerId);
		this.#pressed = button;
		this.#mouse({ action: "press", button }, event);
	}

	#pointerMove(event: PointerEvent): void {
		if (event.pointerType !== "touch") {
			this.#mouse({ action: "motion", ...(this.#pressed ? { button: this.#pressed } : {}) }, event);
			return;
		}
		const touch = this.#touch;
		if (!touch || event.pointerId !== touch.id) return;
		if (!touch.moved && Math.hypot(event.clientX - touch.start.x, event.clientY - touch.start.y) <= 8) return;
		if (touch.longPressed) return; // Native selection/menu gestures are not terminal scrolling.
		clearTimeout(this.#longPress);
		delete this.#input.dataset.nativeMenu;
		if (!touch.moved) (this.#screen.parentElement ?? this.#screen).setPointerCapture(event.pointerId);
		touch.moved = true;
		const pixels = touch.y - event.clientY;
		// Mostly the latest movement, so a finger that slows down before lifting doesn't fling.
		touch.velocity = 0.8 * (pixels / Math.max(1, event.timeStamp - touch.time)) + 0.2 * touch.velocity;
		touch.x = event.clientX;
		touch.y = event.clientY;
		touch.time = event.timeStamp;
		this.scroll(pixels, touch, NO_MODIFIERS);
	}

	#pointerUp(event: PointerEvent): void {
		if (event.pointerType === "touch") {
			const touch = this.#touch;
			if (!touch || event.pointerId !== touch.id) return;
			this.#touch = undefined;
			clearTimeout(this.#longPress);
			if (touch.longPressed) return;
			delete this.#input.dataset.nativeMenu;
			if (touch.moved) this.#coast(touch, event.timeStamp);
			else if (this.#mouse({ action: "press", button: "left" }, event))
				this.#mouse({ action: "release", button: "left" }, event);
			return;
		}
		const button = this.#pressed;
		if (!button) return;
		this.#pressed = undefined;
		this.#mouse({ action: "release", button }, event);
	}

	/** A finger lifted while moving keeps scrolling, slowing down, until the next touch or input. */
	#coast(touch: { x: number; y: number; time: number; velocity: number }, now: number): void {
		if (now - touch.time > 80 || Math.abs(touch.velocity) < 0.3) return;
		let velocity = touch.velocity;
		let last = performance.now();
		const step = (time: number) => {
			const elapsed = Math.max(0, time - last);
			last = time;
			velocity *= 0.996 ** elapsed;
			if (Math.abs(velocity) < 0.05 || !this.#vt) {
				this.#fling = 0;
				return;
			}
			this.scroll(velocity * elapsed, touch, NO_MODIFIERS);
			this.#fling = requestAnimationFrame(step);
		};
		this.#fling = requestAnimationFrame(step);
	}

	/**
	 * Scroll by pixels at a point in the window, as Ghostty does: wheel events for programs that track the mouse, arrow
	 * keys for full-screen programs that don't (alternate scroll mode, on by default), else the scrollback.
	 */
	scroll(
		pixels: number,
		point: { x: number; y: number },
		mods: { shift: boolean; ctrl: boolean; alt: boolean },
	): void {
		const vt = this.#vt;
		if (!vt) return;
		this.#scrolled += pixels;
		const rows = Math.trunc(this.#scrolled / this.#cell.height);
		if (!rows) return;
		this.#scrolled -= rows * this.#cell.height;
		const steps = Math.min(Math.abs(rows), 10);
		if (vt.mouseTracking()) {
			const button = rows < 0 ? "wheelUp" : "wheelDown";
			for (let index = 0; index < steps; index++)
				this.#mouse(
					{ action: "press", button },
					{ clientX: point.x, clientY: point.y, shiftKey: mods.shift, ctrlKey: mods.ctrl, altKey: mods.alt },
				);
			return;
		}
		if (vt.alternateScreen() && vt.mode(1007)) {
			const code = rows < 0 ? "ArrowUp" : "ArrowDown";
			for (let index = 0; index < steps; index++) this.key({ code, key: code });
			return;
		}
		vt.scroll(rows);
		this.#schedule();
	}

	#theme(): TerminalTheme {
		return {
			foreground: cssColor(this.#screen, "--term-fg", 0xe6e6e6),
			background: cssColor(this.#screen, "--term-bg", 0x141414),
			scheme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
		};
	}

	#emit(change: Partial<ViewState>): void {
		this.#state = { ...this.#state, ...change };
		this.#onState(this.#state);
	}

	/** Runs a call on the terminal control, in order; `attaching` first settles what this viewer owes for output. */
	#request(call: (control: Held<typeof Terminals>) => Promise<unknown>, attaching = false): void {
		// Attaching resets the host's counters: settle what this viewer owes for the previous terminal first.
		if (attaching) this.#flushAck();
		if (this.#socket?.readyState !== WebSocket.OPEN) return;
		const request = () => call(this.#control);
		this.#commands = this.#commands
			.then(request, request)
			.catch((error: unknown) => this.#emit({ error: error instanceof Error ? error.message : String(error) }));
	}

	#acknowledge(bytes: number): void {
		this.#unacked += bytes;
		if (this.#unacked >= ACK_BATCH_BYTES) this.#flushAck();
		else this.#ackTimer ??= setTimeout(() => this.#flushAck(), ACK_DELAY_MS);
	}

	#flushAck(): void {
		clearTimeout(this.#ackTimer);
		this.#ackTimer = undefined;
		if (this.#unacked === 0 || this.#socket?.readyState !== WebSocket.OPEN) return;
		const bytes = this.#unacked;
		this.#unacked = 0;
		this.#request((control) => control.ack({ bytes }, BACKGROUND_CONTEXT));
	}

	#send(bytes: Uint8Array): void {
		if (this.#socket?.readyState !== WebSocket.OPEN || !this.#state.current || this.#state.current.exited) return;
		// Typing returns to the bottom, like a terminal, and stops a fling (whose own wheel events come from its frame,
		// before it asks for the next).
		cancelAnimationFrame(this.#fling);
		this.#vt?.scroll("bottom");
		this.#schedule();
		this.#socket.send(bytes);
	}

	/**
	 * Keeps the channel open: retries with backoff, at once when the page comes back, and replaces a socket that missed
	 * the server's pings (an idle terminal sends nothing else, so a dead connection would otherwise look open).
	 */
	#connect(): void {
		this.#connection = keepConnected({
			open: (events) => this.#openChannel(events),
			onConnected: (connected) => {
				if (!connected) this.#emit({ connected: false });
			},
			canRetry: async () => !this.#stopped,
			silenceTimeoutMs: SILENCE_TIMEOUT_MS,
			environment: browserEnvironment("terminal"),
		});
	}

	/**
	 * One attempt: a channel token from the control, then the socket. Closing the returned link ends the attempt at once,
	 * whether the socket exists yet or not; an abandoned socket's late events are ignored.
	 */
	#openChannel(events: SocketEvents): ReconnectLink {
		const handlers: ((reason: string) => void)[] = [];
		let socket: WebSocket | undefined;
		let ended = false;
		const end = (reason: string): void => {
			if (ended) return;
			ended = true;
			if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
			for (const handler of handlers) handler(reason);
		};
		void (async () => {
			await whenLive(this.#control);
			const { token } = await this.#control.channel({}, BACKGROUND_CONTEXT);
			if (ended) return;
			const channel = new WebSocket(
				`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/terminal?${new URLSearchParams({ token })}`,
			);
			socket = channel;
			channel.binaryType = "arraybuffer";
			this.#socket = channel;
			channel.onopen = () => {
				if (ended) return;
				events.opened();
				this.#emit({ connected: true, error: undefined, outdated: undefined });
				// First: terminals opened or attached afterwards answer color queries in these colors.
				this.#request((control) => control.theme(this.#theme(), BACKGROUND_CONTEXT));
				this.#request((control) => control.list({}, BACKGROUND_CONTEXT));
			};
			channel.onmessage = (message) => {
				if (ended) return;
				events.received();
				if (message.data instanceof ArrayBuffer) {
					this.#queue.push(new Uint8Array(message.data));
					this.#pump();
					return;
				}
				// The server's keepalive (TERMINAL_PING_MS in service.ts) only needed to arrive.
				const event = JSON.parse(String(message.data)) as TerminalEvent | { type: "ping" };
				if (event.type === "ping") return;
				// A (re)attach starts over with a snapshot: unparsed output is stale, but the host counted it as sent.
				if (event.type === "attached") this.#discardQueue();
				void this.#event(event);
			};
			channel.onclose = (event) => {
				events.closed(event.code, event.reason, event.wasClean);
				end("socket closed");
			};
		})().catch((error: unknown) => {
			if (ended) return;
			const message = error instanceof Error ? error.message : String(error);
			this.#emit({ connected: false, error: message });
			end(`no channel: ${message}`);
		});
		return {
			onClose: (handler) => {
				if (ended) handler("closed");
				else handlers.push(handler);
			},
			close: (reason = "closed") => end(reason),
		};
	}

	async #event(event: TerminalEvent): Promise<void> {
		switch (event.type) {
			case "list": {
				this.#emit({ terminals: event.terminals, error: undefined });
				const wanted = this.#preferred ?? this.#state.current?.id;
				const running = event.terminals.filter((terminal) => !terminal.exited);
				const target =
					event.terminals.find((terminal) => terminal.id === wanted) ??
					running.toSorted((a, b) => b.createdAt - a.createdAt)[0];
				this.#preferred = undefined;
				if (target) {
					this.#emit({ current: undefined });
					this.#request((control) => control.attach({ terminalId: target.id }, BACKGROUND_CONTEXT), true);
				} else if (this.#autoOpen) this.open();
				this.#autoOpen = false;
				return;
			}
			case "attached": {
				const terminal = event.terminal;
				const loaded = await loadGhostty();
				this.#vt?.free();
				this.#vt = loaded.terminal({ cols: terminal.cols, rows: terminal.rows, scrollback: 10_000 });
				this.#snapshot = true;
				this.#ready = true;
				this.#pump();
				this.#emit({
					current: terminal,
					terminals: [...this.#state.terminals.filter((entry) => entry.id !== terminal.id), terminal].toSorted(
						(a, b) => a.createdAt - b.createdAt,
					),
				});
				this.#onTerminal(terminal.id);
				return;
			}
			case "changed": {
				const terminal = event.terminal;
				this.#emit({
					terminals: this.#state.terminals.map((entry) => (entry.id === terminal.id ? terminal : entry)),
					...(this.#state.current?.id === terminal.id ? { current: terminal } : {}),
				});
				// Another viewer resized it: follow, so the screen stays consistent.
				if (this.#vt && (this.#vt.cols !== terminal.cols || this.#vt.rows !== terminal.rows)) {
					this.#vt.resize(terminal.cols, terminal.rows, this.#cell.width, this.#cell.height);
					this.#schedule(true);
				}
				return;
			}
			case "busy":
				if (this.#state.current?.id === event.terminalId)
					this.#emit({
						busy: { terminalId: event.terminalId, ...(event.program ? { program: event.program } : {}) },
					});
				return;
			case "closed": {
				const terminals = this.#state.terminals.filter((entry) => entry.id !== event.terminalId);
				this.#emit({
					terminals,
					...(this.#state.busy?.terminalId === event.terminalId ? { busy: undefined } : {}),
				});
				if (!terminals.length) this.#onEmpty();
				if (this.#state.current?.id !== event.terminalId) return;
				this.#vt?.free();
				this.#vt = undefined;
				this.#rows.replaceChildren();
				this.#cursor.hidden = true;
				this.#emit({ current: undefined });
				const next = terminals.filter((terminal) => !terminal.exited).at(-1);
				if (next) this.attach(next.id);
				return;
			}
			case "error":
				this.#emit({ error: event.message });
				return;
			case "outdated":
				this.#emit({ outdated: { ...(event.running === undefined ? {} : { running: event.running }) } });
				return;
			case "hello":
				return;
		}
	}

	#discardQueue(): void {
		this.#ready = false;
		const bytes = this.#queue.reduce((sum, chunk) => sum + chunk.length, 0);
		this.#queue = [];
		if (bytes) this.#acknowledge(bytes);
	}

	#pump(): void {
		if (this.#pumpFrame || !this.#queue.length) return;
		this.#pumpFrame = requestAnimationFrame(() => {
			this.#pumpFrame = 0;
			this.#parse();
		});
	}

	/** Parse queued output for up to OUTPUT_BUDGET_MS, draw, and continue next frame if more is queued. */
	#parse(): void {
		const vt = this.#vt;
		if (!vt || !this.#ready) return; // `attached` resumes.
		const deadline = performance.now() + OUTPUT_BUDGET_MS;
		let parsed = 0;
		let snapshot = false;
		while (this.#queue.length && performance.now() < deadline) {
			let bytes = this.#queue[0] as Uint8Array;
			if (bytes.length > OUTPUT_SLICE_BYTES) {
				this.#queue[0] = bytes.subarray(OUTPUT_SLICE_BYTES);
				bytes = bytes.subarray(0, OUTPUT_SLICE_BYTES);
			} else this.#queue.shift();
			vt.write(bytes);
			parsed += bytes.length;
			if (this.#snapshot) {
				this.#snapshot = false;
				snapshot = true;
			}
		}
		if (parsed) {
			this.#acknowledge(parsed);
			// Draw in this frame rather than the next.
			if (snapshot) this.#full = true;
			cancelAnimationFrame(this.#frame);
			this.#frame = 0;
			this.#draw();
			if (snapshot) this.#fit();
		}
		this.#pump();
	}

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

	#size(): { cols: number; rows: number } {
		const style = getComputedStyle(this.#screen);
		const width =
			this.#screen.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
		const height =
			this.#screen.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
		return {
			cols: Math.max(10, Math.min(1000, Math.floor(width / this.#cell.width))),
			rows: Math.max(3, Math.min(1000, Math.floor(height / this.#cell.height))),
		};
	}

	/** Size the terminal to the screen; the host resizes the program's terminal too. */
	#fit(): void {
		const vt = this.#vt;
		if (!vt || !this.#state.current || this.#snapshot) return;
		const { cols, rows } = this.#size();
		if (cols === vt.cols && rows === vt.rows) return;
		vt.resize(cols, rows, this.#cell.width, this.#cell.height);
		this.#request((control) => control.resize({ cols, rows }, BACKGROUND_CONTEXT));
		this.#schedule(true);
	}

	#schedule(all = false): void {
		if (all) this.#full = true;
		if (this.#frame) return;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = 0;
			this.#draw();
		});
	}

	#draw(): void {
		const vt = this.#vt;
		if (!vt) return;
		const all = this.#full;
		this.#full = false;
		const frame = vt.frame(all);
		while (this.#rows.children.length < frame.rows) {
			const row = document.createElement("div");
			row.className = "terminal-row";
			this.#rows.append(row);
		}
		while (this.#rows.children.length > frame.rows) this.#rows.lastElementChild?.remove();
		for (const { y, cells } of frame.changed) {
			const row = this.#rows.children[y];
			if (row instanceof HTMLElement) drawRow(row, cells, this.#cell.width);
		}
		const cursor = frame.cursor;
		this.#cursor.hidden = !cursor;
		if (cursor) {
			const left = `${cursor.x * this.#cell.width}px`;
			const top = `${cursor.y * this.#cell.height}px`;
			this.#cursor.style.transform = `translate(${left}, ${top})`;
			this.#cursor.dataset.style = cursor.style;
			if (cursor.color !== undefined) this.#cursor.style.setProperty("--cursor", hex(cursor.color));
			// The input method's popup appears where the text goes.
			if (!this.#input.hasAttribute("data-native-menu")) this.#input.style.transform = `translate(${left}, ${top})`;
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

/** Keys the on-screen keyboard lacks. Ctrl and Alt stay down for the next key. */
const KEYS: { label: string; input?: KeyInput; text?: string }[] = [
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

function label(terminal: TerminalInfo, index: number): string {
	const name = terminal.title || `Terminal ${index + 1}`;
	return terminal.exited ? `${name} (exited)` : name;
}

export function TerminalView({
	control,
	conversation = 1,
	terminalId,
	start = false,
	onTerminal,
	placement,
	onMove,
	onHide,
}: {
	control?: Held<typeof Terminals>;
	/** The viewed conversation: new terminals open where it works (a subagent's own location, else the session's). */
	conversation?: number;
	/** The terminal the route names; it may be gone. */
	terminalId?: string;
	/** Start a terminal if the session has none: the user just opened this view. */
	start?: boolean;
	/** The shown terminal, for the route. */
	onTerminal: (terminalId: string) => void;
	placement: TerminalPlacement;
	/** Show the terminal (the shown one, if any) in the other place. */
	onMove: (terminalId: string | undefined) => void;
	/** Hide the panel; the terminals keep running. The panel also hides once its last terminal is closed. */
	onHide?: () => void;
}) {
	const frame = useRef<HTMLDivElement>(null);
	const screen = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLTextAreaElement>(null);
	const session = useRef<TerminalSession | undefined>(undefined);
	const [state, setState] = useState<ViewState>({ terminals: [], connected: false });
	const [ctrl, setCtrl] = useState(false);
	const [alt, setAlt] = useState(false);
	const [keys, setKeys] = useState(keyRowShown);
	const [pasteNotice, setPasteNotice] = useState("");
	const modifiers = useRef({ ctrl, alt });
	modifiers.current = { ctrl, alt };
	const onTerminalRef = useRef(onTerminal);
	onTerminalRef.current = onTerminal;
	const onHideRef = useRef(onHide);
	onHideRef.current = onHide;
	const initial = useRef(terminalId);
	const initialStart = useRef(start);
	const conversationRef = useRef(conversation);
	conversationRef.current = conversation;

	useEffect(() => {
		if (!screen.current || !input.current || !control) return;
		const current = new TerminalSession({
			control,
			conversation: () => conversationRef.current,
			...(initial.current ? { terminalId: initial.current } : {}),
			start: initialStart.current,
			screen: screen.current,
			input: input.current,
			onState: setState,
			onTerminal: (id) => onTerminalRef.current(id),
			// The terminal button opens a new one when the panel shows again.
			onEmpty: () => onHideRef.current?.(),
			modifiers: () => {
				const value = modifiers.current;
				// Sticky modifiers apply once.
				if (value.ctrl) setCtrl(false);
				if (value.alt) setAlt(false);
				return value;
			},
		});
		session.current = current;
		current.start();
		return () => {
			current.stop();
			session.current = undefined;
		};
	}, [control]);

	// Back or Forward to another terminal of this session.
	useEffect(() => {
		if (terminalId) session.current?.attach(terminalId);
	}, [terminalId]);

	// A tap or click focuses the input and opens the on-screen keyboard, unless it selected text to copy. On click, not
	// pointerup: a tap's mousedown follows its pointerup and took the focus away again. A scroll is no click.
	useEffect(() => {
		const area = frame.current;
		if (!area) return;
		const focus = () => {
			const element = input.current;
			if (!element || element.hasAttribute("data-native-menu") || window.getSelection()?.isCollapsed === false)
				return;
			// Focused already, maybe with the keyboard hidden (Android Back): focusing again brings it back.
			if (document.activeElement === element) element.blur();
			element.focus({ preventScroll: true });
		};
		area.addEventListener("click", focus);
		return () => area.removeEventListener("click", focus);
	}, []);

	// Buttons that keep the focus (and the on-screen keyboard) in the terminal.
	const keepFocus = (event: React.PointerEvent) => event.preventDefault();
	const current = state.current;
	const pasteClipboard = () => {
		void session.current?.pasteClipboard().then(
			() => setPasteNotice(""),
			() => setPasteNotice("Clipboard unavailable. Long-press the terminal to paste."),
		);
	};
	const toggleKeys = () => {
		setKeys(!keys);
		setCtrl(false);
		setAlt(false);
		try {
			localStorage.setItem(KEY_ROW, keys ? "off" : "on");
		} catch {}
	};

	return (
		<div className="terminal">
			<div className="terminal-tabs">
				{state.terminals.map((terminal, index) => (
					<button
						type="button"
						key={terminal.id}
						aria-pressed={terminal.id === current?.id}
						className={terminal.exited ? "exited" : ""}
						title={terminal.env ? `${terminal.env}:${terminal.cwd}` : terminal.cwd}
						onPointerDown={keepFocus}
						onClick={() => session.current?.attach(terminal.id)}
					>
						{label(terminal, index)}
					</button>
				))}
				<button
					type="button"
					className="icon-button"
					aria-label="New terminal"
					onPointerDown={keepFocus}
					onClick={() => session.current?.open()}
				>
					<PlusIcon size={16} />
				</button>
				<button type="button" aria-label="Paste into terminal" onPointerDown={keepFocus} onClick={pasteClipboard}>
					Paste
				</button>
				<span className="spacer" />
				<button
					type="button"
					className="icon-button"
					aria-label="Extra keys"
					aria-pressed={keys}
					title={keys ? "Hide extra keys" : "Show extra keys"}
					onPointerDown={keepFocus}
					onClick={toggleKeys}
				>
					<KeyboardIcon />
				</button>
				<button
					type="button"
					className="icon-button"
					aria-label={placement === "side" ? "Move terminal to the bottom" : "Move terminal to the side"}
					title={placement === "side" ? "Move to the bottom" : "Move to the side"}
					onClick={() => onMove(current?.id)}
				>
					{placement === "side" ? <PanelBottomIcon /> : <PanelSideIcon />}
				</button>
				{current && (
					<button
						type="button"
						className="icon-button"
						aria-label={current.exited ? "Remove terminal" : "Close terminal"}
						title={current.exited ? "Remove" : "Close (kills the program)"}
						onClick={() => session.current?.close()}
					>
						<CloseIcon />
					</button>
				)}
				{onHide && (
					<button
						type="button"
						className="icon-button"
						aria-label="Hide terminal"
						title="Hide (keeps running)"
						onClick={onHide}
					>
						<HideIcon />
					</button>
				)}
			</div>
			{pasteNotice && (
				<output className="notice workspace-note" aria-live="polite">
					{pasteNotice}
				</output>
			)}
			{(state.error || !state.connected || current?.exited) && (
				<p className={`notice workspace-note ${state.error || current?.exited?.error ? "error" : ""}`}>
					{state.error ??
						(!state.connected
							? "Connecting…"
							: current?.exited?.error
								? current.exited.error
								: `Exited with code ${current?.exited?.code}`)}
				</p>
			)}
			{state.busy && state.busy.terminalId === current?.id && (
				<p className="notice workspace-note terminal-confirm">
					<span>
						{state.busy.program ? <code>{state.busy.program}</code> : "A program"} is running in this terminal.
						Close it anyway?
					</span>
					<button type="button" className="text-action danger" onClick={() => session.current?.close(true)}>
						Close
					</button>
					<button type="button" className="text-action" onClick={() => session.current?.keep()}>
						Cancel
					</button>
				</p>
			)}
			{state.outdated && (
				<p className="notice workspace-note terminal-outdated">
					<span>
						The terminal host runs older code.{" "}
						{state.outdated.running === undefined
							? "Restarting it ends its terminals."
							: `Restarting it ends ${state.outdated.running} running terminal${state.outdated.running === 1 ? "" : "s"}.`}
					</span>
					<button type="button" className="text-action" onClick={() => session.current?.restartHost()}>
						Restart
					</button>
				</p>
			)}
			{state.connected && !current && !state.terminals.some((terminal) => !terminal.exited) && (
				<button type="button" className="button terminal-start" onClick={() => session.current?.open()}>
					New terminal
				</button>
			)}
			<div
				className="terminal-screen"
				ref={frame}
				onWheel={(event) =>
					session.current?.scroll(
						event.deltaY,
						{ x: event.clientX, y: event.clientY },
						{ shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey },
					)
				}
			>
				<div className="terminal-content" ref={screen} />
				<textarea
					ref={input}
					className="terminal-input"
					aria-label="Terminal input"
					autoCapitalize="off"
					autoComplete="off"
					autoCorrect="off"
					spellCheck={false}
				/>
			</div>
			{keys && (
				<div className="terminal-keys">
					<button type="button" aria-pressed={ctrl} onPointerDown={keepFocus} onClick={() => setCtrl(!ctrl)}>
						Ctrl
					</button>
					<button type="button" aria-pressed={alt} onPointerDown={keepFocus} onClick={() => setAlt(!alt)}>
						Alt
					</button>
					{KEYS.map((entry) => (
						<button
							type="button"
							key={entry.label}
							onPointerDown={keepFocus}
							onClick={() => {
								const terminal = session.current;
								if (!terminal) return;
								if (entry.input) {
									terminal.key({ ...entry.input, ctrl, alt });
									setCtrl(false);
									setAlt(false);
								} else if (entry.text) terminal.text(entry.text);
							}}
						>
							{entry.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/** The terminal below the chat; its top edge drags to resize it. */
export function TerminalPanel(props: Omit<Parameters<typeof TerminalView>[0], "placement">) {
	const panel = useRef<HTMLElement>(null);
	const [height, setHeight] = useState(() => Number(localStorage.getItem("p2-terminal-height")) || undefined);
	// Like the workspace's width: the handle captures the pointer, and only the CSS variable changes while dragging.
	const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
		const element = panel.current;
		const parent = element?.parentElement;
		if (!element || !parent || (event.pointerType === "mouse" && event.button !== 0)) return;
		event.preventDefault();
		const handle = event.currentTarget;
		const pointer = event.pointerId;
		handle.setPointerCapture(pointer);
		const bottom = element.getBoundingClientRect().bottom;
		const limit = parent.getBoundingClientRect().height * 0.85;
		let last = height;
		const move = (moved: PointerEvent) => {
			if (moved.pointerId !== pointer) return;
			last = Math.round(Math.min(Math.max(bottom - moved.clientY, 120), limit));
			element.style.setProperty("--terminal-height", `${last}px`);
		};
		const end = (ended: PointerEvent) => {
			if (ended.pointerId !== pointer) return;
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", end);
			handle.removeEventListener("pointercancel", end);
			if (!last) return;
			setHeight(last);
			localStorage.setItem("p2-terminal-height", String(last));
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
	};
	return (
		<section
			className="terminal-panel"
			aria-label="Terminal"
			ref={panel}
			style={height ? ({ "--terminal-height": `${height}px` } as CSSProperties) : undefined}
		>
			<button
				type="button"
				className="terminal-resize"
				aria-label="Drag to resize terminal"
				tabIndex={-1}
				onPointerDown={startResize}
			/>
			<TerminalView {...props} placement="bottom" />
		</section>
	);
}
