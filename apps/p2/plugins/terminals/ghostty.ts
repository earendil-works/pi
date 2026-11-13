// Bindings for libghostty-vt (./vendor/ghostty), loaded by the browser's terminal view and by the terminal host's
// headless copies of each terminal. Plain WebAssembly: pointers and size_t are 32-bit, struct layouts come from
// ghostty_type_json(), and structs passed by value travel as pointers (the wasm32 C ABI).

type Fn = (...args: (number | bigint)[]) => number;
/** `types` of ghostty_type_json(): structs have `fields`, packed bit sets (style flags) have `bits`. */
type Layout = Record<
	string,
	{
		size: number;
		fields?: Record<string, { offset: number; size: number }>;
		bits?: Record<string, { lsb: number; width: number }>;
	}
>;

const SUCCESS = 0;
const OUT_OF_SPACE = -3;

// GhosttySysOption
const SYS_LOG = 3;
// GhosttyTerminalOption
const OPT_WRITE_PTY = 2;
const OPT_COLOR_SCHEME = 8;
const OPT_COLOR_FOREGROUND = 12;
const OPT_COLOR_BACKGROUND = 13;
const OPT_COLOR_CURSOR = 14;
const OPT_SCROLLBACK_MAX_BYTES = 28;
const OPT_SCROLLBACK_MAX_LINES = 29;
// GhosttyTerminalData
const DATA_ACTIVE_SCREEN = 6;
const DATA_MOUSE_TRACKING = 11;
const DATA_SCROLLBAR = 9;
const DATA_TITLE = 12;
const DATA_MODE = 37;
// GhosttyRenderStateData
const RENDER_DIRTY = 3;
const RENDER_ROW_ITERATOR = 4;
const RENDER_CURSOR = 18;
const RENDER_COLORS = 19;
// GhosttyRenderStateRowData
const ROW_DIRTY = 1;
const ROW_RAW = 2;
const ROW_CELLS = 3;
// GhosttyRowData
const ROW_DATA_WRAP = 1;
// GhosttyRenderStateRowCellsData
const CELL_RAW = 1;
const CELL_STYLE = 2;
const CELL_BG = 5;
const CELL_FG = 6;
const CELL_HAS_STYLING = 8;
const CELL_GRAPHEMES_UTF8 = 9;
// GhosttyFormatterOption, GhosttyFormatterFormat
const FORMATTER_EMIT = 1;
const FORMATTER_UNWRAP = 2;
const FORMATTER_TRIM = 3;
const FORMATTER_EXTRAS = 5;
const FORMAT_PLAIN = 0;
const FORMAT_VT = 1;
// GhosttyMouseEncoderOption
const MOUSE_SIZE = 3;
const MOUSE_ANY_BUTTON_PRESSED = 4;
const MOUSE_TRACK_LAST_CELL = 5;
// GhosttyCellData, GhosttyCellWide
const CELL_DATA_WIDE = 3;
const CELL_WIDE = 1;
/** Bytes of UTF-8 a cell's text gets before it needs a larger buffer. */
const GRAPHEME_BYTES = 128;
/** SIZE_MAX on wasm32: no limit. */
const UNLIMITED = 0xffff_ffff;

/** Cell flags in `Cell.flags`. */
export const BOLD = 1;
export const ITALIC = 2;
export const FAINT = 4;
export const UNDERLINE = 8;
export const STRIKETHROUGH = 16;
export const INVERSE = 32;
export const INVISIBLE = 64;
export const BLINK = 128;
export const OVERLINE = 256;

/** One cell of a rendered row; colors are 0xRRGGBB, or -1 for the terminal's default. */
export interface Cell {
	text: string;
	/** Columns it covers: 2 for a wide character, 0 for the column after one (draw nothing). */
	width: 0 | 1 | 2;
	fg: number;
	bg: number;
	flags: number;
}

export interface Frame {
	/** none: nothing changed; partial: only `rows` changed; full: `rows` holds every row. */
	dirty: "none" | "partial" | "full";
	cols: number;
	rows: number;
	foreground: number;
	background: number;
	/** The cursor, when it is visible in the viewport. */
	cursor?: {
		x: number;
		y: number;
		style: "bar" | "block" | "underline" | "hollow";
		blinking: boolean;
		color?: number;
	};
	/** Changed rows, top to bottom, by viewport row; `wrapped`: soft-wrapped, its line continues on the next row. */
	changed: { y: number; cells: Cell[]; wrapped: boolean }[];
}

export interface KeyInput {
	/** `KeyboardEvent.code`: the physical key. */
	code: string;
	/** `KeyboardEvent.key`: the character for the layout, before Ctrl/Alt change it. */
	key: string;
	shift?: boolean;
	ctrl?: boolean;
	alt?: boolean;
	meta?: boolean;
	repeat?: boolean;
}

export interface Colors {
	foreground: number;
	background: number;
	cursor?: number;
}

