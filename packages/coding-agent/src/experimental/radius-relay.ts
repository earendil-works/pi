import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers, Client } from "@earendil-works/pi-client";
import { DEFAULT_MAX_FRAME_LENGTH, type ServerId } from "@earendil-works/pi-protocol";
import type { Server } from "@earendil-works/pi-server";
import { WebSocket } from "undici";
import type { RadiusRelayAuthResolver } from "./radius-auth.ts";

export const RADIUS_RELAY_HOST_SUBPROTOCOL = "pi-session-relay.host.v1";
export const RADIUS_RELAY_CLIENT_SUBPROTOCOL = "pi-session-relay.client.v1";

const RELAY_DATA_HEADER_BYTES = 18;
const RELAY_DATA_FRAME_VERSION = 1;
const RELAY_DATA_FRAME_TYPE = 1;
const CONNECTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_PENDING_BYTES = DEFAULT_MAX_FRAME_LENGTH * 4;
const DRAIN_THRESHOLD_BYTES = 1024 * 1024;
const HOST_RETRY_INITIAL_MS = 1_000;
const HOST_RETRY_MAX_MS = 30_000;
const MISSING_AUTH_RETRY_MS = 30_000;
const CLIENT_RETRY_INITIAL_MS = 1_000;
const CLIENT_RETRY_MAX_MS = 30_000;
// Undici implements the browser WebSocket API, which permits callers to send
// only code 1000 or application codes from 3000 through 4999. RFC protocol
// codes such as 1002 and 1011 may be received but cannot be passed to close().
const LOCAL_PROTOCOL_ERROR_CLOSE_CODE = 4000;
const LOCAL_TRANSPORT_ERROR_CLOSE_CODE = 4001;

interface RadiusRelayMessageEvent extends Event {
	readonly data: unknown;
}

interface RadiusRelayCloseEvent extends Event {
	readonly code: number;
	readonly reason: string;
}

interface RadiusRelayErrorEvent extends Event {
	readonly error?: unknown;
	readonly message?: string;
}

export interface RadiusRelayWebSocket {
	binaryType: "arraybuffer" | "blob";
	readonly bufferedAmount: number;
	readonly protocol: string;
	readonly readyState: number;
	readonly OPEN: number;
	send(data: string | ArrayBuffer): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open", listener: (event: Event) => void, options?: { once?: boolean }): void;
	addEventListener(
		type: "message",
		listener: (event: RadiusRelayMessageEvent) => void,
		options?: { once?: boolean },
	): void;
	addEventListener(
		type: "close",
		listener: (event: RadiusRelayCloseEvent) => void,
		options?: { once?: boolean },
	): void;
	addEventListener(
		type: "error",
		listener: (event: RadiusRelayErrorEvent) => void,
		options?: { once?: boolean },
	): void;
	removeEventListener(type: "open", listener: (event: Event) => void): void;
	removeEventListener(type: "message", listener: (event: RadiusRelayMessageEvent) => void): void;
	removeEventListener(type: "close", listener: (event: RadiusRelayCloseEvent) => void): void;
	removeEventListener(type: "error", listener: (event: RadiusRelayErrorEvent) => void): void;
}

export type RadiusRelayWebSocketFactory = (options: {
	readonly url: string;
	readonly protocol: string;
	readonly authorization: string;
}) => RadiusRelayWebSocket;

interface RelayByteConnection {
	readonly closed: boolean;
	send(chunk: Uint8Array): Promise<void>;
	close(finalChunk?: Uint8Array): Promise<void>;
}

interface RelayByteConnectionHandler {
	onData(chunk: Uint8Array): void;
	onClose(): void;
	onError(error: Error): void;
}

export type RadiusRelayHostStatus =
	| { readonly status: "not_authenticated" }
	| { readonly status: "connecting" }
	| { readonly status: "connected" }
	| { readonly status: "retrying"; readonly error: string };

export interface RadiusRelayHostOptions {
	readonly serverId: ServerId;
	readonly server: Pick<Server, "accept">;
	readonly auth: RadiusRelayAuthResolver;
	readonly webSocketFactory?: RadiusRelayWebSocketFactory;
	readonly onStatus?: (status: RadiusRelayHostStatus) => void;
}

