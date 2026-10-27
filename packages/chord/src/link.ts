import type * as Zlib from "node:zlib";
import type { Frame } from "./wire.ts";

/** An ordered (FIFO), bidirectional frame channel between two hosts. */
export interface Link {
	readonly closed: boolean;
	/**
	 * Returns the size of the encoded frame as sent (JSON text length, or bytes of a packed message) when the transport
	 * knows it. The connection's flow control counts these sizes; frames without one count as zero, so a link that never
	 * reports sizes is not windowed.
	 */
	send(frame: Frame): number | undefined;
	/** Sets the single receiver. Frames arriving earlier are queued. */
	receive(handler: (frame: Frame) => void): void;
	onClose(handler: (reason: string) => void): void;
	/** Closes both ends: the peer gets a `bye`. */
	close(reason?: string): void;
}

/** Shared plumbing: receive queue, close handlers, `bye`. Transports implement `transmit` and `shutdown`. */
abstract class BaseLink implements Link {
	#handler: ((frame: Frame) => void) | undefined;
	#queue: Frame[] = [];
	readonly #closeHandlers = new Set<(reason: string) => void>();
	#closed = false;
	/** The tail of frames being decoded asynchronously; undefined when none is. */
	#decoding: Promise<void> | undefined;

	get closed(): boolean {
		return this.#closed;
	}

	protected abstract transmit(frame: Frame): number | undefined;
	protected abstract shutdown(): void;

