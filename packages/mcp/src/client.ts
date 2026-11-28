import type { CallToolResult } from "./protocol/content.ts";
import { type ToolHeaderBinding, toolHeaderBindings, toolParamHeaders } from "./protocol/http-headers.ts";
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
import {
	HEADER_MISMATCH_ERROR_CODE,
	readStatelessResult,
	STATELESS_ERROR_CODES,
	type StatelessRequestMeta,
	validateDiscoverResult,
	withStatelessMeta,
} from "./protocol/stateless.ts";
import {
	type ClientCapabilities,
	type Implementation,
	type InitializeResult,
	type InputRequest,
	LATEST_PROTOCOL_VERSION,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	type LoggingLevel,
	type McpProtocolMode,
	type ProgressNotification,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplate,
	type Root,
	type ServerCapabilities,
	STATELESS_PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
	type SupportedProtocolVersion,
	type Tool,
} from "./protocol/types.ts";
import { jsonRpcErrorIn, McpHttpError } from "./transports/streamable-http.ts";
import type { McpTransport } from "./transports/transport.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_LIST_PAGES = 1_000;
/**
 * Bounds `server/discover` after a rejected `initialize`. The server already answered once, so a
 * stateless server answers quickly; a legacy server that ignores the request must not hold up the error.
 */
const DISCOVER_AFTER_INITIALIZE_TIMEOUT_MS = 10_000;
/**
 * Rounds of input a server may ask for before one request completes. Servers may ask again until they
 * have what they need; this bounds a server that never does.
 */
const MAX_INPUT_ROUNDS = 16;
/** Methods whose results may ask for input in MCP 2026-07-28 (multi round-trip requests). */
const INPUT_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

type ClientState = "idle" | "connecting" | "connected" | "closed";
type NotificationListener = (params: unknown) => void;
type ErrorListener = (error: Error) => void;
type CloseListener = () => void;
type RequestHandler = (params: unknown, context: { signal: AbortSignal }) => unknown | Promise<unknown>;

