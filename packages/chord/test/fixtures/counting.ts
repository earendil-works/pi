// A link wrapper that counts what crosses it, per direction: frames by type and bytes (JSON text length). It can also
// hold back the acknowledgements its own side sends (`paused`), to fill the peer's flow-control window.
import type { Frame, Link } from "../../src/index.ts";

export class CountingLink implements Link {
	readonly inner: Link;
	/** Frames this side sent, in order. */
	readonly sent: Frame[] = [];
	/** Frames this side received, in order. */
	readonly received: Frame[] = [];
	sentBytes = 0;
	receivedBytes = 0;
	/** Acknowledgements are held back (the peer's window fills up). */
	paused = false;
	#held: Frame | undefined;

	constructor(inner: Link) {
		this.inner = inner;
	}

	get closed(): boolean {
		return this.inner.closed;
	}

	send(frame: Frame): number | undefined {
		if (frame.t === "ack" && this.paused) {
			this.#held = frame;
			return 0;
		}
		this.sent.push(frame);
		this.sentBytes += JSON.stringify(frame).length;
		return this.inner.send(frame);
	}

	/** Lets the held acknowledgement through and stops holding them. */
	release(): void {
		this.paused = false;
		const held = this.#held;
		this.#held = undefined;
		if (held !== undefined) this.inner.send(held);
	}

	receive(handler: (frame: Frame) => void): void {
		this.inner.receive((frame) => {
			this.received.push(frame);
			this.receivedBytes += JSON.stringify(frame).length;
			handler(frame);
		});
	}

	onClose(handler: (reason: string) => void): void {
		this.inner.onClose(handler);
	}

	close(reason?: string): void {
		this.inner.close(reason);
	}

	/** Frames of type `t` this side sent (`sent`) or received (`received`). */
	count(direction: "sent" | "received", t: Frame["t"]): number {
		return this[direction].filter((frame) => frame.t === t).length;
	}

	/** Frames this side sent or received, except pings, pongs and acknowledgements. */
	traffic(direction: "sent" | "received"): Frame[] {
		return this[direction].filter((frame) => frame.t !== "ping" && frame.t !== "pong" && frame.t !== "ack");
	}
}

export type StateFrame = Extract<Frame, { t: "state" }>;

export const stateFrames = (frames: readonly Frame[]): StateFrame[] =>
	frames.filter((frame): frame is StateFrame => frame.t === "state");
