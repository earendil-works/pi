// JSON-RPC over one MCP transport, independent of the MCP protocol version.
import {
	isJsonRpcId,
	isJsonRpcNotification,
	isJsonRpcRequest,
	isJsonRpcResponse,
	isObject,
	JSON_RPC_ERROR_CODES,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcRequest,
	type JsonRpcResponse,
	McpAbortError,
	McpConnectionClosedError,
	McpError,
	McpTimeoutError,
	normalizeOwnRequestId,
	toError,
} from "./protocol/jsonrpc.ts";
import type { ProgressNotification } from "./protocol/types.ts";
import type { McpTransport } from "./transports/transport.ts";

export type NotificationListener = (params: unknown) => void;
export type ErrorListener = (error: Error) => void;
export type RequestHandler = (params: unknown, context: { signal: AbortSignal }) => unknown | Promise<unknown>;

/** How one request is sent and when it gives up. */
export interface PeerRequestOptions {
	signal?: AbortSignal;
	/** Not finite or not positive: no timeout. */
	timeoutMs: number;
	onProgress?: (progress: ProgressNotification) => void;
	/** Whether the server is told with `notifications/cancelled` when the request is aborted or times out. */
	notifyCancel: boolean;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	timeoutMs: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	signal: AbortSignal | undefined;
	onAbort: () => void;
	/** Aborted when the request settles, so the transport does not dispatch (or retry) it afterwards. */
	sendController: AbortController;
	notifyCancel: boolean;
	onProgress: ((progress: ProgressNotification) => void) | undefined;
	progressToken: JsonRpcId | undefined;
}

/**
 * Sends requests and notifications over a transport and matches responses, progress, and cancellation
 * to them. Answers requests the server sends with registered handlers and passes notifications to
 * listeners. Handlers and listeners outlive transports: they can be registered before `attach()`.
 */
export class JsonRpcPeer {
	private transport: McpTransport | undefined;
	private nextRequestId = 1;
	private pending = new Map<JsonRpcId, PendingRequest>();
	private progressRequests = new Map<JsonRpcId, JsonRpcId>();
	private incoming = new Map<JsonRpcId, AbortController>();
	private requestHandlers = new Map<string, RequestHandler>();
	private notificationListeners = new Map<string, Set<NotificationListener>>();
	private errorListeners = new Set<ErrorListener>();

	/** Use `transport` for sending until `detach()`. Messages it delivers must be passed to `receive()`. */
	attach(transport: McpTransport): void {
		this.transport = transport;
	}

	/** Stop sending; requests in flight stay pending until `failAll()`. */
	detach(): void {
		this.transport = undefined;
	}

	/** Send a request and resolve to its result; rejects with `McpError` for an error response. */
	async request(
		method: string,
		params: Record<string, unknown> | undefined,
		options: PeerRequestOptions,
	): Promise<unknown> {
		const transport = this.transport;
		if (!transport) throw new McpConnectionClosedError();
		if (options.signal?.aborted) throw new McpAbortError();
		const id = this.nextRequestId++;
		const progressToken = options.onProgress ? id : undefined;
		const requestParams =
			progressToken === undefined
				? params
				: { ...params, _meta: { ...(isObject(params?._meta) ? params._meta : {}), progressToken } };
		const message: JsonRpcRequest = {
			jsonrpc: "2.0",
			id,
			method,
			...(requestParams === undefined ? {} : { params: requestParams }),
		};
		return new Promise<unknown>((resolve, reject) => {
			const entry: PendingRequest = {
				resolve,
				reject,
				timeoutMs: options.timeoutMs,
				timer: undefined,
				signal: options.signal,
				onAbort: () =>
					this.cancelPending(
						id,
						new McpAbortError(),
						options.notifyCancel,
						String(options.signal?.reason ?? "Aborted"),
					),
				sendController: new AbortController(),
				notifyCancel: options.notifyCancel,
				onProgress: options.onProgress,
				progressToken,
			};
			this.pending.set(id, entry);
			if (progressToken !== undefined) this.progressRequests.set(progressToken, id);
			options.signal?.addEventListener("abort", entry.onAbort, { once: true });
			this.armTimeout(id, entry);
			transport
				.send(message, { signal: entry.sendController.signal })
				.catch((error) => this.cancelPending(id, error, false));
		});
	}

	async notify(method: string, params: Record<string, unknown> | undefined): Promise<void> {
		const transport = this.transport;
		if (!transport) throw new McpConnectionClosedError();
		await transport.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
	}

	setRequestHandler(method: string, handler: RequestHandler): () => void {
		this.requestHandlers.set(method, handler);
		return () => {
			if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
		};
	}