/** Maintain the experimental server's multiplexed, authenticated Radius host connection. */
export class RadiusRelayHost {
	readonly #options: RadiusRelayHostOptions;
	readonly #abortController = new AbortController();
	readonly #connections = new Map<
		string,
		{ connection: RelayServerByteConnection; handler: RelayByteConnectionHandler }
	>();
	#socket: RadiusRelayWebSocket | undefined;
	#writer: OrderedWebSocketWriter | undefined;
	#loop: Promise<void> | undefined;
	#closed = false;

	constructor(options: RadiusRelayHostOptions) {
		this.#options = options;
	}

	start(): void {
		if (this.#loop !== undefined) return;
		this.#loop = this.#run();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#abortController.abort();
		this.#writer?.close();
		this.#socket?.close(1000, "Pi server stopped");
		this.#dropConnections();
		await this.#loop;
	}

	async #run(): Promise<void> {
		let retryMs = HOST_RETRY_INITIAL_MS;
		while (!this.#closed) {
			try {
				const auth = await this.#options.auth.resolve({
					required: false,
					signal: this.#abortController.signal,
				});
				if (auth === undefined) {
					this.#options.onStatus?.({ status: "not_authenticated" });
					await delay(MISSING_AUTH_RETRY_MS, this.#abortController.signal, true);
					continue;
				}

				this.#options.onStatus?.({ status: "connecting" });
				const socket = await openRadiusRelayWebSocket(
					relayWebSocketUrl(auth.gateway, this.#options.serverId),
					RADIUS_RELAY_HOST_SUBPROTOCOL,
					auth.token,
					this.#options.webSocketFactory ?? defaultWebSocketFactory,
					this.#abortController.signal,
				);
				retryMs = HOST_RETRY_INITIAL_MS;
				this.#options.onStatus?.({ status: "connected" });
				await this.#serve(socket);
				if (!this.#closed) throw new Error("Radius relay host disconnected");
			} catch (error) {
				if (this.#closed || this.#abortController.signal.aborted) break;
				this.#options.onStatus?.({ status: "retrying", error: errorMessage(error) });
				try {
					await delay(retryMs, this.#abortController.signal, true);
				} catch {
					break;
				}
				retryMs = Math.min(retryMs * 2, HOST_RETRY_MAX_MS);
			}
		}
	}

	#serve(socket: RadiusRelayWebSocket): Promise<void> {
		this.#socket = socket;
		this.#writer = new OrderedWebSocketWriter(socket);
		return new Promise<void>((resolve, reject) => {
			let terminal = false;
			const cleanup = (): void => {
				socket.removeEventListener("message", onMessage);
				socket.removeEventListener("close", onClose);
				socket.removeEventListener("error", onError);
				this.#writer?.close();
				if (this.#socket === socket) {
					this.#socket = undefined;
					this.#writer = undefined;
				}
			};
			const finish = (error?: Error): void => {
				if (terminal) return;
				terminal = true;
				cleanup();
				this.#dropConnections(error);
				if (error) reject(error);
				else resolve();
			};
			const onMessage = (event: RadiusRelayMessageEvent): void => {
				try {
					this.#handleHostMessage(event.data);
				} catch (error) {
					closeWebSocket(socket, LOCAL_PROTOCOL_ERROR_CLOSE_CODE, "Radius relay protocol error");
					finish(toError(error));
				}
			};
			const onClose = (event: RadiusRelayCloseEvent): void => {
				finish(
					event.code === 1000
						? undefined
						: new Error(`Radius relay host closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`),
				);
			};
			const onError = (event: RadiusRelayErrorEvent): void => finish(webSocketError(event));
			socket.addEventListener("message", onMessage);
			socket.addEventListener("close", onClose);
			socket.addEventListener("error", onError);
		});
	}

	#handleHostMessage(value: unknown): void {
		if (typeof value === "string") {
			const control = parseHostControlMessage(value);
			switch (control.type) {
				case "ping":
					void this.#sendControl({ version: 1, type: "pong" }).catch(() => {
						if (this.#socket !== undefined) {
							closeWebSocket(this.#socket, LOCAL_TRANSPORT_ERROR_CLOSE_CODE, "Radius relay send failed");
						}
					});
					return;
				case "pong":
					return;
				case "connection_open":
					this.#openConnection(control.connection_id);
					return;
				case "connection_close":
					this.#remoteCloseConnection(control.connection_id);
					return;
			}
		}
		if (!(value instanceof ArrayBuffer)) throw new Error("Radius relay data message must be binary");
		const frame = parseRelayDataFrame(value);
		if (!frame) throw new Error("Invalid Radius relay data frame");
		const active = this.#connections.get(frame.connectionId);
		if (!active) {
			void this.#sendControl({
				version: 1,
				type: "connection_close",
				connection_id: frame.connectionId,
				code: 1000,
			});
			return;
		}
		active.handler.onData(new Uint8Array(frame.payload));
	}

	#openConnection(connectionId: string): void {
		if (this.#connections.has(connectionId)) throw new Error("Radius relay reused a connection ID");
		const connection = new RelayServerByteConnection(
			(chunk) => this.#sendData(connectionId, chunk),
			(finalChunk) => this.#serverCloseConnection(connectionId, finalChunk),
		);
		const handler = this.#options.server.accept(connection);
		if (connection.closed) {
			void this.#sendControl({ version: 1, type: "connection_close", connection_id: connectionId, code: 1012 });
		} else {
			this.#connections.set(connectionId, { connection, handler });
		}
	}

	#remoteCloseConnection(connectionId: string): void {
		const active = this.#connections.get(connectionId);
		if (!active) return;
		this.#connections.delete(connectionId);
		active.connection.markClosed();
		active.handler.onClose();
	}

	async #serverCloseConnection(connectionId: string, finalChunk?: Uint8Array): Promise<void> {
		if (!this.#connections.delete(connectionId)) return;
		if (finalChunk !== undefined) await this.#requireWriter().send(encodeRelayDataFrame(connectionId, finalChunk));
		await this.#sendControl({
			version: 1,
			type: "connection_close",
			connection_id: connectionId,
			code: 1000,
		});
	}

	#sendData(connectionId: string, chunk: Uint8Array): Promise<void> {
		if (!this.#connections.has(connectionId)) return Promise.reject(new Error("Radius relay connection is closed"));
		return this.#requireWriter().send(encodeRelayDataFrame(connectionId, chunk));
	}

	#sendControl(message: HostOutputControlMessage): Promise<void> {
		return this.#requireWriter().send(JSON.stringify(message));
	}

	#requireWriter(): OrderedWebSocketWriter {
		if (!this.#writer) throw new Error("Radius relay host is disconnected");
		return this.#writer;
	}

	#dropConnections(error?: Error): void {
		const connections = [...this.#connections.values()];
		this.#connections.clear();
		for (const active of connections) {
			active.connection.markClosed();
			if (error) active.handler.onError(error);
			else active.handler.onClose();
		}
	}
}

