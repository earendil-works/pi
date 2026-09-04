import { lstat, readdir } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import {
	DEFAULT_MAX_FRAME_LENGTH,
	isServerId,
	ProtocolValidationError,
	type ServerId,
} from "@earendil-works/pi-protocol";
import { Client } from "./client.ts";
import { DisconnectedError, ServerError } from "./errors.ts";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const UNIX_SOCKET_SUFFIX = ".sock";
const MAX_CONCURRENT_DISCOVERY_PROBES = 16;

export interface UnixTransportOptions {
	path: string;
	maxPendingBytes?: number;
}

export interface UnixServerRoute {
	serverId: ServerId;
	path: string;
}

export interface DiscoverUnixServersOptions {
	/** Directory containing server-addressed Unix sockets. */
	directory: string;
	/** Maximum time for each connection and handshake. Defaults to 1,000 ms. */
	timeoutMs?: number;
}

/** Discover reachable local servers by probing server-addressed Unix sockets. */
export async function discoverUnixServers(options: DiscoverUnixServersOptions): Promise<UnixServerRoute[]> {
	if (process.platform === "win32") throw new Error("Unix transport is not supported on Windows");
	const directory = options.directory;
	const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
		throw new TypeError(`Unix discovery timeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
	}

	let names: string[];
	try {
		names = await readdir(directory);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) return [];
		throw error;
	}

	const candidates = names.flatMap((name): UnixServerRoute[] => {
		if (!name.endsWith(UNIX_SOCKET_SUFFIX)) return [];
		const serverId = name.slice(0, -UNIX_SOCKET_SUFFIX.length);
		return isServerId(serverId) ? [{ serverId, path: join(directory, name) }] : [];
	});
	const routes: UnixServerRoute[] = [];
	let nextIndex = 0;
	let failure: { error: unknown } | undefined;
	const workerCount = Math.min(MAX_CONCURRENT_DISCOVERY_PROBES, candidates.length);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (!failure) {
				const candidate = candidates[nextIndex++];
				if (!candidate) return;
				try {
					try {
						if (!(await lstat(candidate.path)).isSocket()) continue;
					} catch (error) {
						// A socket can disappear between readdir and lstat during normal server shutdown.
						if (isErrorCode(error, "ENOENT")) continue;
						throw error;
					}
					const route = await probeUnixServer(candidate, timeoutMs);
					if (route) routes.push(route);
				} catch (error) {
					failure ??= { error };
				}
			}
		}),
	);
	if (failure) throw failure.error;
	return routes.sort((left, right) => left.serverId.localeCompare(right.serverId));
}

/** Creates fresh Unix-domain socket transports for Client connection attempts in Node-compatible runtimes. */
export function createUnixTransportFactory(options: UnixTransportOptions): ByteTransportFactory {
	const maxPendingBytes = validateUnixTransportOptions(options);
	return (handlers) => connectUnixSocket(options.path, maxPendingBytes, handlers);
}

function validateUnixTransportOptions(options: UnixTransportOptions): number {
	if (options.path.length === 0) throw new TypeError("Unix transport path must not be empty");
	const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_FRAME_LENGTH * 4;
	if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) {
		throw new TypeError("Unix transport maxPendingBytes must be a positive safe integer");
	}
	if (process.platform === "win32") throw new Error("Unix transport is not supported on Windows");
	return maxPendingBytes;
}

function connectUnixSocket(
	path: string,
	maxPendingBytes: number,
	handlers: ByteTransportHandlers,
	onSocket?: (socket: Socket) => void,
): Promise<ByteTransport> {
	return new Promise<ByteTransport>((resolve, reject) => {
		const socket = createConnection(path);
		onSocket?.(socket);
		let connected = false;
		let terminal = false;

		const close = (): void => {
			if (terminal) return;
			terminal = true;
			socket.destroy();
			if (connected) handlers.onClose();
			else reject(new Error("Unix transport closed before connecting"));
		};

		socket.once("connect", () => {
			if (terminal) return;
			connected = true;
			resolve(
				new UnixByteTransport(socket, maxPendingBytes, () => {
					terminal = true;
				}),
			);
		});
		socket.on("data", (chunk) => {
			if (!terminal) handlers.onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		});
		socket.once("end", close);
		socket.once("close", close);
		socket.once("error", (error) => {
			if (terminal) return;
			terminal = true;
			socket.destroy();
			if (connected) handlers.onError(error);
			else reject(error);
		});
	});
}

class UnixByteTransport implements ByteTransport {
	readonly #socket: Socket;
	readonly #maxPendingBytes: number;
	readonly #markLocalClose: () => void;
	#closed = false;
	#pendingBytes = 0;
	#writeTail: Promise<void> = Promise.resolve();

	constructor(socket: Socket, maxPendingBytes: number, markLocalClose: () => void) {
		this.#socket = socket;
		this.#maxPendingBytes = maxPendingBytes;
		this.#markLocalClose = markLocalClose;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array)) {
			return Promise.reject(new TypeError("Unix transport chunks must be Uint8Array"));
		}
		if (this.#closed) return Promise.reject(new Error("Unix transport is closed"));
		if (this.#pendingBytes + chunk.byteLength > this.#maxPendingBytes) {
			return Promise.reject(new Error("Unix transport exceeded its pending byte limit"));
		}
		this.#pendingBytes += chunk.byteLength;
		const bytes = chunk.slice();
		const write = this.#writeTail.then(() => this.#write(bytes));
		const tracked = write.finally(() => {
			this.#pendingBytes -= bytes.byteLength;
		});
		this.#writeTail = tracked.catch(() => {});
		return tracked;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#markLocalClose();
		this.#socket.destroy();
	}

	#write(chunk: Uint8Array): Promise<void> {
		if (this.#closed || !this.#socket.writable) return Promise.reject(new Error("Unix transport is closed"));
		return new Promise<void>((resolve, reject) => {
			let callbackComplete = false;
			let drainComplete = false;
			let requiresDrain: boolean | undefined;
			let settled = false;

			const onDrain = (): void => {
				drainComplete = true;
				finish();
			};
			const cleanup = (): void => {
				this.#socket.off("drain", onDrain);
				this.#socket.off("close", onClose);
			};
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const finish = (): void => {
				if (settled || !callbackComplete || requiresDrain === undefined) return;
				if (requiresDrain && !drainComplete) return;
				settled = true;
				cleanup();
				resolve();
			};
			const onClose = (): void => fail(new Error("Unix transport closed during write"));

			try {
				this.#socket.once("close", onClose);
				const accepted = this.#socket.write(chunk, (error) => {
					if (error) {
						fail(error);
						return;
					}
					callbackComplete = true;
					finish();
				});
				requiresDrain = !accepted;
				if (requiresDrain) this.#socket.once("drain", onDrain);
				finish();
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
}

async function probeUnixServer(route: UnixServerRoute, timeoutMs: number): Promise<UnixServerRoute | undefined> {
	const maxPendingBytes = validateUnixTransportOptions({ path: route.path });
	let socket: Socket | undefined;
	const client = new Client({
		serverId: route.serverId,
		transportFactory: (handlers) =>
			connectUnixSocket(route.path, maxPendingBytes, handlers, (created) => {
				socket = created;
			}),
	});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			client.connect(),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					socket?.destroy();
					reject(new UnixDiscoveryTimeoutError());
				}, timeoutMs);
				timeout.unref();
			}),
		]);
		return route;
	} catch (error) {
		// Missing/refused sockets are stale or shutting down. Protocol failures mean
		// the endpoint is not the advertised server. Both are safe to omit.
		if (
			error instanceof UnixDiscoveryTimeoutError ||
			error instanceof ProtocolValidationError ||
			(error instanceof DisconnectedError && error.cause === undefined) ||
			(error instanceof ServerError && error.code === "version") ||
			isErrorCode(error, "ENOENT") ||
			isErrorCode(error, "ECONNREFUSED") ||
			isErrorCode(error, "ECONNRESET") ||
			isErrorCode(error, "EPIPE") ||
			isErrorCode(error, "ETIMEDOUT")
		) {
			return undefined;
		}
		throw error;
	} finally {
		if (timeout) clearTimeout(timeout);
		await client.dispose();
		const activeSocket = socket;
		if (activeSocket && !activeSocket.destroyed) activeSocket.destroy();
		if (activeSocket && !activeSocket.closed) {
			await new Promise<void>((resolve) => activeSocket.once("close", resolve));
		}
	}
}

class UnixDiscoveryTimeoutError extends Error {}

function isErrorCode(error: unknown, code: string): boolean {
	let current = error;
	const seen = new Set<unknown>();
	while (current instanceof Error && !seen.has(current)) {
		seen.add(current);
		if ("code" in current && current.code === code) return true;
		current = current.cause;
	}
	return false;
}
