import {
	createServiceCatalogueCall,
	createServiceStateDecoder,
	createServiceSubscribeCall,
	createServiceUnsubscribeCall,
	type JsonValue,
	parseServiceCall,
	parseServiceCatalogue,
	parseWireServiceProviderUpdate,
	parseWireServiceSubscriptionSnapshot,
	type RemoteServiceTransport,
	type ServiceCall,
	type ServiceCatalogueEntry,
	type ServiceMode,
	type ServiceProviderUpdate,
	type ServiceStateDecoder,
	type ServiceSubscriptionSnapshot,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AttachmentEnvelope,
	encodeClientMessage,
	isServerId,
	ProtocolValidationError,
	type ResponseEnvelope,
	type RpcTarget,
	type ServerHello,
	type ServiceEventEnvelope,
	type SessionTarget,
} from "@earendil-works/pi-protocol";
import { Connection } from "./connection.ts";
import { ClientDisposedError, DisconnectedError, ServerError, toError } from "./errors.ts";
import { createPromiseResolvers } from "./promise.ts";
import type {
	AttachmentChangeListener,
	ClientOptions,
	ConnectionState,
	ConnectionStateChange,
	ServiceSubscription,
	Unsubscribe,
} from "./types.ts";

type ServiceResult = JsonValue | undefined;

interface PendingRequest {
	resolve(result: ServiceResult): void;
	reject(error: Error): void;
	cleanup(): void;
}

interface ActiveServiceListener {
	readonly target: RpcTarget;
	readonly listener: (update: ServiceProviderUpdate) => void | Promise<void>;
	readonly decoder: ServiceStateDecoder;
	readonly queuedWireUpdates: JsonValue[];
	readonly queued: ServiceProviderUpdate[];
	deliveryTail: Promise<void>;
	hydrated: boolean;
	ready: boolean;
}