export function createRadiusClientTransportFactory(options: {
	readonly serverId: ServerId;
	readonly auth: RadiusRelayAuthResolver;
	readonly webSocketFactory?: RadiusRelayWebSocketFactory;
}): ByteTransportFactory {
	return async (handlers) => {
		const auth = await options.auth.resolve({ required: true });
		if (!auth) throw new Error("Radius authentication is required");
		const socket = await openRadiusRelayWebSocket(
			relayWebSocketUrl(auth.gateway, options.serverId),
			RADIUS_RELAY_CLIENT_SUBPROTOCOL,
			auth.token,
			options.webSocketFactory ?? defaultWebSocketFactory,
		);
		return new RadiusClientByteTransport(socket, handlers);
	};
}

type RadiusReconnectClient = Pick<
	Client,
	| "attachment"
	| "connected"
	| "connectionState"
	| "disconnect"
	| "onAttachmentChange"
	| "onConnectionStateChange"
	| "reconnect"
>;

/** Reconnect one established Radius client and restore its last selected Session. */
export class RadiusClientReconnect {
	readonly #client: RadiusReconnectClient;
	readonly #reattach: (sessionId: string) => Promise<void>;
	readonly #abortController = new AbortController();
	readonly #removeConnectionListener: () => void;
	readonly #removeAttachmentListener: () => void;
	#desiredSessionId: string | undefined;
	#reconnecting: Promise<void> | undefined;
	#disposed = false;

