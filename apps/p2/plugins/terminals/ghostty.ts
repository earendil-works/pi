// Bindings for libghostty-vt (./vendor/ghostty), loaded by the browser's terminal view and by the terminal host's
// headless copies of each terminal. Plain WebAssembly: pointers and size_t are 32-bit, struct layouts come from
// ghostty_type_json(), and structs passed by value travel as pointers (the wasm32 C ABI).

type Fn = (...args: (number | bigint)[]) => number;
type Layout = Record<string, { size: number; fields: Record<string, { offset: number; size: number }> }>;

const SUCCESS = 0;
const OUT_OF_SPACE = -3;

// GhosttyTerminalOption
const OPT_WRITE_PTY = 1;
const OPT_COLOR_SCHEME = 7;
const OPT_COLOR_FOREGROUND = 11;
const OPT_COLOR_BACKGROUND = 12;
const OPT_COLOR_CURSOR = 13;
// GhosttyTerminalData
const DATA_ACTIVE_SCREEN = 6;
const DATA_MOUSE_TRACKING = 11;
const DATA_SCROLLBAR = 9;
const DATA_TITLE = 12;
// GhosttyRenderStateData
const RENDER_DIRTY = 3;
const RENDER_ROW_ITERATOR = 4;
const RENDER_CURSOR_STYLE = 10;
const RENDER_CURSOR_VISIBLE = 11;
const RENDER_CURSOR_BLINKING = 12;
const RENDER_CURSOR_IN_VIEWPORT = 14;
const RENDER_CURSOR_X = 15;
const RENDER_CURSOR_Y = 16;
const RENDER_CURSOR_WIDE_TAIL = 17;
const ROW_DIRTY = 1;
const ROW_RAW = 2;
const ROW_CELLS = 3;
// GhosttyRowData
const ROW_DATA_WRAP = 1;
const CELL_RAW = 1;
const CELL_STYLE = 2;
const CELL_GRAPHEMES_LEN = 3;
const CELL_GRAPHEMES_BUF = 4;
const CELL_BG = 5;
const CELL_FG = 6;
const CELL_HAS_STYLING = 8;
// GhosttyFormatterFormat
const FORMAT_PLAIN = 0;
const FORMAT_VT = 1;
// GhosttyCellData, GhosttyCellWide
const CELL_DATA_WIDE = 3;
const CELL_WIDE = 1;
const MAX_GRAPHEME = 32;

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
		this.#layout = JSON.parse(new TextDecoder().decode(bytes.subarray(json, end))) as Layout;
		const table = instance.exports.__indirect_function_table as WebAssembly.Table;
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
		let memory: WebAssembly.Memory | undefined;
		const imports = {
			env: {
				log: (pointer: number, length: number) => {
					if (memory)
						console.debug("[ghostty]", new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length)));
				},
			},
		};
		const instance =
			source instanceof WebAssembly.Module
				? await WebAssembly.instantiate(source, imports)
				: (await WebAssembly.instantiate(source, imports)).instance;
		memory = instance.exports.memory as WebAssembly.Memory;
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
		const field = this.#layout[type]?.fields[name];
		if (!field) throw new Error(`libghostty-vt has no ${type}.${name}`);
		return field.offset;
	}

	/** @internal */
	size(type: string): number {
		const layout = this.#layout[type];
		if (!layout) throw new Error(`libghostty-vt has no ${type}`);
		return layout.size;
	}

	/** @internal Allocate `length` zeroed bytes. */
	alloc(length: number): number {
		const pointer = this.call("ghostty_wasm_alloc_u8_array", length);
		if (!pointer) throw new Error("libghostty-vt is out of memory");
		this.bytes(pointer, length).fill(0);
		return pointer;
	}

	/** @internal */
	free(pointer: number, length: number): void {
		this.call("ghostty_wasm_free_u8_array", pointer, length);
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
		const type = "GhosttyTerminalOptions";
		const size = ghostty.size(type);
		const pointer = ghostty.alloc(size);
		try {
			const view = ghostty.view();
			view.setUint16(pointer + ghostty.field(type, "cols"), options.cols, true);
			view.setUint16(pointer + ghostty.field(type, "rows"), options.rows, true);
			view.setUint32(pointer + ghostty.field(type, "max_scrollback"), options.scrollback, true);
			this.handle = ghostty.create("ghostty_terminal_new", pointer);
		} finally {
			ghostty.free(pointer, size);
		}
		this.#scratch = ghostty.alloc(SCRATCH);
		this.#graphemes = ghostty.alloc(MAX_GRAPHEME * 4);
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
		const mode = (value & 0x7fff) | (ansi ? 0x8000 : 0);
		this.#ghostty.view().setUint8(this.#scratch, 0);
		this.#ghostty.call("ghostty_terminal_mode_get", this.handle, mode, this.#scratch);
		return this.#ghostty.view().getUint8(this.#scratch) !== 0;
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
			ghostty.call("ghostty_mouse_encoder_setopt", this.#mouseEncoder, 4, this.#scratch);
		}
		ghostty.call("ghostty_mouse_encoder_setopt_from_terminal", this.#mouseEncoder, this.handle);
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
		ghostty.call("ghostty_mouse_encoder_setopt", this.#mouseEncoder, 2, scratch);
		// Motion with a button held is reported in button-event mode (1002) too.
		view = ghostty.view();
		view.setUint8(scratch, input.action === "motion" && input.button ? 1 : 0);
		ghostty.call("ghostty_mouse_encoder_setopt", this.#mouseEncoder, 3, scratch);
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
		const type = "GhosttyFormatterTerminalOptions";
		const size = ghostty.size(type);
		const options = ghostty.alloc(size);
		let formatter = 0;
		try {
			const view = ghostty.view();
			const extra = options + ghostty.field(type, "extra");
			const screen = extra + ghostty.field("GhosttyFormatterTerminalExtra", "screen");
			const flag = (base: number, struct: string, name: string) =>
				view.setUint8(base + ghostty.field(struct, name), 1);
			view.setUint32(options + ghostty.field(type, "size"), size, true);
			view.setUint32(options + ghostty.field(type, "emit"), emit, true);
			flag(options, type, "unwrap");
			flag(options, type, "trim");
			view.setUint32(
				extra + ghostty.field("GhosttyFormatterTerminalExtra", "size"),
				ghostty.size("GhosttyFormatterTerminalExtra"),
				true,
			);
			view.setUint32(
				screen + ghostty.field("GhosttyFormatterScreenExtra", "size"),
				ghostty.size("GhosttyFormatterScreenExtra"),
				true,
			);
			if (emit === FORMAT_VT) {
				// Not `tabstops`: the formatter emits them after the cursor position, moving the cursor (programs rarely
				// change the default stops anyway).
				for (const name of ["modes", "scrolling_region", "pwd", "keyboard"])
					flag(extra, "GhosttyFormatterTerminalExtra", name);
				for (const name of ["cursor", "style", "hyperlink", "protection", "kitty_keyboard", "charsets"])
					flag(screen, "GhosttyFormatterScreenExtra", name);
			}
			formatter = ghostty.create("ghostty_formatter_terminal_new", this.handle, options);
			const result = ghostty.call("ghostty_formatter_format_alloc", formatter, 0, this.#scratch, this.#scratch + 4);
			if (result !== SUCCESS) throw new Error(`Formatting the terminal failed (${result})`);
			const after = ghostty.view();
			const pointer = after.getUint32(this.#scratch, true);
			const length = after.getUint32(this.#scratch + 4, true);
			const copy = ghostty.bytes(pointer, length).slice();
			ghostty.call("ghostty_free", 0, pointer, length);
			return copy;
		} finally {
			if (formatter) ghostty.call("ghostty_formatter_free", formatter);
			ghostty.free(options, size);
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
		const get = (data: number) => {
			ghostty.view().setUint32(scratch, 0, true);
			const result = ghostty.call("ghostty_render_state_get", state, data, scratch);
			return result === SUCCESS ? ghostty.view() : undefined;
		};
		const dirtyValue = get(RENDER_DIRTY)?.getUint32(scratch, true) ?? 2;
		const dirty = dirtyValue === 0 ? "none" : dirtyValue === 1 ? "partial" : "full";
		const type = "GhosttyRenderStateColors";
		const colorsSize = ghostty.size(type);
		ghostty.bytes(scratch, colorsSize).fill(0);
		ghostty.view().setUint32(scratch + ghostty.field(type, "size"), colorsSize, true);
		ghostty.call("ghostty_render_state_colors_get", state, scratch);
		let view = ghostty.view();
		const background = rgb(view, scratch + ghostty.field(type, "background"));
		const foreground = rgb(view, scratch + ghostty.field(type, "foreground"));
		const cursorColor = view.getUint8(scratch + ghostty.field(type, "cursor_has_value"))
			? rgb(view, scratch + ghostty.field(type, "cursor"))
			: undefined;
		let cursor: Frame["cursor"];
		if (get(RENDER_CURSOR_VISIBLE)?.getUint8(scratch) && get(RENDER_CURSOR_IN_VIEWPORT)?.getUint8(scratch)) {
			const x = get(RENDER_CURSOR_X)?.getUint16(scratch, true) ?? 0;
			const y = get(RENDER_CURSOR_Y)?.getUint16(scratch, true) ?? 0;
			const wideTail = Boolean(get(RENDER_CURSOR_WIDE_TAIL)?.getUint8(scratch));
			const style = (["bar", "block", "underline", "hollow"] as const)[
				get(RENDER_CURSOR_STYLE)?.getUint32(scratch, true) ?? 1
			];
			cursor = {
				x: wideTail ? Math.max(0, x - 1) : x,
				y,
				style: style ?? "block",
				blinking: Boolean(get(RENDER_CURSOR_BLINKING)?.getUint8(scratch)),
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
			const flagOffsets = flags.map(([name, bit]) => [ghostty.field(style, name), bit] as const);
			const underline = ghostty.field(style, "underline");
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
					ghostty.call("ghostty_render_state_row_cells_get", this.#cells, CELL_GRAPHEMES_LEN, scratch);
					const length = Math.min(ghostty.view().getUint32(scratch, true), MAX_GRAPHEME);
					if (length > 0) {
						ghostty.call("ghostty_render_state_row_cells_get", this.#cells, CELL_GRAPHEMES_BUF, this.#graphemes);
						const codes = new Uint32Array(length);
						const graphemes = ghostty.view();
						for (let index = 0; index < length; index++)
							codes[index] = graphemes.getUint32(this.#graphemes + index * 4, true);
						text = String.fromCodePoint(...codes);
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
						ghostty.view().setUint32(scratch + ghostty.field(style, "size"), styleSize, true);
						ghostty.call("ghostty_render_state_row_cells_get", this.#cells, CELL_STYLE, scratch);
						const styled = ghostty.view();
						for (const [offset, bit] of flagOffsets) if (styled.getUint8(scratch + offset)) cellFlags |= bit;
						if (styled.getInt32(scratch + underline, true) !== 0) cellFlags |= UNDERLINE;
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
				ghostty.view().setUint8(scratch, 0);
				ghostty.call("ghostty_render_state_row_set", this.#rows, 0, scratch);
			}
			ghostty.view().setUint32(scratch, 0, true);
			ghostty.call("ghostty_render_state_set", state, 0, scratch);
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
		ghostty.call("ghostty_key_encoder_setopt_from_terminal", this.#encoder, this.handle);
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
		const utf8 = printable ? new TextEncoder().encode(character) : new Uint8Array(0);
		// The text lives in scratch space past the encoder's output.
		const text = this.#scratch + 512;
		ghostty.bytes(text, utf8.length).set(utf8);
		ghostty.call("ghostty_key_event_set_utf8", this.#event, utf8.length ? text : 0, utf8.length);
		const out = this.#scratch + 8;
		const result = ghostty.call("ghostty_key_encoder_encode", this.#encoder, this.#event, out, 256, this.#scratch);
		ghostty.call("ghostty_key_event_set_utf8", this.#event, 0, 0);
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
		ghostty.free(this.#graphemes, MAX_GRAPHEME * 4);
		ghostty.call("ghostty_terminal_free", this.handle);
	}
}
