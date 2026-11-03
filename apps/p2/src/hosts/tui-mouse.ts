// The launcher's view of the mouse (p2-tui-port.md section 3.1 rule 5): mouse reports go to the worker as input
// (pi-tui scrolls and selects there), and the launcher recognizes, from the raw SGR reports alone, the release that
// ends a selection gesture: a drag with the left button, or a double/triple click. Only that gesture copies.

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR mouse reports.
const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const MULTI_CLICK_MS = 500;

export class SelectionGesture {
	private pressed: { x: number; y: number; clicks: number } | undefined;
	private moved = false;
	private last: { x: number; y: number; time: number; clicks: number } | undefined;
	/** Feeds raw input; true when it holds the left-button release that ends a drag or a multi-click. */
	feed(data: string, now = Date.now()): boolean {
		let gesture = false;
		for (const match of data.matchAll(SGR_MOUSE)) {
			const code = Number(match[1]);
			const x = Number(match[2]);
			const y = Number(match[3]);
			const release = match[4] === "m";
			const wheel = (code & 64) !== 0;
			const motion = (code & 32) !== 0;
			const left = (code & 3) === 0;
			if (wheel || !left) continue;
			if (release) {
				if (this.pressed) gesture ||= this.moved || this.pressed.clicks >= 2;
				this.pressed = undefined;
			} else if (motion) {
				if (this.pressed && (x !== this.pressed.x || y !== this.pressed.y)) this.moved = true;
			} else {
				const last = this.last;
				const clicks =
					last && now - last.time <= MULTI_CLICK_MS && Math.abs(last.x - x) <= 1 && last.y === y
						? last.clicks + 1
						: 1;
				this.pressed = { x, y, clicks };
				this.last = { x, y, time: now, clicks };
				this.moved = false;
			}
		}
		return gesture;
	}
}
