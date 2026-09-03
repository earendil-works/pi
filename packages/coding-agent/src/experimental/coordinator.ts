import { randomUUID } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";
import {
	consumeInternalProcessRole,
	encodeControlLine,
	isDirectInternalProcessEntry,
	MAX_CONTROL_LINE_BYTES,
	spawnInternalProcess,
} from "./process.ts";

export const COORDINATOR_PROTOCOL_VERSION = 3;
const COORDINATOR_START_TIMEOUT_MS = 10_000;
const COORDINATOR_RETRY_MS = 10;

const CoordinatorMessageSchema = Type.Union([
	Type.Object({
		type: Type.Literal("server_registered"),
		serverConnectionId: Type.String(),
		peers: Type.Array(Type.String()),
	}),
	Type.Object({ type: Type.Literal("server_replaced") }),
	Type.Object({ type: Type.Literal("peer_connected"), peerId: Type.String() }),
	Type.Object({ type: Type.Literal("peer_disconnected"), peerId: Type.String() }),
	Type.Object({ type: Type.Literal("message"), from: Type.String(), payload: Type.Unknown() }),
]);
type CoordinatorMessage = Static<typeof CoordinatorMessageSchema>;

export type CoordinatorConnectionEvent =
	| { readonly type: "peer_connected"; readonly peerId: string }
	| { readonly type: "peer_disconnected"; readonly peerId: string }
	| { readonly type: "message"; readonly from: string; readonly payload: unknown };

export interface CoordinatorConnectionOptions {
	readonly controlPath: string;
	readonly endpoint: string;
	readonly serverConnectionId?: string;
}

/** The server-side endpoint of the coordinator's intentionally opaque message router. */
export class CoordinatorConnection {
	readonly serverConnectionId: string;
	readonly replaced: Promise<void>;
	readonly peerIds = new Set<string>();
	readonly #controlPath: string;
	readonly #endpoint: string;
	readonly #listeners = new Set<(event: CoordinatorConnectionEvent) => void>();
	#socket?: Socket;
	#registered = false;
	#closed = false;
	#replacedValue = false;
	#resolveRegistered?: () => void;
	#rejectRegistered?: (error: Error) => void;
	#resolveReplaced!: () => void;

	constructor(options: CoordinatorConnectionOptions) {
		this.serverConnectionId = options.serverConnectionId ?? randomUUID();
		this.#controlPath = options.controlPath;
		this.#endpoint = options.endpoint;
		this.replaced = new Promise((resolve) => {
			this.#resolveReplaced = resolve;
		});
	}

	get controlPath(): string {
		return this.#controlPath;
	}

	get wasReplaced(): boolean {
		return this.#replacedValue;
	}

