import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, link, lstat, mkdir, rename, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { DEFAULT_MAX_FRAME_LENGTH } from "@earendil-works/pi-protocol";
import type { ByteConnection, ByteConnectionAcceptor } from "../../connection.ts";
import type { ServerListener } from "../../listener.ts";
import type { UnixListenerOptions } from "./types.ts";

const DEFAULT_SOCKET_MODE = 0o600;
const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;
const MAX_UINT32 = 0xffff_ffff;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SOCKET_PROBE_TIMEOUT_MS = 1_000;

interface ResolvedUnixListenerOptions {
	path: string;
	mode: number;
	gracefulCloseTimeoutMs: number;
	maxPendingBytes: number;
	onError?: (error: Error) => void;
}

interface FileIdentity {
	dev: number;
	ino: number;
}
class UnixListener implements ServerListener {
	private readonly options: ResolvedUnixListenerOptions;
	private readonly path: string;
	private readonly mode: number;
	private readonly connections = new Set<UnixByteConnection>();
	private server?: Server;
	private socketIdentity?: FileIdentity;
	private ownedBindPath?: string;
	private closing = false;
	private closePromise?: Promise<void>;
	private accept?: ByteConnectionAcceptor;

	constructor(options: UnixListenerOptions) {
		this.options = resolveUnixListenerOptions(options);
		this.path = this.options.path;
		this.mode = this.options.mode;
	}

	async start(accept: ByteConnectionAcceptor): Promise<void> {
		if (this.server) throw new Error("Unix listener is already started");
		if (this.closing) throw new Error("Unix listener is closing or closed");
		this.accept = accept;

		const ownedBindPath = getOwnedBindPath(this.path);
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		await removeStaleSocket(this.path);
		await removeStaleSocket(ownedBindPath);
		this.ownedBindPath = ownedBindPath;
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
				server.listen(ownedBindPath);
			});
			const stats = await lstat(ownedBindPath);
			if (!stats.isSocket()) throw new Error(`Unix listener path is not a socket after binding: ${ownedBindPath}`);
			this.socketIdentity = { dev: stats.dev, ino: stats.ino };
			await link(ownedBindPath, this.path);
			await setSocketMode(this.path, this.mode);
			await removePath(ownedBindPath);
			this.ownedBindPath = undefined;
		} catch (error) {
			await this.closeServerAndCleanup(server);
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
		const connection = new UnixByteConnection(
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
		const serverClosed = this.server ? this.closeServerAndCleanup(this.server) : this.cleanupOwnedSocket();
		await Promise.all([...this.connections].map((connection) => connection.close()));
		await serverClosed;
		if (this.ownedBindPath) await removePath(this.ownedBindPath);
		this.ownedBindPath = undefined;
		this.connections.clear();
		this.server = undefined;
	}

	private async closeServerAndCleanup(server: Server): Promise<void> {
		try {
			await closeNetServer(server, (error) => this.reportError(error));
		} finally {
			// Remove an unpublished startup bind path before the public route.
			if (this.ownedBindPath) await removePath(this.ownedBindPath);
			this.ownedBindPath = undefined;
			await this.cleanupOwnedSocket();
		}
	}

	private async cleanupOwnedSocket(): Promise<void> {
		const identity = this.socketIdentity;
		this.socketIdentity = undefined;
		if (!identity) return;
		let current: Stats;
		try {
			current = await lstat(this.path);
		} catch (error) {
			if (isErrorCode(error, "ENOENT")) return;
			throw error;
		}
		if (!current.isSocket() || current.dev !== identity.dev || current.ino !== identity.ino) return;

		const preserved = join(dirname(this.path), `cleanup-${randomUUID().slice(0, 6)}`);
		try {
			await rename(this.path, preserved);
		} catch (error) {
			if (isErrorCode(error, "ENOENT")) return;
			throw error;
		}
		const moved = await lstat(preserved);
		if (moved.isSocket() && moved.dev === identity.dev && moved.ino === identity.ino) {
			await removePath(preserved);
			return;
		}
		try {
			await lstat(this.path);
		} catch (error) {
			if (isErrorCode(error, "ENOENT")) await rename(preserved, this.path);
			else throw error;
		}
		throw new Error(`Unix listener path changed during cleanup; preserved replacement at ${preserved}`);
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
export class UnixByteConnection implements ByteConnection {
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
			return Promise.reject(new TypeError("Unix connection chunks must be Uint8Array"));
		}
		if (this.closedValue || this.closing) return Promise.reject(new Error("Unix connection is closed"));
		if (this.pendingBytes + chunk.byteLength > this.maxPendingBytes) {
			return Promise.reject(new Error("Unix connection exceeded its pending byte limit"));
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
			return Promise.reject(new Error("Unix connection is closed"));
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const onClose = (): void => finish(new Error("Unix connection closed during write"));
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

function getOwnedBindPath(path: string): string {
	const suffix = createHash("sha256").update(path).digest("hex").slice(0, 8);
	return join(dirname(path), `bind-${suffix}`);
}

async function removeStaleSocket(path: string): Promise<void> {
	let original: Stats;
	try {
		original = await lstat(path);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return;
		throw error;
	}
	if (!original.isSocket()) throw new Error(`Refusing to remove non-socket Unix listener path: ${path}`);
	if (await isSocketLive(path)) throw new Error(`Unix listener is already running: ${path}`);

	const preserved = join(dirname(path), `stale-${randomUUID().slice(0, 6)}`);
	try {
		await rename(path, preserved);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return;
		throw error;
	}
	const current = await lstat(preserved);
	if (!current.isSocket() || current.dev !== original.dev || current.ino !== original.ino) {
		try {
			await lstat(path);
		} catch (error) {
			if (isErrorCode(error, "ENOENT")) await rename(preserved, path);
			else throw error;
		}
		throw new Error(`Unix listener path changed while checking for a stale socket: ${path}`);
	}
	await removePath(preserved);
}

async function removePath(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (!isErrorCode(error, "ENOENT")) throw error;
	}
}

function isSocketLive(path: string): Promise<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		const socket = createConnection(path);
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = (result: boolean, error?: Error): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			socket.removeAllListeners();
			socket.destroy();
			if (error) reject(error);
			else resolve(result);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", (error: NodeJS.ErrnoException) => {
			if (["ECONNREFUSED", "ENOENT", "EPIPE", "ECONNRESET"].includes(error.code ?? "")) {
				finish(false);
				return;
			}
			finish(false, error);
		});
		timer = setTimeout(() => finish(true), SOCKET_PROBE_TIMEOUT_MS);
		timer.unref();
	});
}

