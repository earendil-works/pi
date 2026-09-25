import type { CallToolResult } from "./protocol/content.ts";
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
	toError,
} from "./protocol/jsonrpc.ts";
import {
	type ClientCapabilities,
	type Implementation,
	type InitializeResult,
	LATEST_PROTOCOL_VERSION,
	type ListToolsResult,
	type ProgressNotification,
	type Root,
	type ServerCapabilities,
	SUPPORTED_PROTOCOL_VERSIONS,
	type SupportedProtocolVersion,
	type Tool,
} from "./protocol/types.ts";
import type { McpTransport } from "./transports/transport.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_LIST_PAGES = 1_000;

type ClientState = "idle" | "connecting" | "connected" | "closed";
type NotificationListener = (params: unknown) => void;
type ErrorListener = (error: Error) => void;
type RequestHandler = (params: unknown, context: { signal: AbortSignal }) => unknown | Promise<unknown>;

export interface McpClientOptions extends Implementation {
	capabilities?: ClientCapabilities;
	protocolVersion?: SupportedProtocolVersion;
	requestTimeoutMs?: number;
	roots?: readonly Root[] | (() => readonly Root[] | Promise<readonly Root[]>);
}

export interface McpRequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	onProgress?: (progress: ProgressNotification) => void;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	timeoutMs: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	signal: AbortSignal | undefined;
	onAbort: () => void;
	onProgress: ((progress: ProgressNotification) => void) | undefined;
	progressToken: JsonRpcId | undefined;
}

function validateInitializeResult(value: unknown): InitializeResult {
	if (
		!isObject(value) ||
		typeof value.protocolVersion !== "string" ||
		!isObject(value.capabilities) ||
		!isObject(value.serverInfo) ||
		typeof value.serverInfo.name !== "string" ||
		typeof value.serverInfo.version !== "string" ||
		(value.instructions !== undefined && typeof value.instructions !== "string")
	) {
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP initialize result");
	}
	return value as unknown as InitializeResult;
}

function validateListToolsResult(value: unknown): ListToolsResult {
	if (!isObject(value) || !Array.isArray(value.tools)) {
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP tools/list result");
	}
	for (const tool of value.tools) {
		if (!isObject(tool) || typeof tool.name !== "string" || !isObject(tool.inputSchema)) {
			throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP tool definition");
		}
	}
	if (value.nextCursor !== undefined && typeof value.nextCursor !== "string") {
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP tools/list cursor");
	}
	return value as unknown as ListToolsResult;
}

function validateCallToolResult(value: unknown): CallToolResult {
	if (!isObject(value) || !Array.isArray(value.content)) {
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP tools/call result");
	}
	return value as unknown as CallToolResult;
}

export class McpClient {
	readonly options: Readonly<McpClientOptions>;
	private state: ClientState = "idle";
	private transport: McpTransport | undefined;
	private nextRequestId = 1;
	private serverInfoValue: Implementation | undefined;
	private serverCapabilitiesValue: ServerCapabilities | undefined;
	private instructionsValue: string | undefined;
	private protocolVersionValue: string | undefined;
	private pending = new Map<JsonRpcId, PendingRequest>();
	private progressRequests = new Map<JsonRpcId, JsonRpcId>();
	private incoming = new Map<JsonRpcId, AbortController>();
	private requestHandlers = new Map<string, RequestHandler>();
	private notificationListeners = new Map<string, Set<NotificationListener>>();
	private errorListeners = new Set<ErrorListener>();
	private disposers: (() => void)[] = [];

	constructor(options: McpClientOptions) {
		this.options = Object.freeze({ ...options });
		this.requestHandlers.set("ping", () => ({}));
		const roots = options.roots;
		if (roots) {
			this.requestHandlers.set("roots/list", async () => ({
				roots: [...(typeof roots === "function" ? await roots() : roots)],
			}));
		}
	}

	get connectionState(): ClientState {
		return this.state;
	}

	get serverInfo(): Implementation | undefined {
		return this.serverInfoValue;
	}

	get serverCapabilities(): ServerCapabilities | undefined {
		return this.serverCapabilitiesValue;
	}

	get instructions(): string | undefined {
		return this.instructionsValue;
	}

	get protocolVersion(): string | undefined {
		return this.protocolVersionValue;
	}

