export interface FrameClock {
	now(): number;
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface FrameRequest {
	readonly now: number;
	readonly forced: boolean;
}

export type FrameCallback = (request: FrameRequest) => void;

export const systemFrameClock: FrameClock = {
	now: () => performance.now(),
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Coalesces dirty events into bounded-rate frames while preserving a forced-redraw escape hatch. */
export class FrameScheduler {
	private timer: unknown;
	private requested = false;
	private forced = false;
	private running = false;
	private lastFrameAt = Number.NEGATIVE_INFINITY;
	private readonly render: FrameCallback;
	private readonly clock: FrameClock;
	private readonly minimumIntervalMs: number;

	constructor(render: FrameCallback, clock: FrameClock = systemFrameClock, minimumIntervalMs = 16) {
		this.render = render;
		this.clock = clock;
		this.minimumIntervalMs = minimumIntervalMs;
	}

	requestFrame(force = false): void {
		this.requested = true;
		this.forced ||= force;
		if (force && this.timer !== undefined) {
			this.clock.clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.schedule();
	}

	cancel(): void {
		if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
		this.timer = undefined;
		this.requested = false;
		this.forced = false;
	}

	get pending(): boolean {
		return this.requested || this.timer !== undefined;
	}

	private schedule(): void {
		if (this.running || this.timer !== undefined || !this.requested) return;
		const delay = this.forced ? 0 : Math.max(0, this.minimumIntervalMs - (this.clock.now() - this.lastFrameAt));
		this.timer = this.clock.setTimeout(() => {
			this.timer = undefined;
			if (!this.requested) return;
			const forced = this.forced;
			this.requested = false;
			this.forced = false;
			this.running = true;
			const now = this.clock.now();
			this.lastFrameAt = now;
			try {
				this.render({ now, forced });
			} finally {
				this.running = false;
				this.schedule();
			}
		}, delay);
	}
}
