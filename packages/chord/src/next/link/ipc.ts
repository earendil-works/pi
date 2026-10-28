// IPC links (§3): a link over a Node IPC channel, a forked child (`fork` with `serialization: "advanced"`) or
// `process` in the child, typed structurally so Chord imports nothing from Node.

import { type Link, LinkEnd } from "./link.ts";

/**
 * The part of a Node IPC channel a link uses: a `ChildProcess` or the child's `process`. `send` returning `false` is
 * backpressure (the message is queued by Node), not a failure.
 */
export interface IpcPort {
	send(message: Uint8Array, callback: (error: Error | null) => void): boolean;
	on(event: "message", listener: (message: unknown) => void): unknown;
	on(event: "disconnect", listener: () => void): unknown;
	removeListener(event: "message", listener: (message: unknown) => void): unknown;
	removeListener(event: "disconnect", listener: () => void): unknown;
	disconnect(): void;
	readonly connected: boolean;
}

/**
 * A link over `port`: each message one `Uint8Array` (V8 serialization keeps it one). It listens from the moment it is
 * made and queues messages until its listener is set, so a child makes it before awaiting its start message; messages
 * that are no `Uint8Array` (the app's own, such as that start message) are not the link's and are skipped. A thrown
 * `send`, an error in its callback or `disconnect` closes the link once; its listeners are removed then.
 */
export function ipcLink(port: IpcPort): Link {
	return new IpcLink(port);
}

class IpcLink extends LinkEnd {
	/** The port while the link is open. */
	#port: IpcPort | undefined;
	readonly #onMessage = (message: unknown): void => {
		if (message instanceof Uint8Array) this.deliver(message);
	};
	readonly #onDisconnect = (): void => this.#end();
	readonly #onSent = (error: Error | null): void => {
		if (error !== null) this.#end();
	};

	constructor(port: IpcPort) {
		super();
		this.#port = port;
		if (!port.connected) {
			this.#end();
			return;
		}
		port.on("message", this.#onMessage);
		port.on("disconnect", this.#onDisconnect);
	}

	send(message: Uint8Array): void {
		const port = this.#port;
		if (port === undefined) return;
		try {
			port.send(message, this.#onSent);
		} catch {
			this.#end();
		}
	}

	close(): void {
		const port = this.#port;
		if (port === undefined) return;
		this.#end();
		// Disconnecting a channel that is gone already would emit an error.
		if (port.connected) port.disconnect();
	}

	/** Detaches from the port and closes this end. */
	#end(): void {
		const port = this.#port;
		this.#port = undefined;
		port?.removeListener("message", this.#onMessage);
		port?.removeListener("disconnect", this.#onDisconnect);
		this.ended();
	}
}