	async connect(transport: McpTransport): Promise<InitializeResult> {
		if (this.state !== "idle") throw new Error(`Cannot connect MCP client in ${this.state} state`);
		this.state = "connecting";
		this.transport = transport;
		this.disposers = [
			transport.onMessage((message) => this.handleMessage(message)),
			transport.onError((error) => this.handleTransportError(error)),
			transport.onClose(() => this.handleTransportClose()),
		];

		try {
			await transport.start();
			const capabilities: ClientCapabilities = { ...this.options.capabilities };
			if (this.options.roots && capabilities.roots === undefined) capabilities.roots = {};
			const result = validateInitializeResult(
				await this.requestInternal(
					"initialize",
					{
						protocolVersion: this.options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
						capabilities,
						clientInfo: {
							name: this.options.name,
							version: this.options.version,
							...(this.options.title === undefined ? {} : { title: this.options.title }),
						},
					},
					{},
					true,
				),
			);
			if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(result.protocolVersion)) {
				throw new Error(`MCP server selected unsupported protocol version ${result.protocolVersion}`);
			}
			this.protocolVersionValue = result.protocolVersion;
			this.serverInfoValue = result.serverInfo;
			this.serverCapabilitiesValue = result.capabilities;
			this.instructionsValue = result.instructions;
			transport.setProtocolVersion?.(result.protocolVersion);
			await this.notifyInternal("notifications/initialized", undefined, true);
			this.state = "connected";
			return result;
		} catch (error) {
			await this.close().catch(() => {});
			throw error;
		}
	}

	request<Result = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options: McpRequestOptions = {},
	): Promise<Result> {
		return this.requestInternal(method, params, options, false) as Promise<Result>;
	}

	notify(method: string, params?: Record<string, unknown>): Promise<void> {
		return this.notifyInternal(method, params, false);
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

	async ping(options: McpRequestOptions = {}): Promise<void> {
		await this.request("ping", undefined, options);
	}

	async listTools(options: McpRequestOptions = {}): Promise<Tool[]> {
		const tools: Tool[] = [];
		const cursors = new Set<string>();
		let cursor: string | undefined;
		for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber++) {
			const page = validateListToolsResult(
				await this.request("tools/list", cursor === undefined ? undefined : { cursor }, options),
			);
			tools.push(...page.tools);
			if (page.nextCursor === undefined) return tools;
			if (cursors.has(page.nextCursor))
				throw new Error(`MCP tools/list returned duplicate cursor: ${page.nextCursor}`);
			cursors.add(page.nextCursor);
			cursor = page.nextCursor;
		}
		throw new Error(`MCP tools/list exceeded ${MAX_LIST_PAGES} pages`);
	}

	async callTool(
		name: string,
		args?: Record<string, unknown>,
		options: McpRequestOptions = {},
	): Promise<CallToolResult> {
		return validateCallToolResult(
			await this.request("tools/call", { name, ...(args === undefined ? {} : { arguments: args }) }, options),
		);
	}

	async close(): Promise<void> {
		const transport = this.transport;
		this.transport = undefined;
		this.disposeTransportListeners();
		this.markClosed(new McpConnectionClosedError());
		await transport?.close();
	}

	private async requestInternal(
		method: string,
		params: Record<string, unknown> | undefined,
		options: McpRequestOptions,
		allowConnecting: boolean,
	): Promise<unknown> {
		const transport = this.requireTransport(allowConnecting);
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
				timeoutMs: options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
				timer: undefined,
				signal: options.signal,
				onAbort: () =>
					this.cancelPending(id, new McpAbortError(), true, String(options.signal?.reason ?? "Aborted")),
				onProgress: options.onProgress,
				progressToken,
			};
			this.pending.set(id, entry);
			if (progressToken !== undefined) this.progressRequests.set(progressToken, id);
			options.signal?.addEventListener("abort", entry.onAbort, { once: true });
			this.armTimeout(id, entry);
			transport.send(message).catch((error) => this.cancelPending(id, error, false));
		});
	}

	private async notifyInternal(
		method: string,
		params: Record<string, unknown> | undefined,
		allowConnecting: boolean,
	): Promise<void> {
		await this.requireTransport(allowConnecting).send({
			jsonrpc: "2.0",
			method,
			...(params === undefined ? {} : { params }),
		});
	}

	private requireTransport(allowConnecting: boolean): McpTransport {
		if (this.transport && (this.state === "connected" || (allowConnecting && this.state === "connecting"))) {
			return this.transport;
		}
		throw new McpConnectionClosedError(`MCP client is ${this.state}`);
	}

	private handleMessage(message: JsonRpcMessage): void {
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

	private handleResponse(message: JsonRpcResponse): void {
		const entry = this.pending.get(message.id);
		if (!entry) {
			this.emitError(new Error(`Received response for unknown MCP request ${String(message.id)}`));
			return;
		}
		this.removePending(message.id, entry);
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
		const requestId = this.progressRequests.get(params.progressToken);
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
			this.cancelPending(id, new McpTimeoutError(entry.timeoutMs), true, "Request timed out");
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
	}

	private rejectPending(error: unknown): void {
		for (const [id, entry] of this.pending) {
			this.removePending(id, entry);
			entry.reject(error);
		}
	}

	private handleTransportError(error: Error): void {
		this.rejectPending(error);
		this.emitError(error);
	}

	private handleTransportClose(): void {
		this.markClosed(new McpConnectionClosedError());
	}

	/** Idempotent: rejects in-flight requests, aborts server requests we are serving, and flips the state. */
	private markClosed(error: Error): void {
		this.state = "closed";
		this.rejectPending(error);
		for (const controller of this.incoming.values()) controller.abort(error);
		this.incoming.clear();
	}

	private emitError(error: unknown): void {
		const normalized = toError(error);
		for (const listener of this.errorListeners) listener(normalized);
	}

	private disposeTransportListeners(): void {
		for (const dispose of this.disposers.splice(0)) dispose();
	}
}
