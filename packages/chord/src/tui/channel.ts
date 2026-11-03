// The sandbox's side of the bridge (slice 11 §4): one dispatcher of the launcher's messages (input, resizes, link
// sockets, replies), requests with their replies, and Chord links whose bytes the launcher relays to the server.

import { LinkEnd } from "../link/link.ts";
import type { Bridge, BridgeRequest, BridgeStart, LauncherMessage } from "./bridge.ts";
import { splitFrames } from "./frames.ts";

/** What one relayed socket reports: it opened, a frame arrived. */
export type RelayEvents = { opened(): void; received(): void };

/** The sandbox's bridge: requests, relayed sockets, and the terminal's input and resizes. */
export class SandboxChannel {
	readonly #bridge: Bridge;
	readonly #replies = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	readonly #sockets = new Map<number, RelayLink>();
	readonly #input = new Set<(data: string) => void>();
	readonly #resize = new Set<(columns: number, rows: number) => void>();
	#next = 0;

	constructor(bridge: Bridge) {
		this.#bridge = bridge;
		bridge.onMessage((message) => this.#dispatch(message));
	}

	/** What the launcher told at the start. */
	get start(): BridgeStart {
		return this.#bridge.start;
	}

	/** Asks the launcher; rejects with its refusal. */
	request(request: BridgeRequest): Promise<unknown> {
		const id = ++this.#next;
		return new Promise((resolve, reject) => {
			this.#replies.set(id, { resolve, reject });
			this.#bridge.send({ kind: "request", id, request });
		});
	}

	/** Runs the registered scripts `text` (named `filename` in stacks) through the sandbox's own evaluation. */
	evaluate(text: string, filename: string): void {
		this.#bridge.evaluate(text, filename);
	}

	/** Writes `data` to the terminal, in frames the launcher takes (`splitFrames`). */
	write(data: string): void {
		for (const frame of splitFrames(data)) this.#bridge.send({ kind: "write", data: frame });
	}

	/** Tells the launcher this sandbox's code is outdated. */
	outdated(): void {
		this.#bridge.send({ kind: "outdated" });
	}

	/** Ends the terminal with `code`. */
	exit(code: number): void {
		this.#bridge.send({ kind: "exit", code });
	}

	/** Calls `listener` with each input (keys, pastes) until the returned removal. */
	onInput(listener: (data: string) => void): () => void {
		this.#input.add(listener);
		return () => this.#input.delete(listener);
	}

	/** Calls `listener` at each resize until the returned removal. */
	onResize(listener: (columns: number, rows: number) => void): () => void {
		this.#resize.add(listener);
		return () => this.#resize.delete(listener);
	}

	/** Opens a socket to the server's links endpoint through the launcher: its link, reporting to `events`. */
	openSocket(events: RelayEvents): RelayLink {
		const socket = ++this.#next;
		const link = new RelayLink(socket, events, this.#bridge, () => this.#sockets.delete(socket));
		this.#sockets.set(socket, link);
		this.#bridge.send({ kind: "socket_open", socket });
		return link;
	}

	/** One message of the launcher, to whom it is for. */
	#dispatch(message: LauncherMessage): void {
		switch (message.kind) {
			case "input":
				for (const listener of this.#input) listener(message.data);
				return;
			case "resize":
				for (const listener of this.#resize) listener(message.columns, message.rows);
				return;
			case "socket_opened":
				this.#sockets.get(message.socket)?.opened();
				return;
			case "socket_message":
				this.#sockets.get(message.socket)?.received(message.bytes);
				return;
			case "socket_closed":
				this.#sockets.get(message.socket)?.dropped();
				return;
			case "reply":
			case "attached":
			case "refused":
				this.#settle(message);
		}
	}

	/** Settles the request a reply or refusal answers. */
	#settle(message: Extract<LauncherMessage, { kind: "reply" | "attached" | "refused" }>): void {
		const waiting = this.#replies.get(message.id);
		this.#replies.delete(message.id);
		if (message.kind === "reply") waiting?.resolve(message.value);
		else if (message.kind === "attached") waiting?.resolve({ name: message.name, bytes: message.bytes });
		else waiting?.reject(new Error(message.message));
	}
}

/** A Chord link over a socket the launcher holds: bytes relayed both ways, buffered until the socket opened. */
export class RelayLink extends LinkEnd {
	readonly #socket: number;
	readonly #events: RelayEvents;
	readonly #bridge: Bridge;
	readonly #forget: () => void;
	/** Messages sent while the socket connects; `undefined` once open. */
	#connecting: Uint8Array[] | undefined = [];

	constructor(socket: number, events: RelayEvents, bridge: Bridge, forget: () => void) {
		super();
		this.#socket = socket;
		this.#events = events;
		this.#bridge = bridge;
		this.#forget = forget;
	}

	send(message: Uint8Array): void {
		if (this.closed) return;
		if (this.#connecting !== undefined) this.#connecting.push(message);
		else this.#bridge.send({ kind: "socket_send", socket: this.#socket, bytes: message });
	}

	close(): void {
		if (this.closed) return;
		this.#bridge.send({ kind: "socket_close", socket: this.#socket });
		this.dropped();
	}

	/** The launcher's socket opened: what was sent meanwhile goes out. */
	opened(): void {
		const queued = this.#connecting ?? [];
		this.#connecting = undefined;
		this.#events.opened();
		for (const message of queued) this.send(message);
	}

	/** A frame arrived. */
	received(bytes: Uint8Array): void {
		this.#events.received();
		this.deliver(bytes);
	}

	/** The socket closed (either side): the link ends. */
	dropped(): void {
		this.#forget();
		this.ended();
	}
}
