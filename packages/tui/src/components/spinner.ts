export interface SpinnerOptions {
	/** Animation frames. Use an empty array to hide the indicator. */
	frames?: readonly string[];
	/** Frame interval in milliseconds for animated indicators. */
	intervalMs?: number;
}

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL_MS = 80;

/**
 * Tracks spinner frames and requests updates while active.
 * Calls onUpdate when rendered output may need to change: on start, active option changes, and each animation tick.
 * Call stop() when the spinner is no longer needed to clear the animation timer.
 */
export class Spinner {
	private frames: string[] = [...DEFAULT_FRAMES];
	private intervalMs = DEFAULT_INTERVAL_MS;
	private currentFrame = 0;
	private active = false;
	private intervalId: ReturnType<typeof setInterval> | undefined;
	private onUpdate: () => void;

	constructor(onUpdate: () => void, options?: SpinnerOptions) {
		this.onUpdate = onUpdate;
		this.applyOptions(options);
	}

	renderText(): string {
		return this.frames[this.currentFrame] ?? "";
	}

	isActive(): boolean {
		return this.active;
	}

	start(): void {
		this.currentFrame = 0;
		this.active = true;
		this.onUpdate();
		this.restartAnimation();
	}

	/** Stops frame advancement and clears the timer. The current frame remains renderable. */
	stop(): void {
		this.active = false;
		this.clearAnimation();
	}

	setOptions(options?: SpinnerOptions): void {
		this.applyOptions(options);
		if (this.active) {
			this.onUpdate();
			this.restartAnimation();
		}
	}

	private applyOptions(options?: SpinnerOptions): void {
		const frames = options?.frames !== undefined ? [...options.frames] : [...DEFAULT_FRAMES];
		const framesChanged =
			frames.length !== this.frames.length || frames.some((frame, index) => frame !== this.frames[index]);
		this.frames = frames;
		this.intervalMs = options?.intervalMs && options.intervalMs > 0 ? options.intervalMs : DEFAULT_INTERVAL_MS;
		if (framesChanged) {
			this.currentFrame = 0;
		}
	}

	private clearAnimation(): void {
		if (this.intervalId !== undefined) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}

	private restartAnimation(): void {
		this.clearAnimation();
		if (this.frames.length <= 1) {
			return;
		}
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.onUpdate();
		}, this.intervalMs);
	}
}

/**
 * Combines a spinner with a message for inline status rendering.
 * Default frames are passed through spinnerColorFn; custom frames render verbatim.
 */
export class SpinnerStatus {
	private message = "";

	// We only color the spinner when it uses the default frames. Custom frames should include their own styling.
	private hasCustomFrames = false;
	private onUpdate: () => void;
	private spinnerColorFn: (frame: string) => string;
	private spinner: Spinner;

	constructor(
		onUpdate: () => void,
		spinnerColorFn: (frame: string) => string,
		message = "",
		options?: SpinnerOptions,
	) {
		this.onUpdate = onUpdate;
		this.spinnerColorFn = spinnerColorFn;
		this.message = message;
		this.hasCustomFrames = options?.frames !== undefined;
		this.spinner = new Spinner(onUpdate, options);
	}

	start(): void {
		this.spinner.start();
	}

	setMessage(message: string): void {
		this.message = message;
		if (this.spinner.isActive()) {
			this.onUpdate();
		}
	}

	setOptions(options?: SpinnerOptions): void {
		this.hasCustomFrames = options?.frames !== undefined;
		this.spinner.setOptions(options);
	}

	stop(): void {
		this.spinner.stop();
	}

	renderText(): string {
		const frame = this.spinner.renderText();
		const renderedIndicator = frame && !this.hasCustomFrames ? this.spinnerColorFn(frame) : frame;
		const prefix = renderedIndicator ? `${renderedIndicator} ` : "";
		return `${prefix}${this.message}`;
	}
}