	send(frame: Frame): number | undefined {
		if (this.#closed) return undefined;
		return this.transmit(frame);
	}

	receive(handler: (frame: Frame) => void): void {
		this.#handler = handler;
		for (const frame of this.#queue.splice(0)) handler(frame);
	}

	onClose(handler: (reason: string) => void): void {
		if (this.#closed) handler("closed");
		else this.#closeHandlers.add(handler);
	}

	close(reason = "closed"): void {
		if (this.#closed) return;
		try {
			this.transmit({ t: "bye", reason });
		} catch {
			// The transport may already be gone.
		}
		this.ended(reason);
	}

	/** Delivers a parsed frame from the transport, after any frame still being decoded (`deliverLater`). */
	protected deliver(frame: Frame): void {
		if (this.#decoding !== undefined) this.deliverLater(Promise.resolve(frame));
		else this.#deliverNow(frame);
	}

	/** Delivers a frame that is still being decoded (inflated in a browser); later frames wait for it, in order. */
	protected deliverLater(frame: Promise<Frame>): void {
		const next = (this.#decoding ?? Promise.resolve())
			.then(() => frame)
			.then(
				(decoded) => this.#deliverNow(decoded),
				() => this.close("protocol error"),
			)
			.finally(() => {
				if (this.#decoding === next) this.#decoding = undefined;
			});
		this.#decoding = next;
	}

	#deliverNow(frame: Frame): void {
		if (this.#closed) return;
		if (frame.t === "bye") {
			this.ended(frame.reason ?? "peer closed");
			return;
		}
		if (this.#handler === undefined) this.#queue.push(frame);
		else this.#handler(frame);
	}

	/** Marks the link closed (transport ended) and notifies once. */
	protected ended(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#queue = [];
		try {
			this.shutdown();
		} finally {
			for (const handler of this.#closeHandlers) handler(reason);
			this.#closeHandlers.clear();
		}
	}
}

// ─── payload packing ─────────────────────────────────────────────────────────
//
// A transport optimization, invisible above the links. A frame's payload (call args, a result value, a state snapshot)
// whose JSON exceeds `PACK_THRESHOLD` characters is sent deflated. A host that only relays the frame forwards the
// deflated bytes unread (`Packed`); the host that uses the payload inflates it (`unpack`). Only hosts with Node's zlib
// deflate (synchronously, so frames keep their order); a browser inflates with `DecompressionStream` before delivery.

/** Payloads whose JSON is longer than this many characters are deflated. */
export const PACK_THRESHOLD = 64 * 1024;

const zlib: typeof Zlib | undefined = (
	globalThis as { process?: { getBuiltinModule?(id: "node:zlib"): typeof Zlib } }
).process?.getBuiltinModule?.("node:zlib");

/** A deflated JSON payload, kept as received until a host uses it. */
export class Packed {
	readonly bytes: Uint8Array;
	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
	}
}

/** A frame payload as its user needs it: inflated and parsed if it arrived packed. */
export function unpack(value: unknown): unknown {
	if (!(value instanceof Packed)) return value;
	if (zlib === undefined) throw new TypeError("packed payload without zlib");
	return JSON.parse(zlib.inflateRawSync(value.bytes).toString("utf8"));
}

type PayloadField = "args" | "value";
const PAYLOAD_FIELDS: ReadonlySet<string> = new Set<PayloadField>(["args", "value"]);

function payloadField(frame: Frame): PayloadField | undefined {
	if (frame.t === "call") return frame.args === undefined ? undefined : "args";
	if (frame.t === "result" || frame.t === "state") return frame.value === undefined ? undefined : "value";
	return undefined;
}

/** The frame without its payload field (the envelope). */
function envelopeOf(frame: Frame, field: PayloadField): Record<string, unknown> {
	const envelope: Record<string, unknown> = { ...frame };
	delete envelope[field];
	return envelope;
}

/** The payload's deflated bytes: as received, or deflated now if large. Undefined: send it as JSON. */
function packedBytes(value: unknown, compress: boolean, json?: string): Uint8Array | undefined {
	if (value instanceof Packed) return value.bytes;
	if (!compress || zlib === undefined || json === undefined || json.length <= PACK_THRESHOLD) return undefined;
	return zlib.deflateRawSync(json, { level: 1 });
}

/** For object transports (Node IPC, memory): a packed payload travels as `z: [field, base64]`. */
function packObject(frame: Frame, compress: boolean): unknown {
	const field = payloadField(frame);
	if (field === undefined) return frame;
	const value = (frame as Record<string, unknown>)[field];
	const bytes = packedBytes(value, compress, compress && zlib !== undefined ? JSON.stringify(value) : undefined);
	if (bytes === undefined) return frame;
	return {
		...envelopeOf(frame, field),
		z: [field, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")],
	};
}

function unpackObject(message: unknown): unknown {
	if (message === null || typeof message !== "object" || !("z" in message)) return message;
	const { z, ...rest } = message as { z: unknown } & Record<string, unknown>;
	if (!Array.isArray(z) || !PAYLOAD_FIELDS.has(z[0]) || typeof z[1] !== "string")
		throw new TypeError("bad packed payload");
	return { ...rest, [z[0]]: new Packed(Buffer.from(z[1], "base64")) };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * For WebSockets: a frame with a packed payload is a binary message, `[envelope length: u32 BE][envelope JSON, with
 * z: field][deflated payload]`; any other frame is text. The payload's JSON is spliced in, not encoded twice.
 */
function packMessage(frame: Frame, compress: boolean): string | Uint8Array {
	const field = payloadField(frame);
	if (field === undefined) return JSON.stringify(frame);
	const value = (frame as Record<string, unknown>)[field];
	const json = value instanceof Packed ? undefined : JSON.stringify(value);
	const bytes = packedBytes(value, compress, json);
	const envelope = envelopeOf(frame, field);
	if (bytes === undefined) {
		const head = JSON.stringify(envelope);
		return `${head.slice(0, -1)},${JSON.stringify(field)}:${json}}`;
	}
	const head = encoder.encode(JSON.stringify({ ...envelope, z: field }));
	const message = new Uint8Array(4 + head.byteLength + bytes.byteLength);
	new DataView(message.buffer).setUint32(0, head.byteLength);
	message.set(head, 4);
	message.set(bytes, 4 + head.byteLength);
	return message;
}

/** The envelope of a binary message and its payload bytes. */
function splitMessage(data: Uint8Array): { envelope: Record<string, unknown>; field: PayloadField; bytes: Uint8Array } {
	const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
	const envelope = JSON.parse(decoder.decode(data.subarray(4, 4 + length))) as unknown;
	if (envelope === null || typeof envelope !== "object") throw new TypeError("bad envelope");
	const { z: field, ...rest } = envelope as { z?: unknown } & Record<string, unknown>;
	if (typeof field !== "string" || !PAYLOAD_FIELDS.has(field)) throw new TypeError("bad packed payload");
	return { envelope: rest, field: field as PayloadField, bytes: data.slice(4 + length) };
}

/**
 * The text frame of a binary (packed) WebSocket message, inflated: for a transport that relays text frames only (the
 * TUI launcher feeding its sandbox). Needs zlib.
 */
export function inflateMessage(data: Uint8Array): string {
	if (zlib === undefined) throw new TypeError("inflateMessage needs zlib");
	const { envelope, field, bytes } = splitMessage(data);
	const head = JSON.stringify(envelope);
	return `${head.slice(0, -1)},${JSON.stringify(field)}:${zlib.inflateRawSync(bytes).toString("utf8")}}`;
}

/** Inflates without zlib (browsers). */
async function inflate(bytes: Uint8Array): Promise<unknown> {
	const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
		.stream()
		.pipeThrough(new DecompressionStream("deflate-raw"));
	return JSON.parse(await new Response(stream).text());
}

/** Parses a JSON frame; anything else is a protocol error. */
function parseFrame(data: string): Frame {
	const frame = unpackObject(JSON.parse(data)) as Frame;
	if (frame === null || typeof frame !== "object" || typeof frame.t !== "string") throw new TypeError("not a frame");
	return frame;
}

// ─── memory ──────────────────────────────────────────────────────────────────

export class MemoryLink extends BaseLink {
	peer: MemoryLink | undefined;
	#severed = false;
	#pending = Promise.resolve();

	/** Simulates a dead network: frames are dropped silently in both directions and no close is signalled. */
	sever(): void {
		this.#severed = true;
		if (this.peer) this.peer.#severed = true;
	}

	protected transmit(frame: Frame): number | undefined {
		if (this.#severed) return undefined;
		// A JSON round trip detaches the frame (and rejects what JSON would mangle silently, e.g. bigint).
		const data = JSON.stringify(packObject(frame, true));
		const peer = this.peer;
		// One promise chain per direction keeps delivery FIFO and asynchronous, like a real transport.
		this.#pending = this.#pending.then(() => {
			if (!this.#severed && peer !== undefined) peer.deliver(parseFrame(data));
		});
		return data.length;
	}

	protected shutdown(): void {
		const peer = this.peer;
		this.#pending = this.#pending.then(() => peer?.ended("peer closed"));
	}
}

/** Two connected in-memory links (tests). */
export function memoryLinkPair(): [MemoryLink, MemoryLink] {
	const a = new MemoryLink();
	const b = new MemoryLink();
	a.peer = b;
	b.peer = a;
	return [a, b];
}

// ─── Node IPC ────────────────────────────────────────────────────────────────

/** `process` in a forked child, or the parent's `ChildProcess`. Structural, so Chord needs no Node types here. */
export interface IpcChannel {
	readonly connected: boolean;
	/**
	 * With a callback, Node reports a failed write (the peer process exited and the pipe is broken: `EPIPE`) to it
	 * instead of emitting `error`, which nobody would handle.
	 */
	send(message: unknown, callback?: (error: Error | null) => void): boolean;
	on(event: "message", listener: (message: unknown) => void): unknown;
	on(event: "disconnect", listener: () => void): unknown;
	off(event: "message", listener: (message: unknown) => void): unknown;
	off(event: "disconnect", listener: () => void): unknown;
}

/**
 * Chord frames on an IPC channel are wrapped as `{ chord2: frame }`; other messages (control) pass by. Both ends are
 * Node processes of one application, so large payloads are packed both ways. Node serializes the messages itself, so
 * the link reports no sizes and is not windowed: both ends are local processes.
 */
export class IpcLink extends BaseLink {
	readonly #channel: IpcChannel;
	readonly #onMessage = (message: unknown): void => {
		const frame = (message as { chord2?: unknown } | null)?.chord2;
		if (frame === undefined) return;
		try {
			this.deliver(unpackObject(frame) as Frame);
		} catch {
			this.close("protocol error");
		}
	};
	readonly #onDisconnect = (): void => this.ended("ipc disconnected");
	/**
	 * A write can fail after the peer exited and before the channel reports `disconnect` (an `ack` or a `bye` sent then).
	 * The peer is gone either way: the link ends, as on `disconnect`.
	 */
	readonly #onSent = (error: Error | null): void => {
		if (error !== null) this.ended(`ipc send failed: ${(error as { code?: string }).code ?? error.message}`);
	};

	constructor(channel: IpcChannel) {
		super();
		this.#channel = channel;
		channel.on("message", this.#onMessage);
		channel.on("disconnect", this.#onDisconnect);
	}

	protected transmit(frame: Frame): undefined {
		if (this.#channel.connected) this.#channel.send({ chord2: packObject(frame, true) }, this.#onSent);
		return undefined;
	}

	protected shutdown(): void {
		this.#channel.off("message", this.#onMessage);
		this.#channel.off("disconnect", this.#onDisconnect);
	}
}

export const ipcLink = (channel: IpcChannel): IpcLink => new IpcLink(channel);

// ─── WebSocket ───────────────────────────────────────────────────────────────

/** The WHATWG WebSocket surface: the browser `WebSocket`, Node's global `WebSocket`, and `ws` sockets. */
export interface WebSocketLike {
	readonly readyState: number;
	send(data: string | Uint8Array): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
	addEventListener(type: "open" | "close" | "error", listener: () => void): void;
}

const OPEN = 1;

export interface WebSocketLinkOptions {
	/** Deflate large payloads of outgoing frames (default false; the server's side of client sockets). */
	readonly compress?: boolean;
	/** Accept packed (binary) frames from the peer (default true; false for a server's untrusted clients). */
	readonly acceptPacked?: boolean;
}

export class WebSocketLink extends BaseLink {
	readonly #socket: WebSocketLike;
	readonly #compress: boolean;
	#outbox: (string | Uint8Array)[] = [];

	constructor(socket: WebSocketLike, options: WebSocketLinkOptions = {}) {
		super();
		this.#socket = socket;
		this.#compress = options.compress ?? false;
		const acceptPacked = options.acceptPacked ?? true;
		// Binary messages as ArrayBuffer (browsers and Node's WebSocket default to Blob).
		if ("binaryType" in socket) (socket as { binaryType: string }).binaryType = "arraybuffer";
		socket.addEventListener("open", () => {
			for (const data of this.#outbox.splice(0)) socket.send(data);
		});
		socket.addEventListener("message", (event) => {
			try {
				const data = event.data;
				if (typeof data === "string") {
					this.deliver(parseFrame(data));
					return;
				}
				if (!acceptPacked) throw new TypeError("packed frames are not accepted");
				const bytes =
					data instanceof ArrayBuffer
						? new Uint8Array(data)
						: ArrayBuffer.isView(data)
							? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
							: undefined;
				if (bytes === undefined) throw new TypeError("unknown message type");
				const { envelope, field, bytes: payload } = splitMessage(bytes);
				if (zlib !== undefined) this.deliver({ ...envelope, [field]: new Packed(payload) } as Frame);
				else this.deliverLater(inflate(payload).then((value) => ({ ...envelope, [field]: value }) as Frame));
			} catch {
				this.close("protocol error");
			}
		});
		socket.addEventListener("close", () => this.ended("socket closed"));
	}

	protected transmit(frame: Frame): number {
		const data = packMessage(frame, this.#compress);
		if (this.#socket.readyState === OPEN) this.#socket.send(data);
		else this.#outbox.push(data);
		return typeof data === "string" ? data.length : data.byteLength;
	}

	protected shutdown(): void {
		this.#outbox = [];
		if (this.#socket.readyState <= OPEN) this.#socket.close(1000);
	}
}

export const webSocketLink = (socket: WebSocketLike, options?: WebSocketLinkOptions): WebSocketLink =>
	new WebSocketLink(socket, options);