async function setSocketMode(path: string, mode: number): Promise<void> {
	if (process.platform === "win32") return;
	try {
		await chmod(path, mode);
	} catch (error) {
		if (!isErrorCode(error, "ENOSYS") && !isErrorCode(error, "ENOTSUP")) throw error;
	}
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

function isErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

export function createUnixListener(options: UnixListenerOptions): ServerListener {
	return new UnixListener(options);
}

function resolveUnixListenerOptions(options: UnixListenerOptions): ResolvedUnixListenerOptions {
	if (!options.path) throw new TypeError("Server Unix socket path must not be empty");
	const mode = options.mode ?? DEFAULT_SOCKET_MODE;
	if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
		throw new TypeError("Server Unix socket mode must be an integer between 0 and 0o777");
	}
	const maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	if (!Number.isSafeInteger(maxFrameLength) || maxFrameLength <= 0 || maxFrameLength > MAX_UINT32) {
		throw new TypeError(`Server maxFrameLength must be an integer between 1 and ${MAX_UINT32}`);
	}
	const maxPendingBytes = options.maxPendingBytes ?? maxFrameLength * 4;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < maxFrameLength + 4) {
		throw new TypeError("Server maxPendingBytes must be a safe integer at least maxFrameLength + 4");
	}
	const gracefulCloseTimeoutMs = options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(gracefulCloseTimeoutMs) ||
		gracefulCloseTimeoutMs <= 0 ||
		gracefulCloseTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new TypeError(`Server gracefulCloseTimeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
	}
	return {
		path: options.path,
		mode,
		maxPendingBytes,
		gracefulCloseTimeoutMs,
		onError: options.onError,
	};
}
