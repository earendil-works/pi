import type { TUI } from "../tui.js";
import { Text } from "./text.js";

/**
 * Loader component that updates every 80ms with spinning animation
 */
export class Loader extends Text {
	// Matrix rain (up)
	private patterns = [["⣀", "⣠", "⣴", "⣾", "⣿", "⣷", "⣧", "⣇", "⡇"]];
	private currentPattern = 0;
	private currentFrame = 0;
	private patternLoops = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI | null = null;

	constructor(
		ui: TUI,
		private spinnerColorFn: (str: string) => string,
		private messageColorFn: (str: string) => string,
		private message: string = "Loading...",
	) {
		super("", 1, 0);
		this.ui = ui;
		this.start();
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start() {
		this.updateDisplay();
		this.intervalId = setInterval(() => {
			const frames = this.patterns[this.currentPattern];
			this.currentFrame = (this.currentFrame + 1) % frames.length;

			// After completing 2 loops of current pattern, switch to next
			if (this.currentFrame === 0) {
				this.patternLoops++;
				if (this.patternLoops >= 2) {
					this.patternLoops = 0;
					this.currentPattern = (this.currentPattern + 1) % this.patterns.length;
				}
			}

			this.updateDisplay();
		}, 80);
	}

	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setMessage(message: string) {
		this.message = message;
		this.updateDisplay();
	}

	private updateDisplay() {
		const frames = this.patterns[this.currentPattern];
		const frame = frames[this.currentFrame];
		this.setText(`${this.spinnerColorFn(frame)} ${this.messageColorFn(this.message)}`);
		if (this.ui) {
			// IMPORTANT: loader updates are effectively "animation" frames. Rendering them via
			// requestRender() maps to reason "other", which cancels stream throttling.
			// During assistant streaming, that can increase render frequency and cause UI lag.
			//
			// We treat loader renders as stream-throttled renders so they coalesce with
			// in-flight streaming frames instead of resetting the throttle window.
			this.ui.requestRenderWithReason("stream");
		}
	}
}
