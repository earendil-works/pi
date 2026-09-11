import {
	createServiceStateEncoder,
	decodeServiceControlCall,
	type JsonValue,
	parseServiceCall,
	parseServiceSubscriptionSnapshot,
	RemoteServiceError,
	type ServiceCall,
	type ServiceProviderUpdate,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type SessionMetadata, TODO_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core";
import {
	type CancelEnvelope,
	type ClientHello,
	type ClientMessage,
	ClientMessageDecoder,
	DEFAULT_MAX_FRAME_LENGTH,
	encodeServerMessage,
	isServerId,
	isSupportedProtocolVersion,
	PROTOCOL_VERSION,
	type ProtocolError,
	ProtocolValidationError,
	type RequestEnvelope,
	type ResponseEnvelope,
	type RpcTarget,
	type ServerHello,
	type ServerHelloError,
	type ServerMessage,
} from "@earendil-works/pi-protocol";
import {
	type ByteConnection,
	type ByteConnectionHandler,
	type ConnectionState,
	isTerminalConnection,
} from "./connection.ts";
import { INTERNAL_SERVER_ERROR_MESSAGE, ServerError, WrongServerError } from "./errors.ts";
import type { ServerListener } from "./listener.ts";
import { SessionRouter } from "./session-router.ts";
import type { ServerHost, ServerOptions } from "./types.ts";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_UINT32 = 0xffff_ffff;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class Server<TMetadata extends SessionMetadata = SessionMetadata> {
	readonly serverId: string;
	/** Resolves after shutdown, or rejects when listener or routed-Session cleanup fails. */
	readonly closed: Promise<void>;

	private readonly host: ServerHost<TMetadata>;
	private readonly listeners: readonly ServerListener[];
	private readonly maxFrameLength: number;
	private readonly handshakeTimeoutMs: number;
	private readonly onConnectionCountChanged: ((count: number) => void) | undefined;
	private readonly onError: ((error: Error) => void) | undefined;
	private readonly connections = new Set<ConnectionState>();
	private readonly sessions: SessionRouter<TMetadata>;
	private closing = false;
	private closePromise?: Promise<void>;
	private closedSettled = false;
	private rejectClosed!: (error: unknown) => void;
	private resolveClosed!: () => void;
	private startPromise?: Promise<this>;
	private started = false;

	constructor(host: ServerHost<TMetadata>, options: ServerOptions) {
		const resolved = resolveOptions(options);
		this.host = host;
		this.listeners = options.listeners;
		this.serverId = options.serverId;
		this.maxFrameLength = resolved.maxFrameLength;
		this.handshakeTimeoutMs = resolved.handshakeTimeoutMs;
		this.onConnectionCountChanged = options.onConnectionCountChanged;
		this.onError = options.onError;
		this.sessions = new SessionRouter({
			host,
			serverId: this.serverId,
			isClosing: () => this.closing,
			publishAttachment: async (client, attachment) => {
				await this.sendMessage(client as ConnectionState, {
					type: "attachment",
					attachment: attachment ?? null,
				});
			},
			reportError: (error) => this.reportError(error),
		});
		this.closed = new Promise((resolve, reject) => {
			this.resolveClosed = resolve;
			this.rejectClosed = reject;
		});
		void this.closed.catch(() => {});
	}

	start(): Promise<this> {
		if (this.started) return Promise.reject(new Error("Server is already started"));
		if (this.startPromise) return Promise.reject(new Error("Server is already starting"));
		if (this.closing) return Promise.reject(new Error("Server is closing or closed"));
		this.startPromise = this.startInternal();
		return this.startPromise;
	}

	private async startInternal(): Promise<this> {
		const started: ServerListener[] = [];
		try {
			for (const listener of this.listeners) {
				await listener.start((connection) => this.accept(connection));
				started.push(listener);
			}
			this.started = true;
			return this;
		} catch (error) {
			this.closing = true;
			const cleanupErrors: unknown[] = [];
			const listenerResults = await Promise.allSettled(started.map((listener) => listener.close()));
			for (const result of listenerResults) {
				if (result.status === "rejected") cleanupErrors.push(result.reason);
			}
			try {
				await this.closeServerState();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			if (cleanupErrors.length > 0) {
				const failure = new AggregateError([error, ...cleanupErrors], "Server startup and cleanup failed");
				this.settleClosed(failure);
				throw failure;
			}
			this.settleClosed();
			throw error;
		} finally {
			this.startPromise = undefined;
		}
	}

	accept(connection: ByteConnection): ByteConnectionHandler {
		if (this.closing) {
			void this.closeConnection(connection);
			return {
				onData: () => {},
				onClose: () => {},
				onError: (error) => this.reportError(error),
			};
		}

		let state: ConnectionState;
		const handshakeTimeout = setTimeout(() => {
			void this.failProtocol(state, {
				code: "invalid_request",
				message: "Handshake timeout",
			});
		}, this.handshakeTimeoutMs);
		handshakeTimeout.unref();
		state = {
			connection,
			decoder: new ClientMessageDecoder({ maxFrameLength: this.maxFrameLength }),
			serviceStateEncoders: new Map(),
			stage: "awaitingHello",
			disconnected: false,
			handshakeTimeout,
			activeRequests: new Map(),
		};
		this.connections.add(state);
		this.notifyConnectionCountChanged();

		return {
			onData: (chunk) => this.receive(state, chunk),
			onClose: () => this.transportClosed(state),
			onError: (error) => {
				this.reportError(error);
				void this.closeConnection(connection).then(() => this.disconnect(state));
			},
		};
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	private async closeInternal(): Promise<void> {
		const starting = this.startPromise;
		if (starting) await starting.catch(() => {});
		const errors: unknown[] = [];
		const listenerResults = await Promise.allSettled(this.listeners.map((listener) => listener.close()));
		for (const result of listenerResults) {
			if (result.status === "rejected") errors.push(result.reason);
		}
		try {
			await this.closeServerState();
		} catch (error) {
			errors.push(error);
		}
		this.started = false;
		if (errors.length > 0) {
			const failure =
				errors.length === 1 && errors[0] instanceof Error
					? errors[0]
					: new AggregateError(errors, "Server shutdown failed");
			this.settleClosed(failure);
			throw failure;
		}
		this.settleClosed();
	}

	private receive(state: ConnectionState, chunk: Uint8Array): void {
		if (isTerminalConnection(state)) return;
		let messages: ClientMessage[];
		try {
			messages = state.decoder.push(chunk);
		} catch (error) {
			void this.failProtocol(state, this.toProtocolError(error));
			return;
		}
		for (const message of messages) {
			if (isTerminalConnection(state)) return;
			this.dispatchMessage(state, message);
		}
	}

	private dispatchMessage(state: ConnectionState, message: ClientMessage): void {
		if (state.stage === "awaitingHello") {
			if (message.type !== "hello") {
				void this.failProtocol(state, {
					code: "invalid_request",
					message: "The first client message must be hello",
				});
				return;
			}
			state.stage = "handshaking";
			state.handshake = this.finishHandshake(state, message).catch((error: unknown) =>
				this.failProtocol(state, this.toProtocolError(error)),
			);
			return;
		}

		if (message.type === "hello") {
			void this.failProtocol(state, {
				code: "invalid_request",
				message: "hello may only be sent as the first message",
			});
			return;
		}

		if (state.stage === "ready") {
			if (message.type === "cancel") this.handleCancel(state, message);
			else void this.handleRequest(state, message);
			return;
		}
		if (state.stage !== "handshaking") return;
		const handshake = state.handshake;
		if (!handshake) return;
		void handshake.then(() => {
			if (state.stage !== "ready" || state.disconnected) return;
			if (message.type === "cancel") this.handleCancel(state, message);
			else void this.handleRequest(state, message);
		});
	}

	private async finishHandshake(state: ConnectionState, hello: ClientHello): Promise<void> {
		if (!isSupportedProtocolVersion(hello.version)) {
			await this.failProtocol(state, {
				code: "version",
				message: `Unsupported protocol version ${hello.version}; expected ${PROTOCOL_VERSION}`,
			});
			return;
		}

		if (this.closing || state.disconnected || state.stage !== "handshaking" || state.connection.closed) return;
		const services = await this.host.serverServices.attachClient(
			{
				attachSession: async (sessionId, context) => {
					await this.sessions.attachClient(state, sessionId, context);
				},
				detachSession: (context) => this.sessions.detachClient(state, context),
				prepareSessionRemoval: (sessionId, context) => this.sessions.removeSession(sessionId, context),
			},
			TODO_CONTEXT,
		);
		if (this.closing || state.disconnected || state.stage !== "handshaking" || state.connection.closed) {
			await services.release(TODO_CONTEXT);
			return;
		}
		state.serverServices = services;
		const sent = await this.sendMessage(state, {
			type: "hello",
			version: PROTOCOL_VERSION,
			serverId: this.serverId,
		} satisfies ServerHello);
		if (sent && !state.disconnected && state.stage === "handshaking") {
			state.stage = "ready";
			clearTimeout(state.handshakeTimeout);
		}
	}

	private handleCancel(state: ConnectionState, envelope: CancelEnvelope): void {
		if (envelope.target.serverId !== this.serverId) return;
		const active = state.activeRequests.get(envelope.id);
		if (active !== undefined && sameTarget(active.target, envelope.target)) {
			active.controller.abort(new DOMException("RPC request cancelled", "AbortError"));
		}
	}

	private async handleRequest(state: ConnectionState, envelope: RequestEnvelope): Promise<void> {
		if (state.activeRequests.has(envelope.id)) {
			await this.sendMessage(state, {
				type: "response",
				id: envelope.id,
				ok: false,
				error: { code: "invalid_request", message: "Request ID is already active" },
			} satisfies ResponseEnvelope);
			return;
		}
		let call: ServiceCall;
		try {
			call = parseServiceCall(envelope.call);
		} catch {
			await this.sendMessage(state, {
				type: "response",
				id: envelope.id,
				ok: false,
				error: { code: "invalid_request", message: "Invalid service call" },
			} satisfies ResponseEnvelope);
			return;
		}
		const controller = new AbortController();
		const active = { controller, target: envelope.target };
		state.activeRequests.set(envelope.id, active);
		const context = withAbortSignal(controller.signal, TODO_CONTEXT);
		const control = decodeServiceControlCall(call);
		const subscribing = control?.type === "subscribe" ? control : undefined;
		const pendingUpdates: { readonly update: ServiceProviderUpdate }[] = [];
		let subscriptionReady = subscribing === undefined;
		let installedSubscriptionEncoder = false;
		let responded = false;
		const publish = async (subscriptionId: string, update: ServiceProviderUpdate): Promise<void> => {
			if (subscribing !== undefined && subscriptionId === subscribing.subscriptionId && !subscriptionReady) {
				pendingUpdates.push({ update });
				return;
			}
			await this.sendServiceUpdate(state, subscriptionId, update);
		};
		try {
			if (envelope.target.serverId !== this.serverId) throw new WrongServerError();
			if (subscribing !== undefined && state.serviceStateEncoders.has(subscribing.subscriptionId)) {
				throw new ProtocolValidationError(`Duplicate service subscription ${subscribing.subscriptionId}`);
			}
			let result: JsonValue | undefined;
			if ("sessionId" in envelope.target) {
				result = await this.sessions.executeServiceCall(call, envelope.target, state, publish, context);
			} else if (state.serverServices !== undefined) {
				result = await state.serverServices.invokeService(call, publish, context);
			} else {
				throw new ProtocolValidationError(`Unknown service member ${call.serviceId}.${call.member}`);
			}
			if (subscribing !== undefined) {
				if (result === undefined)
					throw new ProtocolValidationError("Service subscription did not return a snapshot");
				const stateEncoder = createServiceStateEncoder();
				result = stateEncoder.encodeSnapshot(parseServiceSubscriptionSnapshot(result)) as unknown as JsonValue;
				state.serviceStateEncoders.set(subscribing.subscriptionId, stateEncoder);
				installedSubscriptionEncoder = true;
			} else if (control?.type === "unsubscribe") {
				state.serviceStateEncoders.delete(control.subscriptionId);
			}
			await this.sendMessage(
				state,
				result === undefined
					? { type: "response", id: envelope.id, ok: true }
					: { type: "response", id: envelope.id, ok: true, result },
			);
			responded = true;
			if (subscribing !== undefined) {
				while (pendingUpdates.length > 0) {
					const pending = pendingUpdates.shift();
					if (pending !== undefined)
						await this.sendServiceUpdate(state, subscribing.subscriptionId, pending.update);
				}
				subscriptionReady = true;
			}
		} catch (error) {
			if (subscribing !== undefined && installedSubscriptionEncoder && !responded) {
				state.serviceStateEncoders.delete(subscribing.subscriptionId);
			}
			if (responded) {
				this.reportError(error);
				await this.closeConnection(state.connection);
				this.disconnect(state);
			} else {
				await this.sendMessage(state, {
					type: "response",
					id: envelope.id,
					ok: false,
					error: controller.signal.aborted
						? { code: "cancelled", message: "RPC request cancelled" }
						: this.toProtocolError(error),
				} satisfies ResponseEnvelope);
			}
		} finally {
			if (state.activeRequests.get(envelope.id) === active) state.activeRequests.delete(envelope.id);
		}
	}

	private transportClosed(connection: ConnectionState): void {
		if (!connection.disconnected && connection.stage !== "closing") {
			try {
				connection.decoder.end();
			} catch (error) {
				this.reportError(error);
			}
		}
		this.disconnect(connection);
	}

	private disconnect(connection: ConnectionState): void {
		if (connection.disconnected) return;
		connection.disconnected = true;
		connection.stage = "closed";
		clearTimeout(connection.handshakeTimeout);
		for (const { controller } of connection.activeRequests.values()) {
			controller.abort(new Error("Client disconnected"));
		}
		connection.activeRequests.clear();
		connection.serviceStateEncoders.clear();
		if (this.connections.delete(connection)) this.notifyConnectionCountChanged();
		const serverServices = connection.serverServices;
		delete connection.serverServices;
		void Promise.allSettled([
			this.sessions.disconnect(connection, TODO_CONTEXT),
			serverServices?.release(TODO_CONTEXT),
		]).then((results) => {
			for (const result of results) if (result.status === "rejected") this.reportError(result.reason);
		});
	}

	private async sendServiceUpdate(
		connection: ConnectionState,
		subscriptionId: string,
		update: ServiceProviderUpdate,
	): Promise<void> {
		const stateEncoder = connection.serviceStateEncoders.get(subscriptionId);
		if (stateEncoder === undefined) return;
		await this.sendMessage(connection, {
			type: "service_update",
			subscriptionId,
			update: stateEncoder.encodeUpdate(update) as unknown as JsonValue,
		});
	}

	private async sendMessage(connection: ConnectionState, message: ServerMessage): Promise<boolean> {
		if (connection.disconnected || connection.connection.closed) return false;
		let frame: Uint8Array;
		try {
			frame = encodeServerMessage(message, { maxFrameLength: this.maxFrameLength });
		} catch (error) {
			this.reportError(error);
			await this.closeConnection(connection.connection);
			this.disconnect(connection);
			return false;
		}
		try {
			await connection.connection.send(frame);
			return true;
		} catch (error) {
			this.reportError(error);
			await this.closeConnection(connection.connection);
			this.disconnect(connection);
			return false;
		}
	}

	private async failProtocol(connection: ConnectionState, error: ProtocolError): Promise<void> {
		if (connection.disconnected || connection.stage === "closing" || connection.stage === "closed") return;
		connection.stage = "closing";
		clearTimeout(connection.handshakeTimeout);
		const message: ServerHelloError = { type: "hello_error", error };
		let finalFrame: Uint8Array | undefined;
		try {
			finalFrame = encodeServerMessage(message, { maxFrameLength: this.maxFrameLength });
		} catch (encodeError) {
			this.reportError(encodeError);
		}
		await this.closeConnection(connection.connection, finalFrame);
		this.disconnect(connection);
	}

	private async closeServerState(): Promise<void> {
		const connections = [...this.connections];
		for (const connection of connections) {
			connection.stage = "closing";
			clearTimeout(connection.handshakeTimeout);
		}
		await Promise.all(connections.map((connection) => this.closeConnection(connection.connection)));
		for (const connection of connections) this.disconnect(connection);
		const cleanup = await Promise.allSettled([this.sessions.close(BACKGROUND_CONTEXT)]);
		this.connections.clear();
		const errors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to close server Sessions");
	}

	private async closeConnection(connection: ByteConnection, finalChunk?: Uint8Array): Promise<void> {
		try {
			await connection.close(finalChunk);
		} catch (error) {
			this.reportError(error);
		}
	}

	private toProtocolError(error: unknown): ProtocolError {
		if (error instanceof ServerError || error instanceof RemoteServiceError) {
			return { code: error.code, message: error.message };
		}
		if (error instanceof ProtocolValidationError) {
			return { code: "invalid_request", message: error.message };
		}
		this.reportError(error);
		return { code: "internal_error", message: INTERNAL_SERVER_ERROR_MESSAGE };
	}

	private notifyConnectionCountChanged(): void {
		try {
			this.onConnectionCountChanged?.(this.connections.size);
		} catch (error) {
			this.reportError(error);
		}
	}

	private reportError(error: unknown): void {
		try {
			this.onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// Error observers cannot affect server state.
		}
	}

	private settleClosed(error?: unknown): void {
		if (this.closedSettled) return;
		this.closedSettled = true;
		if (error === undefined) this.resolveClosed();
		else this.rejectClosed(error);
	}
}

function sameTarget(left: RpcTarget, right: RpcTarget): boolean {
	if (left.serverId !== right.serverId) return false;
	if (!("sessionId" in left) || !("sessionId" in right)) {
		return !("sessionId" in left) && !("sessionId" in right);
	}
	return left.sessionId === right.sessionId && left.attachmentId === right.attachmentId;
}

function resolveOptions(options: ServerOptions): {
	maxFrameLength: number;
	handshakeTimeoutMs: number;
} {
	if (!Array.isArray(options.listeners)) throw new TypeError("Server listeners must be an array");
	if (!isServerId(options.serverId)) {
		throw new TypeError("serverId must be a canonical lowercase UUIDv4");
	}
	const maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
	if (!Number.isSafeInteger(maxFrameLength) || maxFrameLength <= 0 || maxFrameLength > MAX_UINT32) {
		throw new TypeError(`Server maxFrameLength must be an integer between 1 and ${MAX_UINT32}`);
	}
	const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(handshakeTimeoutMs) ||
		handshakeTimeoutMs <= 0 ||
		handshakeTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new TypeError(`Server handshakeTimeoutMs must be an integer between 1 and ${MAX_TIMER_DELAY_MS}`);
	}
	return { maxFrameLength, handshakeTimeoutMs };
}