export interface TerminalOptions {
	cols: number;
	rows: number;
	/** Lines of scrollback kept. */
	scrollback: number;
	colors?: Colors;
	/** Answers the terminal sends to the program (device attributes, cursor position reports, ...). */
	onReply?: (bytes: Uint8Array) => void;
	/** Whether the terminal is light or dark, for programs that ask (CSI ? 996 n); unanswered when undefined. */
	colorScheme?: () => "light" | "dark" | undefined;
}

/**
 * A mouse event at a position in pixels of the terminal's content area: a button press or release (the wheel is
 * buttons that are only pressed), or motion with `button` held, or none.
 */
export interface MouseInput {
	action: "press" | "release" | "motion";
	button?: "left" | "middle" | "right" | "wheelUp" | "wheelDown";
	x: number;
	y: number;
	/** The content area and its cells, in pixels. */
	width: number;
	height: number;
	cellWidth: number;
	cellHeight: number;
	shift?: boolean;
	ctrl?: boolean;
	alt?: boolean;
}

/**
 * Physical keys in GhosttyKey order (include/ghostty/vt/key/event.h): the enum value is the index plus one. Named by
 * W3C `KeyboardEvent.code`.
 */
const KEY_CODES = new Map(
	`Backquote Backslash BracketLeft BracketRight Comma Digit0 Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7
Digit8 Digit9 Equal IntlBackslash IntlRo IntlYen KeyA KeyB KeyC KeyD KeyE KeyF KeyG KeyH KeyI KeyJ KeyK KeyL
KeyM KeyN KeyO KeyP KeyQ KeyR KeyS KeyT KeyU KeyV KeyW KeyX KeyY KeyZ Minus Period Quote Semicolon Slash
AltLeft AltRight Backspace CapsLock ContextMenu ControlLeft ControlRight Enter MetaLeft MetaRight ShiftLeft
ShiftRight Space Tab Convert KanaMode NonConvert Delete End Help Home Insert PageDown PageUp ArrowDown
ArrowLeft ArrowRight ArrowUp NumLock Numpad0 Numpad1 Numpad2 Numpad3 Numpad4 Numpad5 Numpad6 Numpad7 Numpad8
Numpad9 NumpadAdd NumpadBackspace NumpadClear NumpadClearEntry NumpadComma NumpadDecimal NumpadDivide
NumpadEnter NumpadEqual NumpadMemoryAdd NumpadMemoryClear NumpadMemoryRecall NumpadMemoryStore
NumpadMemorySubtract NumpadMultiply NumpadParenLeft NumpadParenRight NumpadSubtract NumpadSeparator NumpadUp
NumpadDown NumpadRight NumpadLeft NumpadBegin NumpadHome NumpadEnd NumpadInsert NumpadDelete NumpadPageUp
NumpadPageDown Escape F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12 F13 F14 F15 F16 F17 F18 F19 F20 F21 F22 F23 F24
F25 Fn FnLock PrintScreen ScrollLock Pause`
		.split(/\s+/)
		.map((code, index) => [code, index + 1]),
);

/**
 * A module that imports `env.f` with `params` i32 parameters (and an i32 result when `result`) and exports it as a
 * WebAssembly function, which unlike a JavaScript function can go into the function table C callbacks are called
 * through.
 */
function callback(
	params: number,
	result: boolean,
	target: (...args: number[]) => number | undefined,
): WebAssembly.ExportValue {
	const bytes = new Uint8Array([
		0x00,
		0x61,
		0x73,
		0x6d,
		0x01,
		0x00,
		0x00,
		0x00,
		// type section: one function type (i32 × params) -> (i32 when result)
		0x01,
		4 + params + (result ? 1 : 0),
		0x01,
		0x60,
		params,
		...new Array<number>(params).fill(0x7f),
		...(result ? [0x01, 0x7f] : [0x00]),
		// import section: env.f of type 0
		0x02,
		0x09,
		0x01,
		0x03,
		0x65,
		0x6e,
		0x76,
		0x01,
		0x66,
		0x00,
		0x00,
		// export section: f = function 0
		0x07,
		0x05,
		0x01,
		0x01,
		0x66,
		0x00,
		0x00,
	]);
	const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { f: target } });
	return instance.exports.f as WebAssembly.ExportValue;
}

const utf8 = new TextDecoder();

const rgb = (view: DataView, offset: number) =>
	(view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);

/** A loaded libghostty-vt module; terminals made from it share its memory. */
export class Ghostty {
	readonly #api: Record<string, Fn>;
	readonly #memory: WebAssembly.Memory;
	readonly #layout: Layout;
	readonly #terminals = new Map<number, VtTerminal>();
	readonly #writePty: number;
	readonly #colorScheme: number;