	constructor(client: RadiusReconnectClient, reattach: (sessionId: string) => Promise<void>) {
		this.#client = client;
		this.#reattach = reattach;
		this.#desiredSessionId = client.attachment?.sessionId;
		this.#removeAttachmentListener = client.onAttachmentChange((attachment) => {
			if (attachment !== undefined) this.#desiredSessionId = attachment.sessionId;
			else if (client.connected) this.#desiredSessionId = undefined;
		});
		this.#removeConnectionListener = client.onConnectionStateChange(({ state }) => {
			if (state === "disconnected" && !this.#disposed) this.#startReconnect();
		});
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#removeConnectionListener();
		this.#removeAttachmentListener();
		this.#abortController.abort();
		if (this.#client.connectionState !== "disconnected") {
			this.#client.disconnect("Radius reconnect stopped");
		}
		await this.#reconnecting;
	}

	#startReconnect(): void {
		if (this.#reconnecting !== undefined) return;
		this.#reconnecting = this.#runReconnect().finally(() => {
			this.#reconnecting = undefined;
		});
	}

	async #runReconnect(): Promise<void> {
		let retryMs = CLIENT_RETRY_INITIAL_MS;
		while (!this.#disposed && !this.#client.connected) {
			try {
				await delay(retryMs, this.#abortController.signal, false);
				await this.#client.reconnect();
				const sessionId = this.#desiredSessionId;
				if (sessionId !== undefined) await this.#reattach(sessionId);
				return;
			} catch (error) {
				if (this.#disposed || this.#abortController.signal.aborted) return;
				if (this.#client.connected) this.#client.disconnect(errorMessage(error));
				retryMs = Math.min(retryMs * 2, CLIENT_RETRY_MAX_MS);
			}
		}
	}
}

class RelayServerByteConnection implements RelayByteConnection {
	readonly #sendChunk: (chunk: Uint8Array) => Promise<void>;
	readonly #closeConnection: (finalChunk?: Uint8Array) => Promise<void>;
	#closed = false;

	constructor(
		sendChunk: (chunk: Uint8Array) => Promise<void>,
		closeConnection: (finalChunk?: Uint8Array) => Promise<void>,
	) {
		this.#sendChunk = sendChunk;
		this.#closeConnection = closeConnection;
	}

	get closed(): boolean {
		return this.#closed;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("Radius relay connection is closed"));
		return this.#sendChunk(chunk);
	}

	async close(finalChunk?: Uint8Array): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#closeConnection(finalChunk);
	}

	markClosed(): void {
		this.#closed = true;
	}
}

class RadiusClientByteTransport implements ByteTransport {
	readonly #socket: RadiusRelayWebSocket;
	readonly #handlers: ByteTransportHandlers;
	readonly #writer: OrderedWebSocketWriter;
	readonly #onMessage: (event: RadiusRelayMessageEvent) => void;
	readonly #onClose: (event: RadiusRelayCloseEvent) => void;
	readonly #onError: (event: RadiusRelayErrorEvent) => void;
	#closed = false;