export class Client {
	readonly #options: ClientOptions;
	readonly #connection: Connection;
	readonly #pendingRequests = new Map<string, PendingRequest>();
	readonly #connectionStateListeners = new Set<(change: ConnectionStateChange) => void>();
	readonly #attachmentListeners = new Set<AttachmentChangeListener>();
	readonly #serviceListeners = new Map<string, ActiveServiceListener>();
	#requestSequence = 0;
	#serviceSubscriptionSequence = 0;
	#hello: ServerHello | undefined;
	#attachment: SessionTarget | undefined;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(options: ClientOptions) {
		if (!isServerId(options.serverId)) {
			throw new TypeError("serverId must be a canonical lowercase UUIDv4");
		}
		this.#options = options;
		this.#connection = new Connection({
			transportFactory: options.transportFactory,
			serverId: options.serverId,
			maxFrameLength: options.maxFrameLength,
			onHandshake: (hello) => {
				this.#hello = hello;
			},
			onMessage: (message) => this.#handleMessage(message),
			onStateChange: (change) => this.#handleConnectionStateChange(change),
		});
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	get connectionState(): ConnectionState {
		return this.#connection.state;
	}

	get connected(): boolean {
		return this.#connection.state === "connected";
	}

	get serverId(): string {
		return this.#options.serverId;
	}

	get hello(): ServerHello | undefined {
		return this.#hello;
	}

	get attachment(): SessionTarget | undefined {
		return this.#attachment;
	}

	static async connect(options: ClientOptions): Promise<Client> {
		const client = new Client(options);
		try {
			await client.connect();
			return client;
		} catch (error) {
			await client.dispose();
			throw error;
		}
	}

	connect(): Promise<ServerHello> {
		if (this.#disposed) return Promise.reject(new ClientDisposedError());
		this.#hello = undefined;
		return this.#connection.connect();
	}

	reconnect(): Promise<ServerHello> {
		return this.connect();
	}

	disconnect(reason = "Client disconnected"): void {
		this.#connection.disconnect(reason);
	}

	onConnectionStateChange(listener: (change: ConnectionStateChange) => void): Unsubscribe {
		this.#assertNotDisposed();
		this.#connectionStateListeners.add(listener);
		return () => this.#connectionStateListeners.delete(listener);
	}

	onAttachmentChange(listener: AttachmentChangeListener): Unsubscribe {
		this.#assertNotDisposed();
		this.#attachmentListeners.add(listener);
		return () => this.#attachmentListeners.delete(listener);
	}

	/** Invoke one low-level protocol call against an explicit routed target. */
	request(target: RpcTarget, call: ServiceCall, signal?: AbortSignal): Promise<ServiceResult> {
		return this.#request(target, call, signal);
	}

	async serviceCatalogue(target: RpcTarget, signal?: AbortSignal): Promise<readonly ServiceCatalogueEntry[]> {
		const result = await this.#request(target, createServiceCatalogueCall(), signal);
		try {
			return parseServiceCatalogue(result);
		} catch (error) {
			const validationError = new ProtocolValidationError(
				error instanceof Error ? error.message : "Invalid service catalogue",
			);
			this.#connection.fail(validationError);
			throw validationError;
		}
	}

	async subscribeService(
		target: RpcTarget,
		serviceId: string,
		mode: ServiceMode,
		listener: (update: ServiceProviderUpdate) => void | Promise<void>,
		signal?: AbortSignal,
	): Promise<ServiceSubscription> {
		const subscriptionId = `service-${++this.#serviceSubscriptionSequence}`;
		const active: ActiveServiceListener = {
			target,
			listener,
			decoder: createServiceStateDecoder(),
			queuedWireUpdates: [],
			queued: [],
			deliveryTail: Promise.resolve(),
			hydrated: false,
			ready: false,
		};
		this.#serviceListeners.set(subscriptionId, active);
		let snapshot: ServiceSubscriptionSnapshot;
		try {
			snapshot = await this.#request(
				target,
				createServiceSubscribeCall(subscriptionId, serviceId, mode),
				signal,
				(result) => {
					const decoded = active.decoder.decodeSnapshot(parseWireServiceSubscriptionSnapshot(result));
					active.hydrated = true;
					for (const update of active.queuedWireUpdates.splice(0)) {
						active.queued.push(active.decoder.decodeUpdate(parseWireServiceProviderUpdate(update)));
					}
					return decoded;
				},
			);
		} catch (error) {
			if (this.#serviceListeners.get(subscriptionId) === active) this.#serviceListeners.delete(subscriptionId);
			throw error;
		}
		if (this.#serviceListeners.get(subscriptionId) !== active) throw new DisconnectedError();
		let disposed = false;
		return {
			id: subscriptionId,
			target,
			snapshot,
			start: () => {
				if (disposed || active.ready) return;
				active.ready = true;
				for (const update of active.queued.splice(0)) this.#deliverServiceUpdate(active, update);
			},
			dispose: async () => {
				if (disposed) return;
				disposed = true;
				if (this.#serviceListeners.get(subscriptionId) === active) this.#serviceListeners.delete(subscriptionId);
				try {
					if (this.connected && this.#targetIsCurrent(target)) {
						await this.#request(target, createServiceUnsubscribeCall(subscriptionId));
					}
					await active.deliveryTail;
				} finally {
					active.queuedWireUpdates.length = 0;
					active.queued.length = 0;
				}
			},
		};
	}

	#request<T = ServiceResult>(
		target: RpcTarget,
		call: ServiceCall,
		signal?: AbortSignal,
		transform?: (result: ServiceResult) => T,
	): Promise<T> {
		if (this.#disposed) return Promise.reject(new ClientDisposedError());
		if (!this.connected) return Promise.reject(new DisconnectedError());
		if (signal?.aborted) return Promise.reject(abortError(signal));
		const id = `request-${++this.#requestSequence}`;
		const { promise, resolve, reject } = createPromiseResolvers<T>();
		let sent = false;
		let aborted = false;
		let onAbort: (() => void) | undefined;
		const sendCancel = (): void => {
			if (!sent || !this.connected) return;
			try {
				this.#connection.send(
					encodeClientMessage({ type: "cancel", id, target }, { maxFrameLength: this.#connection.maxFrameLength }),
				);
			} catch (error) {
				this.#connection.fail(toError(error));
			}
		};
		if (signal !== undefined) {
			onAbort = () => {
				if (aborted) return;
				aborted = true;
				reject(abortError(signal));
				sendCancel();
			};
			signal.addEventListener("abort", onAbort, { once: true });
		}
		this.#pendingRequests.set(id, {
			resolve: (result) => {
				try {
					resolve(transform === undefined ? (result as T) : transform(result));
				} catch (error) {
					const validationError = new ProtocolValidationError(
						error instanceof Error ? error.message : "Invalid service operation stream",
					);
					this.#connection.fail(validationError);
					reject(validationError);
				}
			},
			reject,
			cleanup: () => {
				if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
			},
		});
		let frame: Uint8Array;
		try {
			frame = encodeClientMessage(
				{ type: "request", id, target, call: parseServiceCall(call) as unknown as JsonValue },
				{ maxFrameLength: this.#connection.maxFrameLength },
			);
		} catch (error) {
			this.#takePendingRequest(id)?.reject(toError(error));
			return promise;
		}
		this.#connection.send(frame);
		sent = true;
		if (aborted) sendCancel();
		return promise;
	}

	#handleMessage(message: ResponseEnvelope | ServiceEventEnvelope | AttachmentEnvelope): void {
		if (message.type === "attachment") {
			if (message.attachment !== null && message.attachment.serverId !== this.#options.serverId) {
				this.#connection.fail(new ProtocolValidationError("Attachment update belongs to another server"));
				return;
			}
			this.#setAttachment(message.attachment ?? undefined);
			return;
		}
		if (message.type === "service_update") {
			const active = this.#serviceListeners.get(message.subscriptionId);
			if (active === undefined) return;
			if (!active.hydrated) {
				active.queuedWireUpdates.push(message.update);
				return;
			}
			let update: ServiceProviderUpdate;
			try {
				update = active.decoder.decodeUpdate(parseWireServiceProviderUpdate(message.update));
			} catch (error) {
				this.#connection.fail(
					new ProtocolValidationError(error instanceof Error ? error.message : "Invalid service operation stream"),
				);
				return;
			}
			if (active.ready) this.#deliverServiceUpdate(active, update);
			else active.queued.push(update);
			return;
		}
		const pending = this.#takePendingRequest(message.id);
		if (!pending) {
			this.#connection.fail(new ProtocolValidationError("Response has no matching request"));
			return;
		}
		if (!message.ok) {
			pending.reject(new ServerError(message.error));
			return;
		}
		pending.resolve(message.result);
	}

	#handleConnectionStateChange(change: ConnectionStateChange): void {
		if (change.state === "disconnected") {
			this.#hello = undefined;
			this.#setAttachment(undefined);
			this.#rejectPendingRequests(change.error ?? new DisconnectedError());
			this.#serviceListeners.clear();
		}
		for (const listener of this.#connectionStateListeners) {
			try {
				listener(change);
			} catch (error) {
				this.#reportListenerError(error);
			}
		}
	}

	#takePendingRequest(id: string): PendingRequest | undefined {
		const request = this.#pendingRequests.get(id);
		if (request) {
			this.#pendingRequests.delete(id);
			request.cleanup();
		}
		return request;
	}

	#rejectPendingRequests(error: Error): void {
		const requests = [...this.#pendingRequests.values()];
		this.#pendingRequests.clear();
		for (const request of requests) {
			request.cleanup();
			request.reject(error);
		}
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#disposePromise = Promise.resolve();
		const error = new ClientDisposedError();
		this.#rejectPendingRequests(error);
		this.#connection.disconnect(error);
		this.#hello = undefined;
		this.#setAttachment(undefined);
		this.#connectionStateListeners.clear();
		this.#attachmentListeners.clear();
		this.#serviceListeners.clear();
		return this.#disposePromise;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	#setAttachment(attachment: SessionTarget | undefined): void {
		const previous = this.#attachment;
		if (
			previous?.serverId === attachment?.serverId &&
			previous?.sessionId === attachment?.sessionId &&
			previous?.attachmentId === attachment?.attachmentId
		) {
			return;
		}
		this.#attachment = attachment;
		for (const listener of this.#attachmentListeners) {
			try {
				listener(attachment);
			} catch (error) {
				this.#reportListenerError(error);
			}
		}
	}

	#deliverServiceUpdate(active: ActiveServiceListener, update: ServiceProviderUpdate): void {
		active.deliveryTail = active.deliveryTail
			.then(() => active.listener(update))
			.catch((error: unknown) => this.#reportListenerError(error));
	}

	#targetIsCurrent(target: RpcTarget): boolean {
		if (!("sessionId" in target)) return this.#hello?.serverId === target.serverId;
		const attachment = this.#attachment;
		return (
			attachment?.serverId === target.serverId &&
			attachment.sessionId === target.sessionId &&
			attachment.attachmentId === target.attachmentId
		);
	}

	#assertNotDisposed(): void {
		if (this.#disposed) throw new ClientDisposedError();
	}

	#reportListenerError(error: unknown): void {
		if (!this.#options.onListenerError) return;
		try {
			this.#options.onListenerError(toError(error));
		} catch {
			// Diagnostics cannot affect protocol or transport state.
		}
	}
}

/** Adapts a lazily resolved routed client target to a Chord service transport. */
export function createClientServiceTransport(
	client: Client,
	getTarget: () => RpcTarget | undefined,
): RemoteServiceTransport {
	const target = (): RpcTarget => {
		const resolved = getTarget();
		if (resolved === undefined) throw new Error("Remote service target is unavailable");
		return resolved;
	};
	return {
		invoke: async (call, context) => client.request(target(), call, context.abortSignal),
		async subscribe(serviceId, mode, listener, context) {
			const subscription = await client.subscribeService(
				target(),
				serviceId,
				mode,
				(update) => listener(update, BACKGROUND_CONTEXT),
				context.abortSignal,
			);
			return {
				snapshot: subscription.snapshot,
				activate: () => subscription.start(),
				close: () => subscription.dispose(),
			};
		},
	};
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}
