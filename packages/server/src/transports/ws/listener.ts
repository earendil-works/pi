import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import type { ByteConnection, ByteConnectionAcceptor } from "../../connection.ts";
import type { PiServerListener } from "../../listener.ts";
import {
	encodeWsCloseFrame,
	encodeWsFrame,
	WS_OPCODE_BINARY,
	WS_OPCODE_CLOSE,
	WS_OPCODE_PING,
	WS_OPCODE_PONG,
	WS_OPCODE_TEXT,
	type WsFrame,
	WsFrameDecoder,
	WsProtocolError,
} from "./frames.ts";
import { buildWsHandshakeResponse, prepareWsHandshake, WsHandshakeError } from "./handshake.ts";

const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;
const MAX_UINT32 = 0xffff_ffff;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface WsListenerOptions {
	host?: string;
	port: number;
	maxPendingBytes?: number;
	gracefulCloseTimeoutMs?: number;
	/** Used to derive and validate maxPendingBytes. Must match the server when customized. */
	maxFrameLength?: number;
	onError?: (error: Error) => void;
}

interface ResolvedWsListenerOptions {
	host: string;
	port: number;
	maxFrameLength: number;
	maxPendingBytes: number;
	gracefulCloseTimeoutMs: number;
	onError?: (error: Error) => void;
}

/** Server-side WebSocket listener backed by Node's HTTP server upgrade event. */
export class WsListener implements PiServerListener {
	private readonly options: ResolvedWsListenerOptions;
	private readonly connections = new Set<WsByteConnection>();
	private server?: HttpServer;
	private boundPort?: number;
	private closing = false;
	private closePromise?: Promise<void>;
	private accept?: ByteConnectionAcceptor;

	constructor(options: WsListenerOptions) {
		this.options = resolveWsListenerOptions(options);
	}

	get address(): string | undefined {
		return this.boundPort === undefined ? undefined : `${this.options.host}:${this.boundPort}`;
	}

	async start(accept: ByteConnectionAcceptor): Promise<void> {
		if (this.server) throw new Error("WebSocket listener is already started");
		if (this.closing) throw new Error("WebSocket listener is closing or closed");
		this.accept = accept;

		const server = createHttpServer((_request, response) => {
			response.writeHead(426, { "Content-Type": "text/plain" });
			response.end("Upgrade Required: this endpoint speaks WebSocket");
		});
		server.on("upgrade", (request, socket, head) => this.acceptUpgrade(request, socket, head));
		server.on("error", (error) => this.reportError(error));
		this.server = server;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error): void => {
					server.off("listening", onListening);
					reject(error);
				};
				const onListening = (): void => {
					server.off("error", onError);
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				server.listen(this.options.port, this.options.host);
			});
			const address = server.address();
			this.boundPort = typeof address === "object" && address !== null ? address.port : this.options.port;
		} catch (error) {
			this.server = undefined;
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	private acceptUpgrade(request: import("node:http").IncomingMessage, socket: Duplex, head: Buffer): void {
		if (this.closing) {
			socket.destroy();
			return;
		}
		let acceptKey: string;
		try {
			acceptKey = prepareWsHandshake(request);
		} catch (error) {
			if (error instanceof WsHandshakeError) {
				socket.end(buildWsHandshakeRejection());
				return;
			}
			this.reportError(error);
			socket.destroy();
			return;
		}
		socket.write(buildWsHandshakeResponse(acceptKey));

		const connection = new WsByteConnection(socket, head, this.options);
		this.connections.add(connection);
		const accept = this.accept;
		if (!accept) {
			connection.close();
			return;
		}
		const handler = accept(connection);
		connection.onFrame = (frame) => {
			if (frame.opcode === WS_OPCODE_BINARY) {
				handler.onData(frame.payload);
			}
			// Text frames are ignored; the protocol is binary-only.
		};
		connection.onClose = () => {
			this.connections.delete(connection);
			handler.onClose();
		};
		connection.onError = (error) => {
			handler.onError(error);
			void connection.close();
		};
	}

	private async closeInternal(): Promise<void> {
		this.boundPort = undefined;
		const serverClosed = this.server ? closeHttpServer(this.server, (error) => this.reportError(error)) : undefined;
		await Promise.all([...this.connections].map((connection) => connection.close()));
		await serverClosed;
		this.connections.clear();
		this.server = undefined;
	}

	private reportError(error: unknown): void {
		try {
			this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// Error observers cannot affect listener state.
		}
	}
}