	onNotification(method: string, listener: NotificationListener): () => void {
		const listeners = this.notificationListeners.get(method) ?? new Set<NotificationListener>();
		this.notificationListeners.set(method, listeners);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.notificationListeners.delete(method);
		};
	}

	onError(listener: ErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	/** Handle one message from the transport. */
	receive(message: JsonRpcMessage): void {
		if (isJsonRpcResponse(message)) {
			this.handleResponse(message);
			return;
		}
		if (isJsonRpcRequest(message)) {
			void this.handleRequest(message);
			return;
		}
		if (isJsonRpcNotification(message)) {
			this.handleNotification(message.method, message.params);
			return;
		}
		this.emitError(new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Received invalid JSON-RPC message"));
	}

	/** Reject every pending request and abort the server requests being served. */
	failAll(error: Error): void {
		for (const [id, entry] of this.pending) {
			this.removePending(id, entry);
			entry.reject(error);
		}
		for (const controller of this.incoming.values()) controller.abort(error);
		this.incoming.clear();
	}

	emitError(error: unknown): void {
		const normalized = toError(error);
		for (const listener of this.errorListeners) listener(normalized);
	}

	private handleResponse(message: JsonRpcResponse): void {
		const id = normalizeOwnRequestId(message.id);
		const entry = this.pending.get(id);
		if (!entry) {
			this.emitError(new Error(`Received response for unknown MCP request ${String(message.id)}`));
			return;
		}
		this.removePending(id, entry);
		if ("error" in message) entry.reject(new McpError(message.error.code, message.error.message, message.error.data));
		else entry.resolve(message.result);
	}

	private async handleRequest(message: JsonRpcRequest): Promise<void> {
		const transport = this.transport;
		if (!transport) return;
		const handler = this.requestHandlers.get(message.method);
		if (!handler) {
			await transport
				.send({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: `Method not found: ${message.method}` },
				})
				.catch((error) => this.emitError(error));
			return;
		}
		const controller = new AbortController();
		this.incoming.set(message.id, controller);
		try {
			const result = await handler(message.params, { signal: controller.signal });
			await transport.send({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
		} catch (error) {
			const responseError =
				error instanceof McpError
					? { code: error.code, message: error.message, data: error.data }
					: { code: JSON_RPC_ERROR_CODES.internalError, message: toError(error).message };
			await transport
				.send({ jsonrpc: "2.0", id: message.id, error: responseError })
				.catch((sendError) => this.emitError(sendError));
		} finally {
			this.incoming.delete(message.id);
		}
	}

	private handleNotification(method: string, params: unknown): void {
		if (method === "notifications/progress") this.handleProgress(params);
		else if (method === "notifications/cancelled") this.handleCancelled(params);
		for (const listener of this.notificationListeners.get(method) ?? []) {
			try {
				listener(params);
			} catch (error) {
				this.emitError(error);
			}
		}
	}

	private handleProgress(params: unknown): void {
		if (!isObject(params) || !isJsonRpcId(params.progressToken) || typeof params.progress !== "number") return;
		const requestId = this.progressRequests.get(normalizeOwnRequestId(params.progressToken));
		const entry = requestId === undefined ? undefined : this.pending.get(requestId);
		if (requestId === undefined || !entry) return;
		this.armTimeout(requestId, entry);
		try {
			entry.onProgress?.(params as unknown as ProgressNotification);
		} catch (error) {
			this.emitError(error);
		}
	}

	private handleCancelled(params: unknown): void {
		if (isObject(params) && isJsonRpcId(params.requestId)) this.incoming.get(params.requestId)?.abort(params.reason);
	}

	private armTimeout(id: JsonRpcId, entry: PendingRequest): void {
		if (entry.timer) clearTimeout(entry.timer);
		if (!Number.isFinite(entry.timeoutMs) || entry.timeoutMs <= 0) return;
		entry.timer = setTimeout(() => {
			this.cancelPending(id, new McpTimeoutError(entry.timeoutMs), entry.notifyCancel, "Request timed out");
		}, entry.timeoutMs);
	}

	private cancelPending(id: JsonRpcId, error: unknown, notifyServer: boolean, reason?: string): void {
		const entry = this.pending.get(id);
		if (!entry) return;
		this.removePending(id, entry);
		entry.reject(error);
		if (notifyServer && this.transport) {
			void this.transport
				.send({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId: id, ...(reason ? { reason } : {}) },
				})
				.catch((sendError) => this.emitError(sendError));
		}
	}

	private removePending(id: JsonRpcId, entry: PendingRequest): void {
		this.pending.delete(id);
		if (entry.timer) clearTimeout(entry.timer);
		if (entry.progressToken !== undefined) this.progressRequests.delete(entry.progressToken);
		entry.signal?.removeEventListener("abort", entry.onAbort);
		entry.sendController.abort();
	}
}
