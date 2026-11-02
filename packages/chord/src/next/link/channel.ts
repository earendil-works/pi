// A host's end of a link (§3, §22, 2b): the handshake, the link's codec, the checks of every message (skipped on a
// trusted link), the heartbeat, and messages handled in order while one waits for an asynchronous inflate; a protocol
// error closes the link.

import type { Context } from "../../context/index.ts";
import { PROTOCOL_VERSION } from "../data/internal.ts";
import type { Link } from "./link.ts";
import { type Codec, checkMessage, type Message } from "./message.ts";

/** What the owner of a channel handles. */
export interface ChannelHandler {
	/** The peer's `hello` arrived: the link is open. */
	opened(): void;
	/**
	 * A checked message after the handshake (never `hello`, `ping` or `pong`). A throw is a protocol error. A promise
	 * (the message waits for an asynchronous inflate) holds every later message until it settles; a rejection is a
	 * protocol error too.
	 */
	message(message: Message): void | Promise<void>;
	/** The link closed, from either end; called once. */
	closed(): void;
}

/** What a channel is made with besides its link and handler. */
type ChannelOptions = {
	readonly codec: Codec;
	/** This host's incarnation, sent in `hello`. */
	readonly incarnation: string;
	/** How many concurrent calls this side accepts, sent in `hello`. */
	readonly calls: number;
	/** Skips the `MESSAGE` check (framing, the codec's decode and the owners' checks still run). */
	readonly trusted: boolean;
	/** Where protocol errors go. */
	readonly report: (error: unknown) => void;
};

/**
 * Where a channel stands: `greeting` until the peer's `hello`, with what this end sent meanwhile; `open` with the
 * peer's incarnation and call window.
 */
type ChannelState =
	| { readonly kind: "greeting"; readonly queued: Uint8Array[] }
	| { readonly kind: "open"; readonly peer: string; readonly calls: number }
	| { readonly kind: "closed" };

/**
 * One end of a link. It sends `hello { protocol, incarnation, calls }` first and nothing else until the peer's arrived
 * (its own messages wait). Every message is decoded by the link's codec and, unless the link is trusted, checked
 * against the message schema; a first message that is no `hello` of this codec, a second `hello`, another protocol
 * version, or a message failing a check closes the link and is reported. The heartbeat: every received message
 * stamps `lastReceived`; the host's timer calls `tick`, which pings a silent open link and closes a link silent for
 * too long (the handshake included); a `ping` is answered with `pong` at once. A message the handler handles
 * asynchronously holds the later ones, `ping` included, until it settles; they are handled in order then, and dropped
 * when the link closes meanwhile.
 */
export class Channel {
	readonly #link: Link;
	readonly #codec: Codec;
	readonly #handler: ChannelHandler;
	readonly #report: (error: unknown) => void;
	readonly #trusted: boolean;
	readonly #context: Context;
	#state: ChannelState = { kind: "greeting", queued: [] };
	/** When the last message arrived (`Date.now()`), or the channel was made. */
	#lastReceived = Date.now();
	/** Whether a `ping` went out since the last received message. */
	#pinged = false;
	/**
	 * Messages received while one is handled asynchronously, in order, and the index of the next to handle; `undefined`
	 * while none waits.
	 */
	#held: { queue: Uint8Array[]; next: number } | undefined;
	/** Whether a message is being handled asynchronously: the held ones wait. */
	#waiting = false;
	readonly #hello: Uint8Array;