	constructor(socket: RadiusRelayWebSocket, handlers: ByteTransportHandlers) {
		this.#socket = socket;
		this.#handlers = handlers;
		this.#writer = new OrderedWebSocketWriter(socket);
		this.#onMessage = (event) => {
			if (this.#closed) return;
			if (!(event.data instanceof ArrayBuffer)) {
				this.#fail(new Error("Radius relay client received a non-binary message"));
				return;
			}
			this.#handlers.onData(new Uint8Array(event.data));
		};
		this.#onClose = () => {
			if (this.#markClosed()) this.#handlers.onClose();
		};
		this.#onError = (event) => this.#fail(webSocketError(event));
		socket.addEventListener("message", this.#onMessage);
		socket.addEventListener("close", this.#onClose);
		socket.addEventListener("error", this.#onError);
	}

	send(chunk: Uint8Array): Promise<void> {
		if (!(chunk instanceof Uint8Array))
			return Promise.reject(new TypeError("Radius relay chunks must be Uint8Array"));
		if (this.#closed) return Promise.reject(new Error("Radius relay client is closed"));
		return this.#writer.send(chunk.slice().buffer);
	}

	close(): void {
		if (!this.#markClosed()) return;
		this.#socket.close(1000, "Pi client closed");
	}

	#fail(error: Error): void {
		if (!this.#markClosed()) return;
		closeWebSocket(this.#socket, LOCAL_TRANSPORT_ERROR_CLOSE_CODE, "Radius relay transport error");
		this.#handlers.onError(error);
	}

	#markClosed(): boolean {
		if (this.#closed) return false;
		this.#closed = true;
		this.#writer.close();
		this.#socket.removeEventListener("message", this.#onMessage);
		this.#socket.removeEventListener("close", this.#onClose);
		this.#socket.removeEventListener("error", this.#onError);
		return true;
	}
}

class OrderedWebSocketWriter {
	readonly #socket: RadiusRelayWebSocket;
	#tail: Promise<void> = Promise.resolve();
	#pendingBytes = 0;
	#closed = false;

	constructor(socket: RadiusRelayWebSocket) {
		this.#socket = socket;
	}

	send(value: string | ArrayBuffer): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("Radius relay WebSocket is closed"));
		const copied = typeof value === "string" ? value : value.slice(0);
		const byteLength = typeof copied === "string" ? Buffer.byteLength(copied) : copied.byteLength;
		if (this.#pendingBytes + byteLength > MAX_PENDING_BYTES) {
			return Promise.reject(new Error("Radius relay exceeded its pending byte limit"));
		}
		this.#pendingBytes += byteLength;
		const operation = this.#tail.then(async () => {
			if (this.#closed || this.#socket.readyState !== this.#socket.OPEN) {
				throw new Error("Radius relay WebSocket is closed");
			}
			this.#socket.send(copied);
			while (this.#socket.bufferedAmount > DRAIN_THRESHOLD_BYTES) {
				if (this.#closed || this.#socket.readyState !== this.#socket.OPEN) {
					throw new Error("Radius relay WebSocket closed during write");
				}
				await delay(5, undefined, false);
			}
		});
		const tracked = operation.finally(() => {
			this.#pendingBytes -= byteLength;
		});
		this.#tail = tracked.catch(() => {});
		return tracked;
	}

	close(): void {
		this.#closed = true;
	}
}

type HostInputControlMessage =
	| { readonly version: 1; readonly type: "ping" | "pong" }
	| { readonly version: 1; readonly type: "connection_open"; readonly connection_id: string }
	| {
			readonly version: 1;
			readonly type: "connection_close";
			readonly connection_id: string;
			readonly code?: number;
	  };

type HostOutputControlMessage =
	| { readonly version: 1; readonly type: "pong" }
	| {
			readonly version: 1;
			readonly type: "connection_close";
			readonly connection_id: string;
			readonly code?: number;
	  };

function parseHostControlMessage(value: string): HostInputControlMessage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("Invalid Radius relay control message");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Invalid Radius relay control message");
	}
	const message = parsed as { version?: unknown; type?: unknown; connection_id?: unknown; code?: unknown };
	if (message.version !== 1) throw new Error("Unsupported Radius relay control version");
	if (message.type === "ping" || message.type === "pong") return { version: 1, type: message.type };
	if (
		(message.type === "connection_open" || message.type === "connection_close") &&
		typeof message.connection_id === "string" &&
		CONNECTION_ID_PATTERN.test(message.connection_id) &&
		(message.code === undefined ||
			(typeof message.code === "number" &&
				Number.isInteger(message.code) &&
				message.code >= 1000 &&
				message.code <= 4999))
	) {
		return message.type === "connection_open"
			? { version: 1, type: "connection_open", connection_id: message.connection_id }
			: {
					version: 1,
					type: "connection_close",
					connection_id: message.connection_id,
					...(message.code === undefined ? {} : { code: message.code }),
				};
	}
	throw new Error("Invalid Radius relay control message");
}