export interface McpClientOptions extends Implementation {
	capabilities?: ClientCapabilities;
	/** Version the `initialize` handshake asks for. Default: {@link LATEST_PROTOCOL_VERSION}. */
	protocolVersion?: SupportedProtocolVersion;
	/** How the protocol is picked (see {@link McpProtocolMode}). Default: `auto`. */
	protocol?: McpProtocolMode;
	/**
	 * Servers on the stateless revision send log messages (`notifications/message`) only for requests
	 * that name a level, so every such request names this one. Without it, they send none.
	 */
	logLevel?: LoggingLevel;
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
	/** Aborted when the request settles, so the transport does not dispatch (or retry) it afterwards. */
	sendController: AbortController;
	cancellable: boolean;
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

function invalid(message: string): McpError {
	return new McpError(JSON_RPC_ERROR_CODES.invalidRequest, message);
}

/** One page of a paginated list: the items under `key`, each checked by `isItem`. */
function validateListPage(
	method: string,
	key: string,
	value: unknown,
	isItem: (item: Record<string, unknown>) => boolean,
): { items: Record<string, unknown>[]; nextCursor?: string } {
	const items = isObject(value) ? value[key] : undefined;
	if (!isObject(value) || !Array.isArray(items)) throw invalid(`Invalid MCP ${method} result`);
	for (const item of items) {
		if (!isObject(item) || !isItem(item)) throw invalid(`Invalid entry in MCP ${method} result`);
	}
	// Some servers end pagination with `null` or `""` instead of omitting the cursor.
	const nextCursor = value.nextCursor === null || value.nextCursor === "" ? undefined : value.nextCursor;
	if (nextCursor !== undefined && typeof nextCursor !== "string") throw invalid(`Invalid MCP ${method} cursor`);
	return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

const isTool = (tool: Record<string, unknown>) => typeof tool.name === "string" && isObject(tool.inputSchema);
// `name` is required by the spec, but some servers omit it; the URI stands in.
const isResource = (resource: Record<string, unknown>) =>
	typeof resource.uri === "string" && (resource.name === undefined || typeof resource.name === "string");
const isResourceTemplate = (template: Record<string, unknown>) =>
	typeof template.uriTemplate === "string" && (template.name === undefined || typeof template.name === "string");

function toResource(item: Record<string, unknown>): Resource {
	return { ...item, name: item.name ?? item.uri } as Resource;
}

function toResourceTemplate(item: Record<string, unknown>): ResourceTemplate {
	return { ...item, name: item.name ?? item.uriTemplate } as ResourceTemplate;
}

function pageCursor(page: { nextCursor?: string }): { nextCursor?: string } {
	return page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor };
}

function validateReadResourceResult(value: unknown): ReadResourceResult {
	if (!isObject(value) || !Array.isArray(value.contents)) throw invalid("Invalid MCP resources/read result");
	for (const contents of value.contents) {
		if (
			!isObject(contents) ||
			typeof contents.uri !== "string" ||
			(typeof contents.text !== "string" && typeof contents.blob !== "string")
		) {
			throw invalid("Invalid contents in MCP resources/read result");
		}
	}
	return value as unknown as ReadResourceResult;
}

/**
 * `content` is required by the spec, but servers that only return `structuredContent` omit it (the SDK defaults it too).
 * `structuredContent` may be any JSON value, as MCP 2026-07-28 allows.
 */
function validateCallToolResult(value: unknown): CallToolResult {
	if (!isObject(value) || (value.content !== undefined && !Array.isArray(value.content))) {
		throw new McpError(JSON_RPC_ERROR_CODES.invalidRequest, "Invalid MCP tools/call result");
	}
	return (value.content === undefined ? { ...value, content: [] } : value) as unknown as CallToolResult;
}

/**
 * What a failed `initialize` tells about the server. Servers that only speak the stateless revision
 * reject it with a JSON-RPC error, over HTTP with a 400: `stateless` when the error has a code only that
 * revision uses, `unknown` for other such rejections, and undefined for failures that are no answer
 * (timeouts, closed connections, authorization).
 */
function initializeRejection(error: unknown): "stateless" | "unknown" | undefined {
	const code =
		error instanceof McpError
			? error.code
			: error instanceof McpHttpError && error.status === 400
				? jsonRpcErrorIn(error.body)?.code
				: null;
	if (code === null) return undefined;
	return code !== undefined && STATELESS_ERROR_CODES.includes(code) ? "stateless" : "unknown";
}

/** The connection closed under a request: the transport closed, or the stdio server was gone when written to. */
function isConnectionLost(error: unknown): boolean {
	// Node's write errors are the trust boundary here: `code` is all they carry.
	return (
		error instanceof McpConnectionClosedError || (error instanceof Error && "code" in error && error.code === "EPIPE")
	);
}

/** Thrown for an `initialize` answered with the stateless revision, which has no handshake. */
class StatelessInitializeError extends Error {}

export class McpClient {
	readonly options: Readonly<McpClientOptions>;
	private state: ClientState = "idle";
	private transport: McpTransport | undefined;
	private nextRequestId = 1;
	private serverInfoValue: Implementation | undefined;
	private serverCapabilitiesValue: ServerCapabilities | undefined;
	private instructionsValue: string | undefined;
	private protocolVersionValue: string | undefined;
	/** Whether the connection speaks the stateless revision: every request carries {@link meta}. */
	private stateless = false;
	private readonly meta: StatelessRequestMeta;
	/** `Mcp-Param-*` bindings of the tools last listed, for servers on the stateless revision. */
	private toolHeaders = new Map<string, ToolHeaderBinding[]>();
	private pending = new Map<JsonRpcId, PendingRequest>();
	private progressRequests = new Map<JsonRpcId, JsonRpcId>();
	private incoming = new Map<JsonRpcId, AbortController>();
	private requestHandlers = new Map<string, RequestHandler>();
	private notificationListeners = new Map<string, Set<NotificationListener>>();
	private errorListeners = new Set<ErrorListener>();
	private closeListeners = new Set<CloseListener>();
	private disposers: (() => void)[] = [];

