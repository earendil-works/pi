export type MouseButton = "left";

export type ParsedMouseEvent = {
	kind: "press";
	button: MouseButton;
	row: number;
	col: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	raw: string;
};

export function parseSgrMouseEvent(data: string): ParsedMouseEvent | undefined {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return undefined;

	const [, rawCode, rawCol, rawRow, suffix] = match;
	if (suffix !== "M") return undefined;

	const code = Number.parseInt(rawCode, 10);
	const col = Number.parseInt(rawCol, 10);
	const row = Number.parseInt(rawRow, 10);
	if (!Number.isFinite(code) || !Number.isFinite(col) || !Number.isFinite(row)) return undefined;

	const buttonBits = code & 0b11;
	const motionBit = code & 0b100000;
	const wheelBit = code & 0b1000000;
	if (motionBit !== 0 || wheelBit !== 0) return undefined;
	if (buttonBits !== 0) return undefined;

	return {
		kind: "press",
		button: "left",
		row: Math.max(0, row - 1),
		col: Math.max(0, col - 1),
		shift: (code & 0b100) !== 0,
		alt: (code & 0b1000) !== 0,
		ctrl: (code & 0b10000) !== 0,
		raw: data,
	};
}