	constructor(link: Link, handler: ChannelHandler, options: ChannelOptions, context: Context) {
		this.#link = link;
		this.#codec = options.codec;
		this.#handler = handler;
		this.#report = options.report;
		this.#trusted = options.trusted;
		this.#context = context;
		this.#hello = this.#codec.encode({
			kind: "hello",
			protocol: PROTOCOL_VERSION,
			incarnation: options.incarnation,
			calls: options.calls,
		});
	}

	/**
	 * Sends `hello` and starts listening: messages that arrived already are handled now, and a link closed already
	 * calls `closed` now; so the handler is complete before it starts.
	 */
	start(): void {
		this.#link.send(this.#hello);
		this.#link.onMessage((bytes) => this.#receive(bytes));
		this.#link.onClose(() => this.#closed());
	}

	/** The peer's incarnation, from its `hello`; empty before it arrived (nothing else can arrive before it). */
	get peer(): string {
		return this.#state.kind === "open" ? this.#state.peer : "";
	}

	/** How many concurrent calls the peer accepts, from its `hello`; 0 before it arrived. */
	get peerCalls(): number {
		return this.#state.kind === "open" ? this.#state.calls : 0;
	}

	get opened(): boolean {
		return this.#state.kind === "open";
	}

	get closed(): boolean {
		return this.#state.kind === "closed";
	}

	/** Sends one message; before the handshake it waits, after the close it is dropped. */
	send(message: Message): void {
		const state = this.#state;
		if (state.kind === "closed") return;
		const bytes = this.#codec.encode(message);
		if (state.kind === "greeting") state.queued.push(bytes);
		else this.#link.send(bytes);
	}

	close(): void {
		this.#link.close();
	}

	/**
	 * The heartbeat, at `now`: a link silent for `close` ms (the handshake included) closes; an open one silent for
	 * `ping` ms sends one `ping`.
	 */
	tick(now: number, ping: number, close: number): void {
		const silent = now - this.#lastReceived;
		if (silent >= close) this.close();
		else if (silent >= ping && !this.#pinged && this.#state.kind === "open") {
			this.#pinged = true;
			this.#link.send(this.#codec.encode({ kind: "ping" }));
		}
	}

	#receive(bytes: Uint8Array): void {
		if (this.#state.kind === "closed") return;
		this.#lastReceived = Date.now();
		this.#pinged = false;
		if (this.#held === undefined) this.#handle(bytes);
		else this.#held.queue.push(bytes);
	}

	/** Handles one received message; one the handler handles asynchronously holds the next until it settles. */
	#handle(bytes: Uint8Array): void {
		const state = this.#state;
		try {
			if (state.kind === "greeting") {
				this.#greet(bytes, state.queued);
				return;
			}
			const message = this.#decode(bytes);
			if (message.kind === "hello") throw new Error("handshake: a second hello");
			// Control of the link itself, never queued behind the window.
			if (message.kind === "ping") this.#link.send(this.#codec.encode({ kind: "pong" }));
			else if (message.kind !== "pong") {
				const handling = this.#handler.message(message);
				if (handling !== undefined) this.#hold(handling);
			}
		} catch (error) {
			this.#failed(error);
		}
	}

	/** Holds later messages until `handling` settles, then handles them in order (each may hold again). */
	#hold(handling: Promise<void>): void {
		this.#held ??= { queue: [], next: 0 };
		this.#waiting = true;
		handling.then(
			() => {
				this.#waiting = false;
				this.#release();
			},
			(error: unknown) => this.#failed(error),
		);
	}

	/**
	 * The held message was handled: the ones behind it are handled in order, until one holds again (the handled ones are
	 * dropped from the queue then).
	 */
	#release(): void {
		const held = this.#held;
		if (held === undefined) return;
		while (held.next < held.queue.length) {
			if (this.#state.kind !== "open") return;
			this.#handle(held.queue[held.next++]!);
			if (this.#waiting) {
				held.queue.splice(0, held.next);
				held.next = 0;
				return;
			}
		}
		this.#held = undefined;
	}

	/** A protocol error: reported, and the link closes. */
	#failed(error: unknown): void {
		if (this.#state.kind === "closed") return;
		this.#report(error);
		this.close();
	}

	/** A message from its bytes, checked against the message schema unless the link is trusted. */
	#decode(bytes: Uint8Array): Message {
		const message = this.#codec.decode(bytes);
		return this.#trusted ? message : checkMessage(message, this.#context);
	}

	/** The first message: the peer's `hello` in this link's codec and protocol version. */
	#greet(bytes: Uint8Array, queued: readonly Uint8Array[]): void {
		let message: Message;
		try {
			message = this.#decode(bytes);
		} catch (error) {
			throw new Error(`handshake: the first message is no ${this.#codec.name} message`, { cause: error });
		}
		if (message.kind !== "hello") throw new Error(`handshake: ${message.kind} before hello`);
		if (message.protocol !== PROTOCOL_VERSION) {
			throw new Error(`handshake: protocol ${message.protocol}, this host speaks ${PROTOCOL_VERSION}`);
		}
		this.#state = { kind: "open", peer: message.incarnation, calls: message.calls };
		for (const bytes of queued) this.#link.send(bytes);
		this.#handler.opened();
	}

	#closed(): void {
		if (this.#state.kind === "closed") return;
		this.#state = { kind: "closed" };
		this.#held = undefined;
		this.#handler.closed();
	}
}