export function encodeRelayDataFrame(connectionId: string, payload: Uint8Array): ArrayBuffer {
	if (!CONNECTION_ID_PATTERN.test(connectionId)) throw new TypeError("Invalid Radius relay connection ID");
	const frame = new Uint8Array(RELAY_DATA_HEADER_BYTES + payload.byteLength);
	frame[0] = RELAY_DATA_FRAME_VERSION;
	frame[1] = RELAY_DATA_FRAME_TYPE;
	const hex = connectionId.replaceAll("-", "");
	for (let index = 0; index < 16; index++) {
		frame[index + 2] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	frame.set(payload, RELAY_DATA_HEADER_BYTES);
	return frame.buffer;
}

export function parseRelayDataFrame(
	frame: ArrayBuffer,
): { readonly connectionId: string; readonly payload: ArrayBuffer } | undefined {
	if (frame.byteLength < RELAY_DATA_HEADER_BYTES) return undefined;
	const bytes = new Uint8Array(frame);
	if (bytes[0] !== RELAY_DATA_FRAME_VERSION || bytes[1] !== RELAY_DATA_FRAME_TYPE) return undefined;
	let hex = "";
	for (const byte of bytes.subarray(2, RELAY_DATA_HEADER_BYTES)) hex += byte.toString(16).padStart(2, "0");
	const connectionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	if (!CONNECTION_ID_PATTERN.test(connectionId)) return undefined;
	return { connectionId, payload: frame.slice(RELAY_DATA_HEADER_BYTES) };
}

function relayWebSocketUrl(gateway: string, serverId: ServerId): string {
	const url = new URL(`/v1/session-relays/${serverId}/connect`, gateway);
	if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol === "http:") url.protocol = "ws:";
	else throw new Error(`Unsupported Radius gateway protocol: ${url.protocol}`);
	return url.toString();
}

function defaultWebSocketFactory(options: {
	readonly url: string;
	readonly protocol: string;
	readonly authorization: string;
}): RadiusRelayWebSocket {
	return new WebSocket(options.url, {
		protocols: [options.protocol],
		headers: { authorization: options.authorization },
	}) as unknown as RadiusRelayWebSocket;
}

function openRadiusRelayWebSocket(
	url: string,
	protocol: string,
	token: string,
	factory: RadiusRelayWebSocketFactory,
	signal?: AbortSignal,
): Promise<RadiusRelayWebSocket> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const socket = factory({ url, protocol, authorization: `Bearer ${token}` });
		socket.binaryType = "arraybuffer";
		let settled = false;
		const cleanup = (): void => {
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("close", onClose);
			socket.removeEventListener("error", onError);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			closeWebSocket(socket, 1000, "Radius relay connection failed");
			reject(error);
		};
		const onOpen = (): void => {
			if (settled) return;
			if (socket.protocol !== protocol) {
				fail(new Error(`Radius relay selected unexpected WebSocket protocol ${JSON.stringify(socket.protocol)}`));
				return;
			}
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onClose = (event: RadiusRelayCloseEvent): void =>
			fail(new Error(`Radius relay closed before connecting (${event.code})`));
		const onError = (event: RadiusRelayErrorEvent): void => fail(webSocketError(event));
		const onAbort = (): void => fail(new Error("Radius relay connection cancelled"));
		socket.addEventListener("open", onOpen, { once: true });
		socket.addEventListener("close", onClose, { once: true });
		socket.addEventListener("error", onError, { once: true });
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function closeWebSocket(socket: RadiusRelayWebSocket, code: number, reason: string): void {
	try {
		socket.close(code, reason);
	} catch {
		// A WebSocket can reject close() while its opening handshake is still pending.
	}
}

function webSocketError(event: RadiusRelayErrorEvent): Error {
	if (event.error instanceof Error && event.error.message.trim().length > 0) return event.error;
	return new Error(event.message?.trim() || "Radius WebSocket connection failed");
}

function delay(milliseconds: number, signal: AbortSignal | undefined, unref: boolean): Promise<void> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, milliseconds);
		if (unref) timer.unref();
		const onAbort = (): void => {
			clearTimeout(timer);
			cleanup();
			try {
				signal?.throwIfAborted();
			} catch (error) {
				reject(error);
			}
		};
		const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
	return toError(error).message;
}
