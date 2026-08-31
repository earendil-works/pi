import { createServer, type Server, type Socket } from "node:net";
import { DEFAULT_MAX_FRAME_LENGTH } from "@earendil-works/pi-protocol";
import type { ByteConnection, ByteConnectionAcceptor } from "../../connection.ts";
import type { PiServerListener } from "../../listener.ts";
import type { TcpListenerOptions } from "./types.ts";

const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;
const MAX_UINT32 = 0xffff_ffff;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ResolvedTcpListenerOptions {
	host: string;
	port: number;
	maxPendingBytes: number;
	gracefulCloseTimeoutMs: number;
	onError?: (error: Error) => void;
}

export class TcpListener implements PiServerListener {
	private readonly options: ResolvedTcpListenerOptions;
	private readonly connections = new Set<TcpByteConnection>();
	private server?: Server;
	private boundPort?: number;
	private closing = false;
	private closePromise?: Promise<void>;
	private accept?: ByteConnectionAcceptor;

	constructor(options: TcpListenerOptions) {
		this.options = resolveTcpListenerOptions(options);
	}

	get address(): string | undefined {
		return this.boundPort === undefined ? undefined : `${this.options.host}:${this.boundPort}`;
	}

	async start(accept: ByteConnectionAcceptor): Promise<void> {
		if (this.server) throw new Error("TCP listener is already started");
		if (this.closing) throw new Error("TCP listener is closing or closed");
		this.accept = accept;

		const server = createServer((socket) => this.acceptSocket(socket));
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

	private acceptSocket(socket: Socket): void {
		if (this.closing) {
			socket.destroy();
			return;
		}
		const connection = new TcpByteConnection(
			socket,
			this.options.gracefulCloseTimeoutMs,
			this.options.maxPendingBytes,
		);
		this.connections.add(connection);
		const accept = this.accept;
		if (!accept) {
			socket.destroy();
			return;
		}
		const handler = accept(connection);
		socket.on("data", (chunk) => {
			handler.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		});
		socket.on("error", (error) => {
			handler.onError(error);
			socket.destroy();
		});
		socket.once("close", () => {
			connection.markClosed();
			this.connections.delete(connection);
			handler.onClose();
		});
	}

	private async closeInternal(): Promise<void> {
		this.boundPort = undefined;
		const serverClosed = this.server ? closeNetServer(this.server, (error) => this.reportError(error)) : undefined;
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

/** @internal Exported only for transport-level verification. */
export class TcpByteConnection implements ByteConnection {
	private readonly socket: Socket;
	private readonly gracefulCloseTimeoutMs: number;
	private readonly maxPendingBytes: number;
	private pendingBytes = 0;
	private closedValue = false;
	private closing = false;
	private writeTail: Promise<void> = Promise.resolve();
	private closePromise?: Promise<void>;
	private resolveClose?: () => void;

	constructor(socket: Socket, gracefulCloseTimeoutMs: number, maxPendingBytes: number) {
		this.socket = socket;
		this.gracefulCloseTimeoutMs = gracefulCloseTimeoutMs;
		this.maxPendingBytes = maxPendingBytes;
	}

	get closed(): boolean {
		return this.closedValue;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) {
			return Promise.reject(new TypeError("TCP connection chunks must be Uint8Array"));
		}
		if (this.closedValue || this.closing) return Promise.reject(new Error("TCP connection is closed"));
		if (this.pendingBytes + chunk.byteLength > this.maxPendingBytes) {
			return Promise.reject(new Error("TCP connection exceeded its pending byte limit"));
		}
		this.pendingBytes += chunk.byteLength;
		const bytes = chunk.slice();
		const write = this.writeTail.then(() => this.write(bytes));
		const tracked = write.finally(() => {
			this.pendingBytes -= bytes.byteLength;
		});
		this.writeTail = tracked.catch(() => {});
		return tracked;
	}

	close(finalChunk?: Uint8Array): Promise<void> {
		if (this.closedValue || this.socket.destroyed) {
			this.markClosed();
			return Promise.resolve();
		}
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		const finalBytes = finalChunk?.slice();
		this.closePromise = new Promise<void>((resolve) => {
			this.resolveClose = resolve;
			const timer = setTimeout(() => {
				if (!this.socket.destroyed) this.socket.destroy();
				this.markClosed();
			}, this.gracefulCloseTimeoutMs);
			timer.unref();
			this.socket.once("close", () => clearTimeout(timer));
			void this.writeTail.then(() => {
				if (this.socket.destroyed) {
					this.markClosed();
					return;
				}
				try {
					if (finalBytes) this.socket.end(finalBytes);
					else this.socket.end();
				} catch {
					this.socket.destroy();
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
	}

	private write(chunk: Uint8Array): Promise<void> {
		if (this.closedValue || this.closing || !this.socket.writable) {
			return Promise.reject(new Error("TCP connection is closed"));
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const onClose = (): void => finish(new Error("TCP connection closed during write"));
			const finish = (error?: Error | null): void => {
				if (settled) return;
				settled = true;
				this.socket.off("close", onClose);
				if (error) reject(error);
				else resolve();
			};
			this.socket.once("close", onClose);
			try {
				this.socket.write(chunk, finish);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
}

export function createTcpListener(options: TcpListenerOptions): PiServerListener {
	return new TcpListener(options);
}

function resolveTcpListenerOptions(options: TcpListenerOptions): ResolvedTcpListenerOptions {
	const host = options.host ?? "127.0.0.1";
	if (typeof host !== "string" || host.length === 0) {
		throw new TypeError("TCP listener host must be a non-empty string");
	}
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
		throw new TypeError("TCP listener port must be an integer between 0 and 65535 (0 for ephemeral)");
	}
	const maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
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
		maxPendingBytes,
		gracefulCloseTimeoutMs,
		onError: options.onError,
	};
}

function closeNetServer(server: Server, reportError: (error: Error) => void): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise<void>((resolve) => {
		server.close((error) => {
			if (error) reportError(error);
			resolve();
		});
	});
}