function buildWsHandshakeRejection(): Uint8Array {
	return new TextEncoder().encode(["HTTP/1.1 400 Bad Request", "Connection: close", "", ""].join("\r\n"));
}

/** @internal Exported only for transport-level verification. */
export class WsByteConnection implements ByteConnection {
	onFrame?: (frame: WsFrame) => void;
	onClose?: () => void;
	onError?: (error: Error) => void;

	private readonly socket: Duplex;
	private readonly decoder: WsFrameDecoder;
	private readonly maxPendingBytes: number;
	private readonly gracefulCloseTimeoutMs: number;
	private pendingBytes = 0;
	private closedValue = false;
	private closing = false;
	private writeTail: Promise<void> = Promise.resolve();
	private closePromise?: Promise<void>;
	private resolveClose?: () => void;

	constructor(socket: Duplex, head: Buffer, options: ResolvedWsListenerOptions) {
		this.socket = socket;
		this.decoder = new WsFrameDecoder(options.maxFrameLength);
		this.maxPendingBytes = options.maxPendingBytes;
		this.gracefulCloseTimeoutMs = options.gracefulCloseTimeoutMs;
		socket.on("data", (chunk) => this.receive(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
		socket.on("error", (error) => this.handleError(error));
		socket.once("close", () => this.handleClosed());
		if (head.byteLength > 0) this.receive(new Uint8Array(head.buffer, head.byteOffset, head.byteLength));
	}

	get closed(): boolean {
		return this.closedValue;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) {
			return Promise.reject(new TypeError("WebSocket connection chunks must be Uint8Array"));
		}
		if (this.closedValue || this.closing) return Promise.reject(new Error("WebSocket connection is closed"));
		if (this.pendingBytes + chunk.byteLength > this.maxPendingBytes) {
			return Promise.reject(new Error("WebSocket connection exceeded its pending byte limit"));
		}
		this.pendingBytes += chunk.byteLength;
		const frame = encodeWsFrame(chunk, WS_OPCODE_BINARY);
		const write = this.writeTail.then(() => this.write(frame));
		const tracked = write.finally(() => {
			this.pendingBytes -= chunk.byteLength;
		});
		this.writeTail = tracked.catch(() => {});
		return tracked;
	}

	close(finalChunk?: Uint8Array): Promise<void> {
		if (this.closedValue) {
			this.markClosed();
			return Promise.resolve();
		}
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = new Promise<void>((resolve) => {
			this.resolveClose = resolve;
			void this.writeTail.then(() => {
				if (this.closedValue || this.socket.destroyed) {
					this.markClosed();
					return;
				}
				try {
					const finalFrame =
						finalChunk && finalChunk.byteLength > 0 ? encodeWsFrame(finalChunk, WS_OPCODE_BINARY) : undefined;
					const closeFrame = encodeWsCloseFrame();
					const payload = finalFrame ? concatBytes(finalFrame, closeFrame) : closeFrame;
					this.socket.end(payload, () => this.markClosed());
				} catch (error) {
					this.socket.destroy();
					this.markClosed();
					if (error instanceof Error) this.handleError(error);
				}
			});
		});
		return this.closePromise;
	}

	markClosed(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.closing = true;
		this.resolveClose?.();
		this.resolveClose = undefined;
		this.onClose?.();
	}

	private receive(chunk: Uint8Array): void {
		if (this.closedValue || this.closing) return;
		let frames: WsFrame[];
		try {
			frames = this.decoder.push(chunk);
		} catch (error) {
			this.handleProtocolError(error);
			return;
		}
		for (const frame of frames) {
			if (this.closedValue || this.closing) return;
			try {
				this.dispatch(frame);
			} catch (error) {
				this.handleProtocolError(error);
				return;
			}
		}
	}

	private dispatch(frame: WsFrame): void {
		switch (frame.opcode) {
			case WS_OPCODE_BINARY:
			case WS_OPCODE_TEXT:
				this.onFrame?.(frame);
				return;
			case WS_OPCODE_PING:
				// Answer pings immediately so load balancers keep the connection alive.
				void this.writeTail.then(() => {
					if (this.closedValue || this.closing || this.socket.destroyed) return;
					this.socket.write(encodeWsFrame(frame.payload, WS_OPCODE_PONG));
				});
				return;
			case WS_OPCODE_PONG:
				return;
			case WS_OPCODE_CLOSE:
				void this.writeTail.then(() => {
					if (this.closedValue || this.socket.destroyed) return;
					try {
						this.socket.end(encodeWsCloseFrame(1000));
					} catch {
						this.socket.destroy();
					}
					this.markClosed();
				});
				return;
			default:
				throw new WsProtocolError(`Unsupported WebSocket opcode: ${frame.opcode}`);
		}
	}

	private handleProtocolError(error: unknown): void {
		this.handleError(error instanceof Error ? error : new Error(String(error)));
		void this.close();
	}

	private handleError(error: Error): void {
		this.onError?.(error);
	}

	private handleClosed(): void {
		this.markClosed();
	}

	private write(frame: Uint8Array): Promise<void> {
		if (this.closedValue || this.closing || !this.socket.writable) {
			return Promise.reject(new Error("WebSocket connection is closed"));
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const onClose = (): void => finish(new Error("WebSocket connection closed during write"));
			const finish = (error?: Error | null): void => {
				if (settled) return;
				settled = true;
				this.socket.off("close", onClose);
				if (error) reject(error);
				else resolve();
			};
			this.socket.once("close", onClose);
			try {
				this.socket.write(frame, finish);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
	const result = new Uint8Array(first.byteLength + second.byteLength);
	result.set(first, 0);
	result.set(second, first.byteLength);
	return result;
}

export function createWsListener(options: WsListenerOptions): PiServerListener {
	return new WsListener(options);
}

function resolveWsListenerOptions(options: WsListenerOptions): ResolvedWsListenerOptions {
	const host = options.host ?? "127.0.0.1";
	if (typeof host !== "string" || host.length === 0) {
		throw new TypeError("WebSocket listener host must be a non-empty string");
	}
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
		throw new TypeError("WebSocket listener port must be an integer between 0 and 65535 (0 for ephemeral)");
	}
	const maxFrameLength = options.maxFrameLength ?? 16 * 1024 * 1024;
	if (!Number.isSafeInteger(maxFrameLength) || maxFrameLength <= 0 || maxFrameLength > MAX_UINT32) {
		throw new TypeError(`PiServer maxFrameLength must be an integer between 1 and ${MAX_UINT32}`);
	}
	const maxPendingBytes = options.maxPendingBytes ?? maxFrameLength * 4;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < maxFrameLength + 4) {
		throw new TypeError("PiServer maxPendingBytes must be a safe integer at least maxFrameLength + 4");
	}
	const gracefulCloseTimeoutMs = options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(gracefulCloseTimeoutMs) ||
		gracefulCloseTimeoutMs <= 0 ||
		gracefulCloseTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new TypeError(`PiServer gracefulCloseTimeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
	}
	return {
		host,
		port: options.port,
		maxFrameLength,
		maxPendingBytes,
		gracefulCloseTimeoutMs,
		onError: options.onError,
	};
}

function closeHttpServer(server: HttpServer, reportError: (error: Error) => void): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise<void>((resolve) => {
		server.close((error) => {
			if (error) reportError(error);
			resolve();
		});
	});
}