	constructor(options: McpClientOptions) {
		this.options = Object.freeze({ ...options });
		const capabilities: ClientCapabilities = { ...options.capabilities };
		if (options.roots && capabilities.roots === undefined) capabilities.roots = {};
		this.meta = {
			protocolVersion: STATELESS_PROTOCOL_VERSION,
			clientInfo: {
				name: options.name,
				version: options.version,
				...(options.title === undefined ? {} : { title: options.title }),
			},
			clientCapabilities: capabilities,
			logLevel: options.logLevel,
		};
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

	/**
	 * Connect over `transport`. Resolves to what the server reported about itself; for servers on the
	 * stateless revision, a result in the shape of `initialize` built from `server/discover`.
	 */
	async connect(transport: McpTransport): Promise<InitializeResult> {
		if (this.state !== "idle") throw new Error(`Cannot connect MCP client in ${this.state} state`);
		this.state = "connecting";
		this.transport = transport;
		this.disposers = [
			transport.onMessage((message) => this.handleMessage(message)),
			// Transport errors are reported only. Pending requests fail when the transport closes.
			transport.onError((error) => this.emitError(error)),
			transport.onClose(() => this.handleTransportClose()),
		];

		try {
			await transport.start();
			const result =
				this.options.protocol === STATELESS_PROTOCOL_VERSION
					? await this.discover(transport, this.requestTimeoutMs())
					: await this.initializeOrDiscover(transport);
			this.state = "connected";
			return result;
		} catch (error) {
			await this.close().catch(() => {});
			throw error;
		}
	}

	/**
	 * `initialize` first, so servers of every earlier revision see what they always saw. Only a server
	 * that rejects it is asked with `server/discover`. When that fails too, the error is the rejection,
	 * unless the rejection proved a stateless server and the connection is still open: then
	 * `server/discover` failed for its own reason (sign-in required, say). Some stdio servers exit
	 * after rejecting `initialize`; they need a new connection with `protocol: "2026-07-28"`.
	 */
	private async initializeOrDiscover(transport: McpTransport): Promise<InitializeResult> {
		try {
			return await this.initialize(transport);
		} catch (error) {
			const rejection = error instanceof StatelessInitializeError ? "stateless" : initializeRejection(error);
			if (rejection === undefined) throw error;
			if (rejection === "stateless") {
				return await this.discover(transport, this.requestTimeoutMs()).catch((discoverError: unknown) => {
					throw isConnectionLost(discoverError) ? error : discoverError;
				});
			}
			const timeoutMs = Math.min(this.requestTimeoutMs(), DISCOVER_AFTER_INITIALIZE_TIMEOUT_MS);
			return await this.discover(transport, timeoutMs).catch(() => {
				throw error;
			});
		}
	}

	private async initialize(transport: McpTransport): Promise<InitializeResult> {
		const result = validateInitializeResult(
			await this.requestInternal(
				"initialize",
				{
					protocolVersion: this.options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
					capabilities: this.meta.clientCapabilities,
					clientInfo: this.meta.clientInfo,
				},
				{},
				true,
			),
		);
		if (result.protocolVersion === STATELESS_PROTOCOL_VERSION) {
			throw new StatelessInitializeError("MCP server answered initialize with the stateless protocol revision");
		}
		if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(result.protocolVersion)) {
			throw new Error(`MCP server selected unsupported protocol version ${result.protocolVersion}`);
		}
		this.protocolVersionValue = result.protocolVersion;
		this.serverInfoValue = result.serverInfo;
		this.serverCapabilitiesValue = result.capabilities;
		this.instructionsValue = result.instructions;
		transport.setProtocolVersion?.(result.protocolVersion);
		await this.notifyInternal("notifications/initialized", undefined, true);
		return result;
	}

	/** Speak the stateless revision: no handshake, `server/discover` tells what the server offers. */
	private async discover(transport: McpTransport, timeoutMs: number): Promise<InitializeResult> {
		this.stateless = true;
		transport.setProtocolVersion?.(STATELESS_PROTOCOL_VERSION);
		const { result, serverInfo } = validateDiscoverResult(
			await this.requestInternal("server/discover", undefined, { timeoutMs }, true),
		);
		if (!result.supportedVersions.includes(STATELESS_PROTOCOL_VERSION)) {
			throw new Error(`MCP server supports none of this client's protocol versions: ${result.supportedVersions}`);
		}
		this.protocolVersionValue = STATELESS_PROTOCOL_VERSION;
		this.serverInfoValue = serverInfo;
		this.serverCapabilitiesValue = result.capabilities;
		this.instructionsValue = result.instructions;
		return {
			protocolVersion: STATELESS_PROTOCOL_VERSION,
			capabilities: result.capabilities,
			serverInfo: serverInfo ?? { name: "", version: "" },
			...(result.instructions === undefined ? {} : { instructions: result.instructions }),
		};
	}

	request<Result = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options: McpRequestOptions = {},
	): Promise<Result> {
		return this.requestConnected(method, params, options) as Promise<Result>;
	}

	notify(method: string, params?: Record<string, unknown>): Promise<void> {
		return this.notifyInternal(method, params, false);
	}

	/**
	 * Answer requests of `method` from the server: requests a legacy server sends, and the input requests
	 * of the same method that results of the stateless revision ask for (`roots/list`, say).
	 */
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

	/** Called once when the connection closes, whether the transport dropped or `close()` was called. */
	onClose(listener: CloseListener): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	async ping(options: McpRequestOptions = {}): Promise<void> {
		await this.request("ping", undefined, options);
	}

