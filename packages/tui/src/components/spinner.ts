export interface SpinnerOptions {
	/** Animation frames. Use an empty array to hide the indicator. */
	frames?: string[];
	/** Frame interval in milliseconds for animated indicators. */
	intervalMs?: number;
}

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL_MS = 80;

/** Drives an optional animated spinner and calls back whenever the frame changes. */
export class Spinner {
	private frames!: string[];
	private intervalMs!: number;
	private currentFrame = 0;
	private intervalId: NodeJS.Timeout | undefined;
	private customIndicator = false;
	private onUpdate: () => void;

	constructor(onUpdate: () => void, options?: SpinnerOptions) {
		this.onUpdate = onUpdate;
		this.configure(options);
	}

	get frame(): string {
		return this.frames[this.currentFrame] ?? "";
	}

	renderFrame(defaultColorFn: (frame: string) => string): string {
		const frame = this.frame;
		if (!frame) return "";
		return this.customIndicator ? frame : defaultColorFn(frame);
	}

	start(): void {
		this.onUpdate();
		this.restartAnimation();
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}

	setOptions(options?: SpinnerOptions): void {
		this.configure(options);
		this.start();
	}

	private configure(options?: SpinnerOptions): void {
		this.customIndicator = options !== undefined;
		this.frames = options?.frames !== undefined ? [...options.frames] : [...DEFAULT_FRAMES];
		this.intervalMs = options?.intervalMs && options.intervalMs > 0 ? options.intervalMs : DEFAULT_INTERVAL_MS;
		this.currentFrame = 0;
	}

	private restartAnimation(): void {
		this.stop();
		if (this.frames.length <= 1) {
			return;
		}
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.onUpdate();
		}, this.intervalMs);
	}
}
