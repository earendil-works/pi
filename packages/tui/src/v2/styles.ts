export type TerminalColor =
	| { kind: "default" }
	| { kind: "indexed"; index: number }
	| { kind: "rgb"; red: number; green: number; blue: number };

export interface TextStyle {
	foreground: TerminalColor;
	background: TerminalColor;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	blink: boolean;
	inverse: boolean;
	hidden: boolean;
	strikethrough: boolean;
}

export interface Span {
	text: string;
	style: TextStyle;
	link?: string;
}

export type StyledLine = Span[];

export const DEFAULT_TEXT_STYLE: TextStyle = Object.freeze({
	foreground: Object.freeze({ kind: "default" }),
	background: Object.freeze({ kind: "default" }),
	bold: false,
	dim: false,
	italic: false,
	underline: false,
	blink: false,
	inverse: false,
	hidden: false,
	strikethrough: false,
});

function normalizeChannel(channel: number): number {
	return Math.max(0, Math.min(255, Math.trunc(channel)));
}

function normalizeColor(color: TerminalColor): TerminalColor {
	switch (color.kind) {
		case "default":
			return { kind: "default" };
		case "indexed":
			return { kind: "indexed", index: normalizeChannel(color.index) };
		case "rgb":
			return {
				kind: "rgb",
				red: normalizeChannel(color.red),
				green: normalizeChannel(color.green),
				blue: normalizeChannel(color.blue),
			};
	}
}

function normalizeStyle(style: TextStyle): TextStyle {
	return Object.freeze({
		foreground: Object.freeze(normalizeColor(style.foreground)),
		background: Object.freeze(normalizeColor(style.background)),
		bold: Boolean(style.bold),
		dim: Boolean(style.dim),
		italic: Boolean(style.italic),
		underline: Boolean(style.underline),
		blink: Boolean(style.blink),
		inverse: Boolean(style.inverse),
		hidden: Boolean(style.hidden),
		strikethrough: Boolean(style.strikethrough),
	});
}

function colorKey(color: TerminalColor): string {
	switch (color.kind) {
		case "default":
			return "d";
		case "indexed":
			return `i:${normalizeChannel(color.index)}`;
		case "rgb":
			return `r:${normalizeChannel(color.red)},${normalizeChannel(color.green)},${normalizeChannel(color.blue)}`;
	}
}

function styleKey(style: TextStyle): string {
	return [
		colorKey(style.foreground),
		colorKey(style.background),
		style.bold,
		style.dim,
		style.italic,
		style.underline,
		style.blink,
		style.inverse,
		style.hidden,
		style.strikethrough,
	].join("|");
}

/** Frame-local or host-local style interning. Style id 0 is always the default style. */
export class StyleTable {
	private readonly styles: TextStyle[] = [DEFAULT_TEXT_STYLE];
	private readonly ids = new Map<string, number>([[styleKey(DEFAULT_TEXT_STYLE), 0]]);

	intern(style: TextStyle): number {
		const key = styleKey(style);
		const existing = this.ids.get(key);
		if (existing !== undefined) return existing;
		const id = this.styles.length;
		this.styles.push(normalizeStyle(style));
		this.ids.set(key, id);
		return id;
	}

	get(id: number): TextStyle {
		return this.styles[id] ?? DEFAULT_TEXT_STYLE;
	}

	get size(): number {
		return this.styles.length;
	}
}

export function plainLine(text: string): StyledLine {
	return [{ text, style: DEFAULT_TEXT_STYLE }];
}