	/**
	 * Every tool, following `nextCursor` through all pages. On the stateless revision, tools whose
	 * `x-mcp-header` annotations are invalid are left out and reported through `onError`.
	 */
	async listTools(options: McpRequestOptions = {}): Promise<Tool[]> {
		const tools = (await this.listAll("tools/list", "tools", isTool, options)) as unknown as Tool[];
		if (!this.stateless) return tools;
		const kept: Tool[] = [];
		const headers = new Map<string, ToolHeaderBinding[]>();
		for (const tool of tools) {
			const bindings = toolHeaderBindings(tool.inputSchema);
			if (bindings.kind === "invalid") {
				this.emitError(new Error(`Excluded MCP tool "${tool.name}": ${bindings.reason}`));
				continue;
			}
			if (bindings.bindings.length > 0) headers.set(tool.name, bindings.bindings);
			kept.push(tool);
		}
		this.toolHeaders = headers;
		return kept;
	}

	/** Every resource, following `nextCursor` through all pages. */
	async listResources(options: McpRequestOptions = {}): Promise<Resource[]> {
		return (await this.listAll("resources/list", "resources", isResource, options)).map(toResource);
	}

	/** One page of resources, starting at `cursor`. */
	async listResourcesPage(cursor?: string, options: McpRequestOptions = {}): Promise<ListResourcesResult> {
		const page = await this.listPage("resources/list", "resources", isResource, cursor, options);
		return { resources: page.items.map(toResource), ...pageCursor(page) };
	}

	/** Every resource template, following `nextCursor` through all pages. */
	async listResourceTemplates(options: McpRequestOptions = {}): Promise<ResourceTemplate[]> {
		const templates = await this.listAll(
			"resources/templates/list",
			"resourceTemplates",
			isResourceTemplate,
			options,
		);
		return templates.map(toResourceTemplate);
	}

	/** One page of resource templates, starting at `cursor`. */
	async listResourceTemplatesPage(
		cursor?: string,
		options: McpRequestOptions = {},
	): Promise<ListResourceTemplatesResult> {
		const page = await this.listPage(
			"resources/templates/list",
			"resourceTemplates",
			isResourceTemplate,
			cursor,
			options,
		);
		return { resourceTemplates: page.items.map(toResourceTemplate), ...pageCursor(page) };
	}

	async readResource(uri: string, options: McpRequestOptions = {}): Promise<ReadResourceResult> {
		return validateReadResourceResult(await this.request("resources/read", { uri }, options));
	}

	private async listPage(
		method: string,
		key: string,
		isItem: (item: Record<string, unknown>) => boolean,
		cursor: string | undefined,
		options: McpRequestOptions,
	): Promise<{ items: Record<string, unknown>[]; nextCursor?: string }> {
		return validateListPage(
			method,
			key,
			await this.request(method, cursor === undefined ? undefined : { cursor }, options),
			isItem,
		);
	}