	private constructor(instance: WebAssembly.Instance) {
		this.#api = instance.exports as unknown as Record<string, Fn>;
		this.#memory = instance.exports.memory as WebAssembly.Memory;
		const typeJson = this.#api.ghostty_type_json;
		if (!typeJson) throw new Error("Not libghostty-vt: no ghostty_type_json");
		const json = typeJson();
		const bytes = new Uint8Array(this.#memory.buffer);
		const end = bytes.indexOf(0, json);
		const parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(json, end))) as { types: Layout };
		this.#layout = parsed.types;
		const table = instance.exports.__indirect_function_table as WebAssembly.Table;
		// GhosttySysLogFn(userdata, level, scope, scope_len, message, message_len)
		const log = table.grow(1);
		table.set(
			log,
			callback(6, false, (_userdata, _level, scope, scopeLength, message, messageLength) => {
				const decoder = new TextDecoder();
				const text = decoder.decode(new Uint8Array(this.#memory.buffer, message, messageLength));
				const name = scopeLength ? decoder.decode(new Uint8Array(this.#memory.buffer, scope, scopeLength)) : "";
				console.debug(name ? `[ghostty ${name}]` : "[ghostty]", text);
				return undefined;
			}),
		);
		this.call("ghostty_sys_set", SYS_LOG, log);
		// GhosttyTerminalWritePtyFn(terminal, userdata, data, len)
		this.#writePty = table.grow(1);
		table.set(
			this.#writePty,
			callback(4, false, (terminal, _userdata, data, length) => {
				const copy = new Uint8Array(this.#memory.buffer, data, length).slice();
				this.#terminals.get(terminal)?.reply(copy);
				return undefined;
			}),
		);
		// GhosttyTerminalColorSchemeFn(terminal, userdata, out) -> bool; GhosttyColorScheme: 0 light, 1 dark.
		this.#colorScheme = table.grow(1);
		table.set(
			this.#colorScheme,
			callback(3, true, (terminal, _userdata, out) => {
				const scheme = this.#terminals.get(terminal)?.scheme();
				if (!scheme) return 0;
				this.view().setUint32(out, scheme === "dark" ? 1 : 0, true);
				return 1;
			}),
		);
	}

	static async load(source: BufferSource | WebAssembly.Module): Promise<Ghostty> {
		const instance =
			source instanceof WebAssembly.Module
				? await WebAssembly.instantiate(source)
				: (await WebAssembly.instantiate(source)).instance;
		return new Ghostty(instance);
	}

	terminal(options: TerminalOptions): VtTerminal {
		const terminal = new VtTerminal(this, options);
		this.#terminals.set(terminal.handle, terminal);
		if (options.onReply) this.call("ghostty_terminal_set", terminal.handle, OPT_WRITE_PTY, this.#writePty);
		if (options.colorScheme) this.call("ghostty_terminal_set", terminal.handle, OPT_COLOR_SCHEME, this.#colorScheme);
		return terminal;
	}

	/** @internal */
	forget(handle: number): void {
		this.#terminals.delete(handle);
	}

	/** @internal */
	call(name: string, ...args: (number | bigint)[]): number {
		const fn = this.#api[name];
		if (!fn) throw new Error(`libghostty-vt has no ${name}`);
		return fn(...args);
	}

	/** @internal A fresh view: memory growth replaces the buffer. */
	view(): DataView {
		return new DataView(this.#memory.buffer);
	}

	/** @internal */
	bytes(pointer: number, length: number): Uint8Array {
		return new Uint8Array(this.#memory.buffer, pointer, length);
	}

	/** @internal */
	field(type: string, name: string): number {
		const field = this.#layout[type]?.fields?.[name];
		if (!field) throw new Error(`libghostty-vt has no ${type}.${name}`);
		return field.offset;
	}

	/** @internal The lowest bit of `name` in the packed bit set `type`. */
	bit(type: string, name: string): number {
		const bit = this.#layout[type]?.bits?.[name];
		if (!bit) throw new Error(`libghostty-vt has no ${type}.${name}`);
		return bit.lsb;
	}

	/** @internal */
	size(type: string): number {
		const layout = this.#layout[type];
		if (!layout) throw new Error(`libghostty-vt has no ${type}`);
		return layout.size;
	}

	/** @internal Allocate `length` zeroed bytes. */
	alloc(length: number): number {
		const pointer = this.call("ghostty_wasm_alloc", length);
		if (!pointer) throw new Error("libghostty-vt is out of memory");
		this.bytes(pointer, length).fill(0);
		return pointer;
	}

	/** @internal */
	free(pointer: number, length: number): void {
		this.call("ghostty_wasm_free", pointer, length);
	}

	/** @internal Create an object through `new(allocator, out)` and return its handle. */
	create(name: string, ...args: number[]): number {
		const out = this.alloc(4);
		try {
			const result = this.call(name, 0, out, ...args);
			if (result !== SUCCESS) throw new Error(`${name} failed (${result})`);
			return this.view().getUint32(out, true);
		} finally {
			this.free(out, 4);
		}
	}
}

/** Scratch space each terminal keeps for small results. */
const SCRATCH = 1024;

/**
 * GhosttyFormatterExtras of a snapshot (GHOSTTY_FORMATTER_EXTRA_* bits): modes 1, scrolling region 2, pwd 4, keyboard
 * 5, cursor 6, style 7, hyperlink 8, protection 9, Kitty keyboard 10, charsets 11. Not the palette (0), and not tab
 * stops (3): the formatter emits them after the cursor position, moving the cursor (programs rarely change the default
 * stops anyway).
 */
const VT_EXTRAS = [1, 2, 4, 5, 6, 7, 8, 9, 10, 11].reduce((bits, bit) => bits | (1 << bit), 0);

/** One terminal emulator: VT state, screen and scrollback, rendering and input encoding. */
export class VtTerminal {
	readonly handle: number;
	readonly #ghostty: Ghostty;
	readonly #onReply?: (bytes: Uint8Array) => void;
	readonly #colorSchemeOf?: () => "light" | "dark" | undefined;
	readonly #scratch: number;
	readonly #graphemes: number;
	#render = 0;
	#rows = 0;
	#cells = 0;
	#encoder = 0;
	#event = 0;
	#mouseEncoder = 0;
	#mouseEvent = 0;
	#freed = false;
	cols: number;
	rows: number;

	constructor(ghostty: Ghostty, options: TerminalOptions) {
		this.#ghostty = ghostty;
		if (options.onReply) this.#onReply = options.onReply;
		if (options.colorScheme) this.#colorSchemeOf = options.colorScheme;
		this.cols = options.cols;
		this.rows = options.rows;
		this.handle = ghostty.create("ghostty_terminal_new", options.cols, options.rows);
		this.#scratch = ghostty.alloc(SCRATCH);
		this.#graphemes = ghostty.alloc(GRAPHEME_BYTES);
		// Scrollback is limited by lines alone: the default byte limit keeps about one page (a few hundred rows).
		ghostty.view().setUint32(this.#scratch, options.scrollback, true);
		ghostty.call("ghostty_terminal_set", this.handle, OPT_SCROLLBACK_MAX_LINES, this.#scratch);
		ghostty.view().setUint32(this.#scratch, UNLIMITED, true);
		ghostty.call("ghostty_terminal_set", this.handle, OPT_SCROLLBACK_MAX_BYTES, this.#scratch);
		if (options.colors) this.setColors(options.colors);
	}

	/** @internal */
	reply(bytes: Uint8Array): void {
		this.#onReply?.(bytes);
	}

	/** @internal */
	scheme(): "light" | "dark" | undefined {
		return this.#colorSchemeOf?.();
	}

	/** Process output of the program. */
	write(bytes: Uint8Array): void {
		if (!bytes.length) return;
		const pointer = this.#ghostty.alloc(bytes.length);
		try {
			this.#ghostty.bytes(pointer, bytes.length).set(bytes);
			this.#ghostty.call("ghostty_terminal_vt_write", this.handle, pointer, bytes.length);
		} finally {
			this.#ghostty.free(pointer, bytes.length);
		}
	}

	resize(cols: number, rows: number, cellWidth = 8, cellHeight = 16): void {
		this.cols = cols;
		this.rows = rows;
		this.#ghostty.call(
			"ghostty_terminal_resize",
			this.handle,
			cols,
			rows,
			Math.round(cellWidth),
			Math.round(cellHeight),
		);
	}

	setColors(colors: Colors): void {
		const set = (option: number, color: number | undefined) => {
			if (color === undefined) {
				this.#ghostty.call("ghostty_terminal_set", this.handle, option, 0);
				return;
			}
			const view = this.#ghostty.view();
			view.setUint8(this.#scratch, (color >> 16) & 0xff);
			view.setUint8(this.#scratch + 1, (color >> 8) & 0xff);
			view.setUint8(this.#scratch + 2, color & 0xff);
			this.#ghostty.call("ghostty_terminal_set", this.handle, option, this.#scratch);
		};
		set(OPT_COLOR_FOREGROUND, colors.foreground);
		set(OPT_COLOR_BACKGROUND, colors.background);
		set(OPT_COLOR_CURSOR, colors.cursor);
	}

	/** Whether a mode is set; DEC private modes unless `ansi`. */
	mode(value: number, ansi = false): boolean {
		const ghostty = this.#ghostty;
		const type = "GhosttyTerminalModeConfig";
		ghostty.bytes(this.#scratch, ghostty.size(type)).fill(0);
		const view = ghostty.view();
		view.setUint16(this.#scratch + ghostty.field(type, "mode"), (value & 0x7fff) | (ansi ? 0x8000 : 0), true);
		ghostty.call("ghostty_terminal_get", this.handle, DATA_MODE, this.#scratch);
		return ghostty.view().getUint8(this.#scratch + ghostty.field(type, "value")) !== 0;
	}

	/** The alternate screen (full-screen programs) is active. */
	alternateScreen(): boolean {
		this.#ghostty.call("ghostty_terminal_get", this.handle, DATA_ACTIVE_SCREEN, this.#scratch);
		return this.#ghostty.view().getUint32(this.#scratch, true) === 1;
	}

	/** The program asked for mouse events (any tracking mode). */
	mouseTracking(): boolean {
		this.#ghostty.view().setUint8(this.#scratch, 0);
		this.#ghostty.call("ghostty_terminal_get", this.handle, DATA_MOUSE_TRACKING, this.#scratch);
		return this.#ghostty.view().getUint8(this.#scratch) !== 0;
	}

	/**
	 * The bytes a mouse event sends in the program's mouse mode and format; undefined when the program does not want
	 * it (no tracking, or motion it did not ask for).
	 */
	encodeMouse(input: MouseInput): Uint8Array | undefined {
		const ghostty = this.#ghostty;
		if (!this.#mouseEncoder) {
			this.#mouseEncoder = ghostty.create("ghostty_mouse_encoder_new");
			this.#mouseEvent = ghostty.create("ghostty_mouse_event_new");
			// Motion within the cell of the last report is not reported again.
			ghostty.view().setUint8(this.#scratch, 1);
			ghostty.call("ghostty_mouse_encoder_set", this.#mouseEncoder, MOUSE_TRACK_LAST_CELL, this.#scratch);
		}
		ghostty.call("ghostty_mouse_encoder_set_from_terminal", this.#mouseEncoder, this.handle);
		const type = "GhosttyMouseEncoderSize";
		const size = ghostty.size(type);
		const scratch = this.#scratch;
		ghostty.bytes(scratch, size).fill(0);
		let view = ghostty.view();
		const set = (name: string, value: number) =>
			view.setUint32(scratch + ghostty.field(type, name), Math.max(0, Math.round(value)), true);
		set("size", size);
		set("screen_width", input.width);
		set("screen_height", input.height);
		set("cell_width", input.cellWidth);
		set("cell_height", input.cellHeight);
		ghostty.call("ghostty_mouse_encoder_set", this.#mouseEncoder, MOUSE_SIZE, scratch);
		// Motion with a button held is reported in button-event mode (1002) too.
		view = ghostty.view();
		view.setUint8(scratch, input.action === "motion" && input.button ? 1 : 0);
		ghostty.call("ghostty_mouse_encoder_set", this.#mouseEncoder, MOUSE_ANY_BUTTON_PRESSED, scratch);
		// GhosttyMouseAction: press, release, motion. GhosttyMouseButton: left 1, right 2, middle 3, wheel 4 / 5.
		ghostty.call(
			"ghostty_mouse_event_set_action",
			this.#mouseEvent,
			input.action === "press" ? 0 : input.action === "release" ? 1 : 2,
		);
		const button = input.button
			? { left: 1, right: 2, middle: 3, wheelUp: 4, wheelDown: 5 }[input.button]
			: undefined;
		if (button === undefined) ghostty.call("ghostty_mouse_event_clear_button", this.#mouseEvent);
		else ghostty.call("ghostty_mouse_event_set_button", this.#mouseEvent, button);
		ghostty.call(
			"ghostty_mouse_event_set_mods",
			this.#mouseEvent,
			(input.shift ? 1 : 0) | (input.ctrl ? 2 : 0) | (input.alt ? 4 : 0),
		);
		view = ghostty.view();
		view.setFloat32(scratch + ghostty.field("GhosttyMousePosition", "x"), input.x, true);
		view.setFloat32(scratch + ghostty.field("GhosttyMousePosition", "y"), input.y, true);
		ghostty.call("ghostty_mouse_event_set_position", this.#mouseEvent, scratch);
		const out = scratch + 16;
		const result = ghostty.call(
			"ghostty_mouse_encoder_encode",
			this.#mouseEncoder,
			this.#mouseEvent,
			out,
			256,
			scratch,
		);
		if (result !== SUCCESS) return undefined;
		const length = ghostty.view().getUint32(scratch, true);
		return length ? ghostty.bytes(out, length).slice() : undefined;
	}

	/** The title programs set with OSC 0/2. */
	title(): string {
		const result = this.#ghostty.call("ghostty_terminal_get", this.handle, DATA_TITLE, this.#scratch);
		if (result !== SUCCESS) return "";
		const view = this.#ghostty.view();
		const pointer = view.getUint32(this.#scratch + this.#ghostty.field("GhosttyString", "ptr"), true);
		const length = view.getUint32(this.#scratch + this.#ghostty.field("GhosttyString", "len"), true);
		return length ? new TextDecoder().decode(this.#ghostty.bytes(pointer, length)) : "";
	}

	/** Scrollback position: rows in total, the first row shown, and rows shown. */
	scrollbar(): { total: number; offset: number; length: number } {
		this.#ghostty.call("ghostty_terminal_get", this.handle, DATA_SCROLLBAR, this.#scratch);
		const view = this.#ghostty.view();
		const field = (name: string) =>
			Number(view.getBigUint64(this.#scratch + this.#ghostty.field("GhosttyTerminalScrollbar", name), true));
		return { total: field("total"), offset: field("offset"), length: field("len") };
	}

	/** Scroll the viewport by `delta` rows (up is negative), or to the bottom. */
	scroll(delta: number | "bottom"): void {
		const type = "GhosttyTerminalScrollViewport";
		const view = this.#ghostty.view();
		this.#ghostty.bytes(this.#scratch, this.#ghostty.size(type)).fill(0);
		view.setUint32(this.#scratch + this.#ghostty.field(type, "tag"), delta === "bottom" ? 1 : 2, true);
		if (delta !== "bottom") view.setInt32(this.#scratch + this.#ghostty.field(type, "value"), delta, true);
		this.#ghostty.call("ghostty_terminal_scroll_viewport", this.handle, this.#scratch);
	}

	/**
	 * The screen with its scrollback, styles and modes as VT sequences: writing it into a fresh terminal of the same
	 * size reproduces this one, for a browser that attaches later.
	 */
	snapshot(): Uint8Array {
		return this.#format(FORMAT_VT);
	}

	/**
	 * The active screen as plain text, with the scrollback before it (the alternate screen of a full-screen program has
	 * none): soft-wrapped lines joined, trailing spaces trimmed.
	 */
	text(): string {
		return new TextDecoder().decode(this.#format(FORMAT_PLAIN));
	}

	#format(emit: number): Uint8Array {
		const ghostty = this.#ghostty;
		const scratch = this.#scratch;
		const formatter = ghostty.create("ghostty_formatter_terminal_new", this.handle);
		try {
			const set = (option: number, value: number) => {
				ghostty.view().setUint32(scratch, value, true);
				ghostty.call("ghostty_formatter_set", formatter, option, scratch);
			};
			set(FORMATTER_EMIT, emit);
			// bool values: the little-endian 1 is the byte 1.
			set(FORMATTER_UNWRAP, 1);
			set(FORMATTER_TRIM, 1);
			if (emit === FORMAT_VT) set(FORMATTER_EXTRAS, VT_EXTRAS);
			const result = ghostty.call("ghostty_formatter_format_alloc", formatter, 0, this.#scratch, this.#scratch + 4);
			if (result !== SUCCESS) throw new Error(`Formatting the terminal failed (${result})`);
			const after = ghostty.view();
			const pointer = after.getUint32(this.#scratch, true);
			const length = after.getUint32(this.#scratch + 4, true);
			const copy = ghostty.bytes(pointer, length).slice();
			ghostty.call("ghostty_free", 0, pointer, length);
			return copy;
		} finally {
			ghostty.call("ghostty_formatter_free", formatter);
		}
	}

	/** What to draw since the last frame; each frame clears the dirty state. `all` returns every row. */
	frame(all = false): Frame {
		const ghostty = this.#ghostty;
		if (!this.#render) {
			this.#render = ghostty.create("ghostty_render_state_new");
			this.#rows = ghostty.create("ghostty_render_state_row_iterator_new");
			this.#cells = ghostty.create("ghostty_render_state_row_cells_new");
		}
		const state = this.#render;
		const scratch = this.#scratch;
		ghostty.call("ghostty_render_state_update", state, this.handle);
		const dirtyValue =
			ghostty.call("ghostty_render_state_get", state, RENDER_DIRTY, scratch) === SUCCESS
				? ghostty.view().getUint32(scratch, true)
				: 2;
		const dirty = dirtyValue === 0 ? "none" : dirtyValue === 1 ? "partial" : "full";
		const sized = (data: number, type: string) => {
			const size = ghostty.size(type);
			ghostty.bytes(scratch, size).fill(0);
			ghostty.view().setUint32(scratch + ghostty.field(type, "size"), size, true);
			ghostty.call("ghostty_render_state_get", state, data, scratch);
			return ghostty.view();
		};
		const colors = "GhosttyRenderStateColors";
		let view = sized(RENDER_COLORS, colors);
		const background = rgb(view, scratch + ghostty.field(colors, "background"));
		const foreground = rgb(view, scratch + ghostty.field(colors, "foreground"));
		const cursorColor = view.getUint8(scratch + ghostty.field(colors, "cursor_has_value"))
			? rgb(view, scratch + ghostty.field(colors, "cursor"))
			: undefined;
		const cursorType = "GhosttyRenderStateCursor";
		view = sized(RENDER_CURSOR, cursorType);
		const at = (name: string) => scratch + ghostty.field(cursorType, name);
		let cursor: Frame["cursor"];
		if (view.getUint8(at("visible")) && view.getUint8(at("viewport_has_value"))) {
			const x = view.getUint16(at("viewport_x"), true);
			// GhosttyCursorStyle: bar, block, underline, block hollow.
			const style = (["bar", "block", "underline", "hollow"] as const)[view.getUint32(at("visual_style"), true)];
			cursor = {
				x: view.getUint8(at("wide_tail")) ? Math.max(0, x - 1) : x,
				y: view.getUint16(at("viewport_y"), true),
				style: style ?? "block",
				blinking: view.getUint8(at("blinking")) !== 0,
				...(cursorColor === undefined ? {} : { color: cursorColor }),
			};
		}
		const changed: Frame["changed"] = [];
		if (dirty !== "none" || all) {
			view = ghostty.view();
			view.setUint32(scratch, this.#rows, true);
			ghostty.call("ghostty_render_state_get", state, RENDER_ROW_ITERATOR, scratch);
			const style = "GhosttyStyle";
			const styleSize = ghostty.size(style);
			const styleFlags = scratch + ghostty.field(style, "flags");
			const flags: [string, number][] = [
				["bold", BOLD],
				["italic", ITALIC],
				["faint", FAINT],
				["blink", BLINK],
				["inverse", INVERSE],
				["invisible", INVISIBLE],
				["strikethrough", STRIKETHROUGH],
				["overline", OVERLINE],
			];
			const flagBits = flags.map(([name, bit]) => [1 << ghostty.bit("GhosttyStyleFlags", name), bit] as const);
			// GhosttySgrUnderline in three bits; anything but none underlines.
			const underline = 0b111 << ghostty.bit("GhosttyStyleFlags", "underline");
			for (let y = 0; ghostty.call("ghostty_render_state_row_iterator_next", this.#rows); y++) {
				ghostty.view().setUint8(scratch, 0);
				ghostty.call("ghostty_render_state_row_get", this.#rows, ROW_DIRTY, scratch);
				const rowDirty = ghostty.view().getUint8(scratch) !== 0;
				if (!(all || dirty === "full" || rowDirty)) continue;
				ghostty.call("ghostty_render_state_row_get", this.#rows, ROW_RAW, scratch);
				ghostty.call("ghostty_row_get", ghostty.view().getBigUint64(scratch, true), ROW_DATA_WRAP, scratch);
				const wrapped = ghostty.view().getUint8(scratch) !== 0;
				ghostty.view().setUint32(scratch, this.#cells, true);
				ghostty.call("ghostty_render_state_row_get", this.#rows, ROW_CELLS, scratch);
				const cells: Cell[] = [];
				let afterWide = false;
				while (ghostty.call("ghostty_render_state_row_cells_next", this.#cells)) {
					let text = "";
					let width: Cell["width"] = afterWide ? 0 : 1;
					afterWide = false;
					text = this.#cellText();
					if (text) {
						ghostty.call("ghostty_render_state_row_cells_get", this.#cells, CELL_RAW, scratch);
						const raw = ghostty.view().getBigUint64(scratch, true);
						ghostty.call("ghostty_cell_get", raw, CELL_DATA_WIDE, scratch);
						if (ghostty.view().getUint32(scratch, true) === CELL_WIDE) {
							width = 2;
							afterWide = true;
						}
					}
					let cellFlags = 0;
					let fg = -1;
					ghostty.view().setUint8(scratch, 0);
					ghostty.call("ghostty_render_state_row_cells_get", this.#cells, CELL_HAS_STYLING, scratch);
					if (ghostty.view().getUint8(scratch)) {
						ghostty.bytes(scratch, styleSize).fill(0);
						ghostty.call("ghostty_render_state_row_cells_get", this.#cells, CELL_STYLE, scratch);
						const bits = ghostty.view().getUint16(styleFlags, true);
						for (const [mask, bit] of flagBits) if (bits & mask) cellFlags |= bit;
						if (bits & underline) cellFlags |= UNDERLINE;
						if (ghostty.call("ghostty_render_state_row_cells_get", this.#cells, CELL_FG, scratch) === SUCCESS)
							fg = rgb(ghostty.view(), scratch);
					}
					const bg =
						ghostty.call("ghostty_render_state_row_cells_get", this.#cells, CELL_BG, scratch) === SUCCESS
							? rgb(ghostty.view(), scratch)
							: -1;
					cells.push({ text, width, fg, bg, flags: cellFlags });
				}
				changed.push({ y, cells, wrapped });
			}
			ghostty.call("ghostty_render_state_clean", state);
		}
		return {
			dirty,
			cols: this.cols,
			rows: this.rows,
			foreground,
			background,
			...(cursor ? { cursor } : {}),
			changed,
		};
	}

	/** The text of the row cells' current cell: its grapheme cluster, "" when it has none. */
	#cellText(): string {
		const ghostty = this.#ghostty;
		const type = "GhosttyBuffer";
		const buffer = this.#scratch;
		const read = (pointer: number, capacity: number) => {
			const view = ghostty.view();
			view.setUint32(buffer + ghostty.field(type, "ptr"), pointer, true);
			view.setUint32(buffer + ghostty.field(type, "cap"), capacity, true);
			view.setUint32(buffer + ghostty.field(type, "len"), 0, true);
			const result = ghostty.call("ghostty_render_state_row_cells_get", this.#cells, CELL_GRAPHEMES_UTF8, buffer);
			return { result, length: ghostty.view().getUint32(buffer + ghostty.field(type, "len"), true) };
		};
		const first = read(this.#graphemes, GRAPHEME_BYTES);
		if (first.result === SUCCESS) return utf8.decode(ghostty.bytes(this.#graphemes, first.length));
		if (first.result !== OUT_OF_SPACE) return "";
		// A long cluster (many combining marks): `length` is the size it needs.
		const pointer = ghostty.alloc(first.length);
		try {
			const second = read(pointer, first.length);
			return second.result === SUCCESS ? utf8.decode(ghostty.bytes(pointer, second.length)) : "";
		} finally {
			ghostty.free(pointer, first.length);
		}
	}

	/** The bytes a key press sends in the terminal's current modes; undefined when it sends nothing. */
	encodeKey(input: KeyInput): Uint8Array | undefined {
		const ghostty = this.#ghostty;
		if (!this.#encoder) {
			this.#encoder = ghostty.create("ghostty_key_encoder_new");
			this.#event = ghostty.create("ghostty_key_event_new");
		}
		const key = KEY_CODES.get(input.code) ?? 0;
		const characters = [...input.key];
		const character = characters.length === 1 ? characters[0] : undefined;
		const code = character?.codePointAt(0) ?? 0;
		const printable = character !== undefined && code >= 0x20 && code !== 0x7f;
		if (!key && !printable) return undefined;
		ghostty.call("ghostty_key_encoder_set_from_terminal", this.#encoder, this.handle);
		ghostty.call("ghostty_key_event_set_action", this.#event, input.repeat ? 2 : 1);
		ghostty.call("ghostty_key_event_set_key", this.#event, key);
		ghostty.call(
			"ghostty_key_event_set_mods",
			this.#event,
			(input.shift ? 1 : 0) | (input.ctrl ? 2 : 0) | (input.alt ? 4 : 0) | (input.meta ? 8 : 0),
		);
		const unshifted = input.code.startsWith("Key")
			? input.code.slice(3).toLowerCase()
			: input.code.startsWith("Digit")
				? input.code.slice(5)
				: printable
					? character.toLowerCase()
					: "";
		ghostty.call("ghostty_key_event_set_unshifted_codepoint", this.#event, unshifted.codePointAt(0) ?? 0);
		const bytes = printable ? new TextEncoder().encode(character) : new Uint8Array(0);
		// The text and the GhosttyString pointing at it (by value: a pointer on wasm32) live in scratch space past the
		// encoder's output; the event borrows the text until it is cleared again.
		const text = this.#scratch + 512;
		const string = this.#scratch + 520;
		const setText = (pointer: number, length: number) => {
			const view = ghostty.view();
			view.setUint32(string + ghostty.field("GhosttyString", "ptr"), pointer, true);
			view.setUint32(string + ghostty.field("GhosttyString", "len"), length, true);
			ghostty.call("ghostty_key_event_set_utf8", this.#event, string);
		};
		ghostty.bytes(text, bytes.length).set(bytes);
		setText(bytes.length ? text : 0, bytes.length);
		const out = this.#scratch + 8;
		const result = ghostty.call("ghostty_key_encoder_encode", this.#encoder, this.#event, out, 256, this.#scratch);
		setText(0, 0);
		if (result !== SUCCESS) return undefined;
		const length = ghostty.view().getUint32(this.#scratch, true);
		return length ? ghostty.bytes(out, length).slice() : undefined;
	}

	/** Pasted text as the program should receive it: control bytes made safe, bracketed when the program asked. */
	encodePaste(text: string): Uint8Array {
		const ghostty = this.#ghostty;
		const data = new TextEncoder().encode(text);
		const input = ghostty.alloc(Math.max(1, data.length));
		let capacity = data.length + 16;
		try {
			ghostty.bytes(input, data.length).set(data);
			const bracketed = this.mode(2004) ? 1 : 0;
			for (;;) {
				const size = capacity;
				const output = ghostty.alloc(size);
				try {
					const result = ghostty.call(
						"ghostty_paste_encode",
						input,
						data.length,
						bracketed,
						output,
						size,
						this.#scratch,
					);
					const written = ghostty.view().getUint32(this.#scratch, true);
					if (result === OUT_OF_SPACE && written > size) {
						capacity = written;
						continue;
					}
					if (result !== SUCCESS) throw new Error(`Encoding the paste failed (${result})`);
					return ghostty.bytes(output, written).slice();
				} finally {
					ghostty.free(output, size);
				}
			}
		} finally {
			ghostty.free(input, Math.max(1, data.length));
		}
	}

	free(): void {
		if (this.#freed) return;
		this.#freed = true;
		const ghostty = this.#ghostty;
		ghostty.forget(this.handle);
		if (this.#render) {
			ghostty.call("ghostty_render_state_row_cells_free", this.#cells);
			ghostty.call("ghostty_render_state_row_iterator_free", this.#rows);
			ghostty.call("ghostty_render_state_free", this.#render);
		}
		if (this.#encoder) {
			ghostty.call("ghostty_key_event_free", this.#event);
			ghostty.call("ghostty_key_encoder_free", this.#encoder);
		}
		if (this.#mouseEncoder) {
			ghostty.call("ghostty_mouse_event_free", this.#mouseEvent);
			ghostty.call("ghostty_mouse_encoder_free", this.#mouseEncoder);
		}
		ghostty.free(this.#scratch, SCRATCH);
		ghostty.free(this.#graphemes, GRAPHEME_BYTES);
		ghostty.call("ghostty_terminal_free", this.handle);
	}
}
