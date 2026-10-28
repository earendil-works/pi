/** Lines moved per mouse-wheel event, or `"auto"` to accelerate fast wheel spins. */
export type WheelScrollLines = number | "auto";

// Several events closer than this belong to one physical notch (Ghostty emits them ~4 ms apart)
// or come from a high-resolution source. They move one line each and do not accelerate.
const BURST_GAP_MS = 5;
// A pause longer than this ends a scroll gesture.
const GESTURE_GAP_MS = 200;
// Average event gap that maps to one line per event. Faster events scale up proportionally.
const REFERENCE_GAP_MS = 100;
const MAX_AUTO_LINES = 6;

/**
 * Local macOS terminals receive wheel and trackpad deltas that the OS has already accelerated,
 * and they emit one event per line. Other platforms, and SSH sessions where the client platform
 * is unknown, usually send one event per wheel notch.
 */
function terminalAcceleratesWheel(): boolean {
	const env = process.env;
	return (
		process.platform === "darwin" &&
		env.SSH_CONNECTION === undefined &&
		env.SSH_CLIENT === undefined &&
		env.SSH_TTY === undefined
	);
}

/**
 * Converts wheel events into line counts.
 *
 * In `"auto"` mode on terminals that do not accelerate wheel input, the count follows event
 * velocity: an isolated notch moves one line, while a fast spin moves up to six lines per event.
 * For example, notches 100 ms apart move 1 line each, 50 ms apart move 2, and 20 ms apart move 5.
 */
export class WheelScrollAccelerator {
	private lines: WheelScrollLines;
	private readonly accelerate: boolean;
	private lastTime = Number.NEGATIVE_INFINITY;
	private lastDirection = 0;
	private averageGap: number | undefined;
	private carry = 0;

	constructor(lines: WheelScrollLines = "auto", accelerate = !terminalAcceleratesWheel()) {
		this.lines = lines;
		this.accelerate = accelerate;
	}

	setLines(lines: WheelScrollLines): void {
		this.lines = lines;
		this.reset();
	}

	/** Return the positive line count for a wheel event in `direction` at time `now` (milliseconds). */
	next(direction: -1 | 1, now: number): number {
		if (this.lines !== "auto") return Number.isFinite(this.lines) ? Math.max(1, Math.floor(this.lines)) : 1;
		if (!this.accelerate) return 1;

		const gap = now - this.lastTime;
		const sameGesture = direction === this.lastDirection && gap <= GESTURE_GAP_MS;
		this.lastTime = now;
		this.lastDirection = direction;
		if (!sameGesture) {
			this.averageGap = undefined;
			this.carry = 0;
			return 1;
		}
		if (gap < BURST_GAP_MS) return 1;

		this.averageGap = this.averageGap === undefined ? gap : (this.averageGap + gap) / 2;
		const lines = Math.min(MAX_AUTO_LINES, Math.max(1, REFERENCE_GAP_MS / this.averageGap)) + this.carry;
		const whole = Math.floor(lines);
		this.carry = lines - whole;
		return whole;
	}

	private reset(): void {
		this.lastTime = Number.NEGATIVE_INFINITY;
		this.lastDirection = 0;
		this.averageGap = undefined;
		this.carry = 0;
	}
}