	/** Every item of a paginated list method. */
	private async listAll(
		method: string,
		key: string,
		isItem: (item: Record<string, unknown>) => boolean,
		options: McpRequestOptions,
	): Promise<Record<string, unknown>[]> {
		const items: Record<string, unknown>[] = [];
		const cursors = new Set<string>();
		let cursor: string | undefined;
		for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber++) {
			const page = await this.listPage(method, key, isItem, cursor, options);
			items.push(...page.items);
			if (page.nextCursor === undefined) return items;
			if (cursors.has(page.nextCursor))
				throw new Error(`MCP ${method} returned duplicate cursor: ${page.nextCursor}`);
			cursors.add(page.nextCursor);
			cursor = page.nextCursor;
		}
		throw new Error(`MCP ${method} exceeded ${MAX_LIST_PAGES} pages`);
	}

	/**
	 * Call a tool. On the stateless revision, arguments the tool marks with `x-mcp-header` go into
	 * `Mcp-Param-*` headers too; when the server reports that they do not match, the tools are listed
	 * again for their current annotations and the call is sent once more.
	 */
	async callTool(
		name: string,
		args?: Record<string, unknown>,
		options: McpRequestOptions = {},
	): Promise<CallToolResult> {
		const params = { name, ...(args === undefined ? {} : { arguments: args }) };
		const call = async () => {
			const bindings = this.toolHeaders.get(name);
			const headers = bindings ? toolParamHeaders(bindings, args) : undefined;
			return validateCallToolResult(await this.requestConnected("tools/call", params, options, headers));
		};
		try {
			return await call();
		} catch (error) {
			if (!(this.stateless && error instanceof McpError && error.code === HEADER_MISMATCH_ERROR_CODE)) throw error;
			await this.listTools(options.signal ? { signal: options.signal } : {});
			return await call();
		}
	}

	async close(): Promise<void> {
		const transport = this.transport;
		this.transport = undefined;
		this.disposeTransportListeners();
		this.markClosed(new McpConnectionClosedError());
		await transport?.close();
	}

	/**
	 * A request on the connection. On the stateless revision, a result that asks for input is answered
	 * with the handlers of the input requests' methods, and the request is sent again with the answers
	 * until it completes. Every attempt is a new JSON-RPC request.
	 */
	private async requestConnected(
		method: string,
		params: Record<string, unknown> | undefined,
		options: McpRequestOptions,
		headers?: Record<string, string>,
	): Promise<unknown> {
		if (!this.stateless) return this.requestInternal(method, params, options, false, headers);
		let input: Record<string, unknown> = {};
		for (let round = 0; ; round++) {
			const result = readStatelessResult(
				method,
				await this.requestInternal(method, { ...params, ...input }, options, false, headers),
			);
			if (result.kind === "complete") return result.result;
			if (!INPUT_METHODS.has(method)) throw new Error(`MCP ${method} result asks for input, which it may not`);
			if (round + 1 >= MAX_INPUT_ROUNDS) {
				throw new Error(`MCP ${method} still asks for input after ${MAX_INPUT_ROUNDS} rounds`);
			}
			input = {
				inputResponses: await this.answerInputRequests(result.inputRequests, options.signal),
				...(result.requestState === undefined ? {} : { requestState: result.requestState }),
			};
		}
	}

	private async answerInputRequests(
		requests: Record<string, InputRequest>,
		signal: AbortSignal | undefined,
	): Promise<Record<string, unknown>> {
		const responses: Record<string, unknown> = {};
		for (const [key, request] of Object.entries(requests)) {
			const handler = this.requestHandlers.get(request.method);
			if (!handler) throw new Error(`MCP server asked for input this client does not provide: ${request.method}`);
			responses[key] = (await handler(request.params, { signal: signal ?? new AbortController().signal })) ?? {};
		}
		return responses;
	}

	private requestTimeoutMs(): number {
		return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	private async requestInternal(
		method: string,
		params: Record<string, unknown> | undefined,
		options: McpRequestOptions,
		allowConnecting: boolean,
		headers?: Record<string, string>,
	): Promise<unknown> {
		const transport = this.requireTransport(allowConnecting);
		if (options.signal?.aborted) throw new McpAbortError();
		const id = this.nextRequestId++;
		const progressToken = options.onProgress ? id : undefined;
		const metaParams = this.stateless ? withStatelessMeta(params, this.meta) : params;
		const requestParams =
			progressToken === undefined
				? metaParams
				: { ...metaParams, _meta: { ...(isObject(metaParams?._meta) ? metaParams._meta : {}), progressToken } };
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
				timeoutMs: options.timeoutMs ?? this.requestTimeoutMs(),
				timer: undefined,
				signal: options.signal,
				// The spec forbids cancelling `initialize`.
				onAbort: () =>
					this.cancelPending(
						id,
						new McpAbortError(),
						method !== "initialize",
						String(options.signal?.reason ?? "Aborted"),
					),
				sendController: new AbortController(),
				cancellable: method !== "initialize",
				onProgress: options.onProgress,
				progressToken,
			};
			this.pending.set(id, entry);
			if (progressToken !== undefined) this.progressRequests.set(progressToken, id);
			options.signal?.addEventListener("abort", entry.onAbort, { once: true });
			this.armTimeout(id, entry);
			transport
				.send(message, { signal: entry.sendController.signal, ...(headers === undefined ? {} : { headers }) })
				.catch((error) => this.cancelPending(id, error, false));
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
			this.cancelPending(id, new McpTimeoutError(entry.timeoutMs), entry.cancellable, "Request timed out");
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

	private rejectPending(error: unknown): void {
		for (const [id, entry] of this.pending) {
			this.removePending(id, entry);
			entry.reject(error);
		}
	}

	private handleTransportClose(): void {
		this.markClosed(new McpConnectionClosedError());
	}

	/** Idempotent: rejects in-flight requests, aborts server requests we are serving, and flips the state. */
	private markClosed(error: Error): void {
		const wasClosed = this.state === "closed";
		this.state = "closed";
		this.rejectPending(error);
		for (const controller of this.incoming.values()) controller.abort(error);
		this.incoming.clear();
		if (wasClosed) return;
		for (const listener of [...this.closeListeners]) {
			try {
				listener();
			} catch (listenerError) {
				this.emitError(listenerError);
			}
		}
	}

	private emitError(error: unknown): void {
		const normalized = toError(error);
		for (const listener of this.errorListeners) listener(normalized);
	}

	private disposeTransportListeners(): void {
		for (const dispose of this.disposers.splice(0)) dispose();
	}
}