	onEvent(listener: (event: CoordinatorConnectionEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async connect(): Promise<void> {
		if (this.#socket) throw new Error("Coordinator server is already connected");
		const socket = await connectSocket(this.#controlPath);
		this.#socket = socket;
		attachJsonLineReader(socket, (message) => this.#handleMessage(message));
		const registered = new Promise<void>((resolve, reject) => {
			this.#resolveRegistered = resolve;
			this.#rejectRegistered = reject;
		});
		socket.once("close", () => this.#disconnected(new Error("Coordinator connection closed")));
		socket.once("error", (error) => this.#disconnected(error));
		await writeJsonLine(socket, {
			type: "register_server",
			protocol: COORDINATOR_PROTOCOL_VERSION,
			serverConnectionId: this.serverConnectionId,
			endpoint: this.#endpoint,
		});
		await registered;
	}

	send(peerId: string, payload: unknown): Promise<void> {
		return this.#write({ type: "send", to: peerId, payload });
	}

	broadcast(payload: unknown): Promise<void> {
		return this.#write({ type: "broadcast", payload });
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#socket?.destroy();
		this.#socket = undefined;
		this.peerIds.clear();
		this.#rejectRegistered?.(new Error("Coordinator server closed"));
		this.#resolveRegistered = undefined;
		this.#rejectRegistered = undefined;
	}

	async #write(message: unknown): Promise<void> {
		if (!this.#registered || !this.#socket || this.#closed) throw new Error("Coordinator server is not connected");
		await writeJsonLine(this.#socket, message);
	}

	#handleMessage(value: unknown): void {
		if (!Check(CoordinatorMessageSchema, value)) {
			this.#socket?.destroy(new Error("Coordinator sent an invalid message"));
			return;
		}
		const message: CoordinatorMessage = value;
		if (message.type === "server_registered") {
			if (message.serverConnectionId !== this.serverConnectionId) {
				this.#socket?.destroy(new Error("Coordinator returned an invalid server registration"));
				return;
			}
			for (const peerId of message.peers) this.peerIds.add(peerId);
			this.#registered = true;
			this.#resolveRegistered?.();
			this.#resolveRegistered = undefined;
			this.#rejectRegistered = undefined;
			return;
		}
		if (message.type === "server_replaced") {
			this.#markReplaced();
			return;
		}
		if (message.type === "peer_connected") {
			this.peerIds.add(message.peerId);
			this.#emit({ type: "peer_connected", peerId: message.peerId });
			return;
		}
		if (message.type === "peer_disconnected") {
			this.peerIds.delete(message.peerId);
			this.#emit({ type: "peer_disconnected", peerId: message.peerId });
			return;
		}
		if (message.type === "message") {
			this.#emit({ type: "message", from: message.from, payload: message.payload });
			return;
		}
		this.#socket?.destroy(new Error("Coordinator sent an unsupported message"));
	}

	#emit(event: CoordinatorConnectionEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	#disconnected(error: Error): void {
		this.#socket = undefined;
		if (this.#closed) return;
		this.#rejectRegistered?.(error);
		this.#resolveRegistered = undefined;
		this.#rejectRegistered = undefined;
		this.#markReplaced();
	}

	#markReplaced(): void {
		if (this.#replacedValue) return;
		this.#replacedValue = true;
		this.#resolveReplaced();
	}
}

export interface CoordinatorStartupLease {
	close(): void;
}

export async function ensureCoordinator(publicPath: string, controlPath: string): Promise<CoordinatorStartupLease> {
	const existing = await tryConnect(controlPath);
	if (existing) return { close: () => existing.destroy() };
	const child = spawnInternalProcess("coordinator", [publicPath, controlPath]);
	const deadline = Date.now() + COORDINATOR_START_TIMEOUT_MS;
	while (true) {
		const socket = await tryConnect(controlPath);
		if (socket) return { close: () => socket.destroy() };
		if (child.exitCode !== null || child.signalCode !== null) throw new Error("Coordinator exited during startup");
		if (Date.now() >= deadline) throw new Error("Timed out waiting for coordinator startup");
		await new Promise<void>((resolve) => setTimeout(resolve, COORDINATOR_RETRY_MS));
	}
}

function connectSocket(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		const onConnect = (): void => {
			socket.off("error", onError);
			resolve(socket);
		};
		const onError = (error: Error): void => {
			socket.off("connect", onConnect);
			reject(error);
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});
}

async function tryConnect(path: string): Promise<Socket | undefined> {
	try {
		return await connectSocket(path);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code === "ENOENT" || code === "ECONNREFUSED") return undefined;
		throw error;
	}
}

function attachJsonLineReader(socket: Socket, onMessage: (message: unknown) => void): void {
	let buffered = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffered += chunk;
		if (Buffer.byteLength(buffered) > MAX_CONTROL_LINE_BYTES) {
			socket.destroy(new Error("Coordinator message is too large"));
			return;
		}
		while (true) {
			const newline = buffered.indexOf("\n");
			if (newline === -1) return;
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			try {
				onMessage(JSON.parse(line));
			} catch {
				socket.destroy(new Error("Coordinator sent invalid JSON"));
				return;
			}
		}
	});
}

function writeJsonLine(socket: Socket, message: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.write(encodeControlLine(message), (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

// This process is intentionally a transport shim. It depends only on Node
// built-ins and never interprets Pi, session, worker, or lifecycle payloads.

const EMPTY_STARTUP_GRACE_MS = 30_000;
const EMPTY_SHUTDOWN_GRACE_MS = 250;

interface ServerPeer {
	readonly serverConnectionId: string;
	readonly endpoint: string;
	readonly socket: Socket;
}

interface RoutedPeer {
	readonly peerId: string;
	readonly socket: Socket;
}

interface ControlMessage {
	readonly type: string;
	readonly protocol?: unknown;
	readonly serverConnectionId?: unknown;
	readonly endpoint?: unknown;
	readonly peerId?: unknown;
	readonly to?: unknown;
	readonly payload?: unknown;
}

let publicPath: string;
let controlPath: string;
let running = false;

const peers = new Map<string, RoutedPeer>();
const controlConnections = new Set<Socket>();
const publicConnections = new Map<Socket, Socket>();
let currentServer: ServerPeer | undefined;
let shuttingDown = false;
let emptyTimer: NodeJS.Timeout | undefined;

const publicServer = createServer((socket) => acceptPublicConnection(socket));
const controlServer = createServer((socket) => acceptControlConnection(socket));

export async function runCoordinatorProcess(args: readonly string[]): Promise<void> {
	if (running) throw new Error("Coordinator process is already running");
	const [requestedPublicPath, requestedControlPath] = args;
	if (!requestedPublicPath || !requestedControlPath) {
		throw new Error("Coordinator requires public and control socket paths");
	}
	publicPath = requestedPublicPath;
	controlPath = requestedControlPath;
	running = true;
	process.once("SIGINT", () => void shutdownCoordinator());
	process.once("SIGTERM", () => void shutdownCoordinator());
	await main();
}

async function main(): Promise<void> {
	await removeStaleSocket(controlPath);
	await removeStaleSocket(publicPath);
	try {
		await listen(controlServer, controlPath);
		await restrictSocket(controlPath);
		await listen(publicServer, publicPath);
		await restrictSocket(publicPath);
	} catch (error) {
		await Promise.all([cleanupSocket(controlPath), cleanupSocket(publicPath)]);
		throw error;
	}
	scheduleEmptyShutdown(EMPTY_STARTUP_GRACE_MS);
}

function acceptControlConnection(socket: Socket): void {
	if (shuttingDown) {
		socket.destroy();
		return;
	}
	controlConnections.add(socket);
	let server: ServerPeer | undefined;
	let peer: RoutedPeer | undefined;
	attachRoutedLineReader(socket, (message) => {
		if (!server && !peer) {
			if (message.type === "register_server") {
				server = registerServer(socket, message);
				return;
			}
			if (message.type === "register_peer") {
				peer = registerPeer(socket, message);
				return;
			}
			throw new Error("Coordinator connection did not register a role");
		}
		if (server) {
			if (server === currentServer) handleRoutedMessage("server", message);
			return;
		}
		handleRoutedMessage(peer!.peerId, message);
	});
	const disconnect = (): void => {
		controlConnections.delete(socket);
		if (server && currentServer === server) {
			currentServer = undefined;
			notifyPeers({ type: "server_disconnected", serverConnectionId: server.serverConnectionId });
		}
		if (peer && peers.get(peer.peerId) === peer) {
			peers.delete(peer.peerId);
			if (currentServer) writeRoutedLine(currentServer.socket, { type: "peer_disconnected", peerId: peer.peerId });
		}
		checkEmpty();
	};
	socket.once("close", disconnect);
	socket.once("error", () => socket.destroy());
}

function registerServer(socket: Socket, message: ControlMessage): ServerPeer {
	if (message.protocol !== COORDINATOR_PROTOCOL_VERSION) throw new Error("Unsupported coordinator protocol");
	if (typeof message.serverConnectionId !== "string" || message.serverConnectionId.length === 0) {
		throw new Error("Coordinator serverConnectionId must be a string");
	}
	if (typeof message.endpoint !== "string" || message.endpoint.length === 0) {
		throw new Error("Coordinator endpoint must be a string");
	}
	const { serverConnectionId, endpoint } = message;
	const server = { serverConnectionId, endpoint, socket };
	const previous = currentServer;
	currentServer = server;
	cancelEmptyShutdown();
	writeRoutedLine(socket, {
		type: "server_registered",
		serverConnectionId,
		peers: [...peers.keys()],
	});
	if (previous && previous !== server) {
		closePublicConnections();
		notifyPeers({ type: "server_disconnected", serverConnectionId: previous.serverConnectionId });
		writeRoutedLine(previous.socket, { type: "server_replaced" });
	}
	notifyPeers({ type: "server_connected", serverConnectionId });
	return server;
}

function registerPeer(socket: Socket, message: ControlMessage): RoutedPeer {
	if (message.protocol !== COORDINATOR_PROTOCOL_VERSION) throw new Error("Unsupported coordinator protocol");
	if (typeof message.peerId !== "string" || message.peerId.length === 0) {
		throw new Error("Coordinator peerId must be a string");
	}
	const { peerId } = message;
	if (peerId === "server" || peers.has(peerId)) throw new Error(`Coordinator peer is already connected: ${peerId}`);
	const peer = { peerId, socket };
	peers.set(peerId, peer);
	cancelEmptyShutdown();
	writeRoutedLine(socket, {
		type: "peer_registered",
		peerId,
		...(currentServer === undefined ? {} : { serverConnectionId: currentServer.serverConnectionId }),
	});
	if (currentServer) {
		writeRoutedLine(currentServer.socket, { type: "peer_connected", peerId });
	}
	return peer;
}

function notifyPeers(message: unknown): void {
	for (const peer of peers.values()) writeRoutedLine(peer.socket, message);
}

function handleRoutedMessage(from: string, message: ControlMessage): void {
	if (message.type === "send") {
		if (typeof message.to !== "string" || message.to.length === 0) {
			throw new Error("Coordinator message target must be a string");
		}
		const { to } = message;
		const target = to === "server" ? currentServer?.socket : peers.get(to)?.socket;
		if (target) writeRoutedLine(target, { type: "message", from, payload: message.payload });
		return;
	}
	if (message.type === "broadcast") {
		if (from !== "server") throw new Error("Only the current server may broadcast");
		for (const peer of peers.values()) {
			writeRoutedLine(peer.socket, { type: "message", from, payload: message.payload });
		}
		return;
	}
	throw new Error(`Unknown coordinator routing message: ${message.type}`);
}

function acceptPublicConnection(client: Socket): void {
	if (shuttingDown || !currentServer) {
		client.destroy();
		return;
	}
	cancelEmptyShutdown();
	const upstream = createConnection(currentServer.endpoint);
	publicConnections.set(client, upstream);
	let finalized = false;
	const finalize = (): void => {
		if (finalized) return;
		finalized = true;
		publicConnections.delete(client);
		checkEmpty();
	};
	upstream.once("connect", () => {
		client.pipe(upstream);
		upstream.pipe(client);
	});
	upstream.once("error", () => client.destroy());
	upstream.once("close", () => {
		client.destroy();
		finalize();
	});
	client.once("error", () => upstream.destroy());
	client.once("close", () => {
		upstream.destroy();
		finalize();
	});
}

function closePublicConnections(): void {
	for (const [client, upstream] of publicConnections) {
		client.destroy();
		upstream.destroy();
	}
	publicConnections.clear();
}

function checkEmpty(): void {
	if (shuttingDown || currentServer || peers.size > 0 || publicConnections.size > 0 || controlConnections.size > 0) {
		cancelEmptyShutdown();
		return;
	}
	scheduleEmptyShutdown(EMPTY_SHUTDOWN_GRACE_MS);
}

function scheduleEmptyShutdown(delayMs: number): void {
	if (emptyTimer || shuttingDown) return;
	emptyTimer = setTimeout(() => {
		emptyTimer = undefined;
		if (!currentServer && peers.size === 0 && publicConnections.size === 0 && controlConnections.size === 0) {
			void shutdownCoordinator();
		}
	}, delayMs);
	emptyTimer.unref();
}

function cancelEmptyShutdown(): void {
	if (!emptyTimer) return;
	clearTimeout(emptyTimer);
	emptyTimer = undefined;
}

async function shutdownCoordinator(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	cancelEmptyShutdown();
	closePublicConnections();
	for (const connection of controlConnections) connection.destroy();
	await Promise.all([closeServer(publicServer), closeServer(controlServer)]);
	await Promise.all([cleanupSocket(publicPath), cleanupSocket(controlPath)]);
	process.exit(0);
}

function writeRoutedLine(socket: Socket, message: unknown): void {
	if (!socket.destroyed) socket.write(encodeControlLine(message));
}

function attachRoutedLineReader(socket: Socket, onMessage: (message: ControlMessage) => void): void {
	let buffered = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffered += chunk;
		if (Buffer.byteLength(buffered) > MAX_CONTROL_LINE_BYTES) {
			socket.destroy(new Error("Coordinator message is too large"));
			return;
		}
		while (true) {
			const newline = buffered.indexOf("\n");
			if (newline === -1) return;
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			try {
				const message = JSON.parse(line) as ControlMessage | null;
				if (typeof message?.type !== "string") throw new Error("Coordinator message must have a type");
				onMessage(message);
			} catch (error) {
				socket.destroy(error instanceof Error ? error : new Error(String(error)));
				return;
			}
		}
	});
}

function listen(server: Server, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
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
		server.listen(path);
	});
}

function closeServer(server: Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise((resolve) => server.close(() => resolve()));
}

async function restrictSocket(path: string): Promise<void> {
	if (process.platform !== "win32") await chmod(path, 0o600);
}

async function removeStaleSocket(path: string): Promise<void> {
	try {
		const stats = await lstat(path);
		if (!stats.isSocket()) throw new Error(`Coordinator path is not a socket: ${path}`);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	const live = await new Promise<boolean>((resolve, reject) => {
		const socket = createConnection(path);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			socket.destroy();
			if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
			else reject(error);
		});
	});
	if (live) throw new Error(`Coordinator socket is already active: ${path}`);
	await cleanupSocket(path);
}

async function cleanupSocket(path: string): Promise<void> {
	if (process.platform === "win32") return;
	await unlink(path).catch((error: unknown) => {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	});
}

if (isDirectInternalProcessEntry(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "coordinator") throw new Error("Coordinator entrypoint requires an internal coordinator invocation");
	void runCoordinatorProcess(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}
