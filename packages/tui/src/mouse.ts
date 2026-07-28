export type MouseButton = "left" | "middle" | "right";

type MouseModifiers = {
	x: number;
	y: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
};

export type TuiMouseEvent =
	| (MouseModifiers & { type: "press" | "release" | "move"; button: MouseButton })
	| (MouseModifiers & { type: "wheel"; direction: "up" | "down" });

const BUTTONS: readonly MouseButton[] = ["left", "middle", "right"];

/** Parse an SGR mouse sequence into a zero-based terminal event. */
export function parseMouseInput(data: string): TuiMouseEvent | undefined {
	const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return undefined;

	const code = Number.parseInt(match[1]!, 10);
	const x = Math.max(0, Number.parseInt(match[2]!, 10) - 1);
	const y = Math.max(0, Number.parseInt(match[3]!, 10) - 1);
	const modifiers = {
		x,
		y,
		shift: (code & 4) !== 0,
		alt: (code & 8) !== 0,
		ctrl: (code & 16) !== 0,
	};

	const buttonCode = code & 3;
	if ((code & 64) !== 0) {
		if (buttonCode > 1) return undefined;
		return { ...modifiers, type: "wheel", direction: buttonCode === 0 ? "up" : "down" };
	}

	const button = BUTTONS[buttonCode];
	if (!button) return undefined;
	if (match[4] === "m") return { ...modifiers, type: "release", button };
	return { ...modifiers, type: (code & 32) !== 0 ? "move" : "press", button };
}
