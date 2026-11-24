import type { CallToolResult } from "./protocol/content.ts";
import { type ToolHeaderBinding, toolHeaderBindings, toolParamHeaders } from "./protocol/http-headers.ts";
import {
	isObject,
	JSON_RPC_ERROR_CODES,
	type JsonRpcId,
	McpConnectionClosedError,
	McpError,
	McpTimeoutError,
	normalizeOwnRequestId,
} from "./protocol/jsonrpc.ts";
import {
	isModernProtocolError,
	META_SUBSCRIPTION_ID,
	type ModernRequestMeta,
	mutualModernVersion,
	readModernResult,
	serverInfoOf,
	supportedVersions,
	validateDiscoverResult,
	withModernMeta,
} from "./protocol/modern.ts";
import {
	type ClientCapabilities,
	type DiscoverResult,
	type Implementation,
	type InitializeResult,
	type InputRequest,
	LATEST_MODERN_PROTOCOL_VERSION,
	LATEST_PROTOCOL_VERSION,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	type LoggingLevel,
	type McpProtocolEra,
	type McpProtocolMode,
	MODERN_PROTOCOL_VERSIONS,
	type ModernProtocolVersion,
	type ProgressNotification,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplate,
	type Root,
	type ServerCapabilities,
	SUPPORTED_PROTOCOL_VERSIONS,
	type SubscriptionFilter,
	type SupportedProtocolVersion,
	type Tool,
} from "./protocol/types.ts";
import { type ErrorListener, JsonRpcPeer, type NotificationListener, type RequestHandler } from "./rpc-peer.ts";
import { McpHttpError } from "./transports/http-errors.ts";
import type { McpTransport } from "./transports/transport.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_LIST_PAGES = 1_000;
/**
 * Rounds of input a server may ask for before one request completes. Servers may ask again until they
 * have what they need; this bounds a server that never does.
 */
const MAX_INPUT_ROUNDS = 16;
/** Methods whose results may ask for input in MCP 2026-07-28 (multi round-trip requests). */
const INPUT_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);

type ClientState = "idle" | "connecting" | "connected" | "closed";
type CloseListener = () => void;

export interface McpClientOptions extends Implementation {
	capabilities?: ClientCapabilities;
	/** Version the legacy `initialize` handshake asks for. Default: {@link LATEST_PROTOCOL_VERSION}. */
	protocolVersion?: SupportedProtocolVersion;
	/**
	 * Protocol to speak (see {@link McpProtocolMode}). Default: `legacy`. Transports without
	 * `modernProtocol` always use `legacy`; with them, `auto` and a pinned version (`2026-07-28`) start
	 * with `server/discover`.
	 */
	protocol?: McpProtocolMode;
	/**
	 * Modern servers send log messages (`notifications/message`) only for requests that name a level, so
	 * every modern request names this one. Without it, they send none. Legacy servers are not affected.
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

/** An open `subscriptions/listen` stream of a modern server. */
export interface McpSubscription {
	/** The notification types the server agreed to send. */
	readonly notifications: SubscriptionFilter;
	/**
	 * Settles when the subscription ends: resolves when the server ended it gracefully or `close()` was
	 * called, rejects when the connection or stream failed.
	 */
	readonly closed: Promise<void>;
	close(): void;
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
 * Whether a failed `server/discover` probe identifies a legacy server: any error response that is not
 * one of the modern errors, a client error status without one, or no answer in time. Auth failures and
 * transient statuses are not answers about the protocol.
 */
function isLegacyProbeAnswer(error: unknown): boolean {
	if (error instanceof McpError) return !isModernProtocolError(error);
	if (error instanceof McpTimeoutError) return true;
	if (!(error instanceof McpHttpError)) return false;
	const { status } = error;
	return status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
}

/** The protocol a connected client speaks. */
type Session =
	| { era: "legacy"; protocolVersion: string }
	| {
			era: "modern";
			protocolVersion: ModernProtocolVersion;
			/** Versions the client may switch to after an `UnsupportedProtocolVersionError`. */
			versions: readonly ModernProtocolVersion[];
			headers: boolean;
	  };

export class McpClient {
	readonly options: Readonly<McpClientOptions>;
	private state: ClientState = "idle";
	private transport: McpTransport | undefined;
	private readonly rpc = new JsonRpcPeer();
	private session: Session | undefined;
	private serverInfoValue: Implementation | undefined;
	private serverCapabilitiesValue: ServerCapabilities | undefined;
	private instructionsValue: string | undefined;
	/** `Mcp-Param-*` bindings of the tools last listed, for modern servers over HTTP. */
	private toolHeaders = new Map<string, ToolHeaderBinding[]>();
	/** Open `subscriptions/listen` requests by id, waiting for their acknowledgment. */
	private subscriptions = new Map<JsonRpcId, { acknowledge(filter: SubscriptionFilter): void; end(): void }>();
	private closeListeners = new Set<CloseListener>();
	private disposers: (() => void)[] = [];

	constructor(options: McpClientOptions) {
		this.options = Object.freeze({ ...options });
		this.rpc.setRequestHandler("ping", () => ({}));
		const roots = options.roots;
		if (roots) {
			this.rpc.setRequestHandler("roots/list", async () => ({
				roots: [...(typeof roots === "function" ? await roots() : roots)],
			}));
		}
		this.rpc.onNotification("notifications/subscriptions/acknowledged", (params) => this.handleAcknowledged(params));
		this.rpc.onNotification("notifications/cancelled", (params) => this.handleServerCancelled(params));
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
		return this.session?.protocolVersion;
	}

	/** Whether the connection uses the `initialize` handshake (`legacy`) or per-request metadata (`modern`). */
	get protocolEra(): McpProtocolEra | undefined {
		return this.session?.era;
	}

	/**
	 * Connect over `transport`. Resolves to what the server reported about itself; for modern servers, a
	 * result in the shape of `initialize` built from `server/discover`.
	 */
	async connect(transport: McpTransport): Promise<InitializeResult> {
		if (this.state !== "idle") throw new Error(`Cannot connect MCP client in ${this.state} state`);
		this.state = "connecting";
		this.transport = transport;
		this.rpc.attach(transport);
		this.disposers = [
			transport.onMessage((message) => this.rpc.receive(message)),
			// Transport errors are reported only. Pending requests fail when the transport closes.
			transport.onError((error) => this.rpc.emitError(error)),
			transport.onClose(() => this.handleTransportClose()),
		];

		try {
			await transport.start();
			const mode = this.options.protocol ?? "legacy";
			if (mode !== "auto" && mode !== "legacy" && !transport.modernProtocol) {
				throw new Error(`This MCP transport does not support the stateless protocol (${mode})`);
			}
			const discovered = transport.modernProtocol && mode !== "legacy" ? await this.discover(mode) : undefined;
			const result = discovered
				? this.startModern(
						discovered.result,
						discovered.version,
						mode === "auto" ? MODERN_PROTOCOL_VERSIONS : [discovered.version],
						transport.modernProtocol?.headers ?? false,
					)
				: await this.initialize(transport);
			this.state = "connected";
			return result;
		} catch (error) {
			await this.close().catch(() => {});
			throw error;
		}
	}

	async request<Result = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options: McpRequestOptions = {},
	): Promise<Result> {
		return (await this.requestConnected(method, params, options)) as Result;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		this.requireConnected();
		await this.rpc.notify(method, params);
	}

	/**
	 * Answer requests of `method` from the server: requests a legacy server sends, and the input requests
	 * of the same method a modern server returns (`roots/list`, `elicitation/create`, `sampling/createMessage`).
	 */
	setRequestHandler(method: string, handler: RequestHandler): () => void {
		return this.rpc.setRequestHandler(method, handler);
	}

	onNotification(method: string, listener: NotificationListener): () => void {
		return this.rpc.onNotification(method, listener);
	}

	onError(listener: ErrorListener): () => void {
		return this.rpc.onError(listener);
	}

	/** Called once when the connection closes, whether the transport dropped or `close()` was called. */
	onClose(listener: CloseListener): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	/** Check that the server answers: `ping` for legacy servers, `server/discover` for modern ones. */
	async ping(options: McpRequestOptions = {}): Promise<void> {
		await this.request(this.session?.era === "modern" ? "server/discover" : "ping", undefined, options);
	}

	/**
	 * Every tool, following `nextCursor` through all pages. Over HTTP, tools of modern servers whose
	 * `x-mcp-header` annotations are invalid are left out and reported through `onError`.
	 */
	async listTools(options: McpRequestOptions = {}): Promise<Tool[]> {
		const tools = (await this.listAll("tools/list", "tools", isTool, options)) as unknown as Tool[];
		const session = this.session;
		if (session?.era !== "modern" || !session.headers) return tools;
		const kept: Tool[] = [];
		const headers = new Map<string, ToolHeaderBinding[]>();
		for (const tool of tools) {
			const bindings = toolHeaderBindings(tool.inputSchema);
			if (bindings.kind === "invalid") {
				this.rpc.emitError(new Error(`Excluded MCP tool "${tool.name}": ${bindings.reason}`));
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

	async callTool(
		name: string,
		args?: Record<string, unknown>,
		options: McpRequestOptions = {},
	): Promise<CallToolResult> {
		const params = { name, ...(args === undefined ? {} : { arguments: args }) };
		const bindings = this.toolHeaders.get(name);
		const headers = bindings ? toolParamHeaders(bindings, args) : undefined;
		return validateCallToolResult(await this.requestConnected("tools/call", params, options, headers));
	}

	/**
	 * Open a `subscriptions/listen` stream of a modern server, which delivers the notifications `filter`
	 * names to `onNotification` listeners. Resolves once the server acknowledged it. Legacy servers send
	 * their notifications without one.
	 */
	async listen(filter: SubscriptionFilter, options: { signal?: AbortSignal } = {}): Promise<McpSubscription> {
		if (this.session?.era !== "modern") throw new Error("subscriptions/listen needs a modern MCP server");
		const controller = new AbortController();
		const onAbort = () => controller.abort(options.signal?.reason);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		let acknowledge!: (filter: SubscriptionFilter) => void;
		const acknowledged = new Promise<SubscriptionFilter>((resolve) => {
			acknowledge = resolve;
		});
		let id: JsonRpcId | undefined;
		const closed = this.requestModern(
			"subscriptions/listen",
			{ notifications: filter },
			{ signal: controller.signal, timeoutMs: Number.POSITIVE_INFINITY },
			undefined,
			// Every attempt is a new request, and the subscription is named by the id of the current one.
			(requestId) => {
				if (id !== undefined) this.subscriptions.delete(id);
				id = requestId;
				this.subscriptions.set(requestId, { acknowledge, end: () => controller.abort("ended by server") });
			},
		)
			.then(
				() => undefined,
				(error: unknown) => {
					// Closing the stream ourselves is how a subscription ends.
					if (controller.signal.aborted) return undefined;
					throw error;
				},
			)
			.finally(() => {
				if (id !== undefined) this.subscriptions.delete(id);
				options.signal?.removeEventListener("abort", onAbort);
			});
		const endedEarly = closed.then(() => {
			throw new Error("MCP subscription ended before the server acknowledged it");
		});
		// Only the race observes it; once acknowledged, the caller handles `closed`.
		endedEarly.catch(() => {});
		const notifications = await Promise.race([acknowledged, endedEarly]);
		return { notifications, closed, close: () => controller.abort("closed") };
	}

	async close(): Promise<void> {
		const transport = this.transport;
		this.transport = undefined;
		this.rpc.detach();
		this.disposeTransportListeners();
		this.markClosed(new McpConnectionClosedError());
		await transport?.close();
	}

	/** The legacy handshake: `initialize`, then `notifications/initialized`. */
	private async initialize(transport: McpTransport): Promise<InitializeResult> {
		const result = validateInitializeResult(
			await this.rpc.request(
				"initialize",
				{
					protocolVersion: this.options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
					capabilities: this.clientCapabilities(),
					clientInfo: this.clientInfo(),
				},
				// The spec forbids cancelling `initialize`.
				{ timeoutMs: this.requestTimeoutMs(), notifyCancel: false },
			),
		);
		if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(result.protocolVersion)) {
			throw new Error(`MCP server selected unsupported protocol version ${result.protocolVersion}`);
		}
		this.session = { era: "legacy", protocolVersion: result.protocolVersion };
		this.serverInfoValue = result.serverInfo;
		this.serverCapabilitiesValue = result.capabilities;
		this.instructionsValue = result.instructions;
		transport.setProtocolVersion?.(result.protocolVersion);
		await this.rpc.notify("notifications/initialized", undefined);
		return result;
	}

	/**
	 * Probe with `server/discover` and settle on a modern version. Resolves to undefined when `auto`
	 * should fall back to the legacy handshake: the server answered like a legacy server (including with
	 * something that is no discover result), or it supports no modern version the client knows. An
	 * `UnsupportedProtocolVersionError` is retried once with a version from its list. A pinned version is
	 * the only one used.
	 */
	private async discover(
		mode: "auto" | ModernProtocolVersion,
	): Promise<{ result: DiscoverResult; version: ModernProtocolVersion } | undefined> {
		const versions = mode === "auto" ? MODERN_PROTOCOL_VERSIONS : [mode];
		let version: ModernProtocolVersion = mode === "auto" ? LATEST_MODERN_PROTOCOL_VERSION : mode;
		for (let attempt = 0; ; attempt++) {
			let raw: unknown;
			try {
				raw = await this.rpc.request("server/discover", withModernMeta(undefined, this.modernMeta(version)), {
					timeoutMs: this.requestTimeoutMs(),
					notifyCancel: false,
				});
			} catch (error) {
				const supported = error instanceof McpError ? supportedVersions(error) : undefined;
				const mutual = supported && mutualModernVersion(supported, versions);
				if (mutual && attempt === 0) {
					version = mutual;
					continue;
				}
				if (mode === "auto" && (supported ? !mutual : isLegacyProbeAnswer(error))) return undefined;
				throw error;
			}
			let result: DiscoverResult;
			try {
				result = validateDiscoverResult(raw);
			} catch (error) {
				if (mode === "auto") return undefined;
				throw error;
			}
			const mutual = mutualModernVersion(result.supportedVersions, versions);
			if (mutual) return { result, version: mutual };
			if (mode === "auto") return undefined;
			throw new Error(
				`MCP server supports none of this client's protocol versions: ${result.supportedVersions.join(", ")}`,
			);
		}
	}

	private startModern(
		result: DiscoverResult,
		version: ModernProtocolVersion,
		versions: readonly ModernProtocolVersion[],
		headers: boolean,
	): InitializeResult {
		this.session = { era: "modern", protocolVersion: version, versions, headers };
		const serverInfo = serverInfoOf(result as unknown as Record<string, unknown>);
		this.serverInfoValue = serverInfo;
		this.serverCapabilitiesValue = result.capabilities;
		this.instructionsValue = result.instructions;
		return {
			protocolVersion: version,
			capabilities: result.capabilities,
			// Modern servers SHOULD name themselves, but need not.
			serverInfo: serverInfo ?? { name: "", version: "" },
			...(result.instructions === undefined ? {} : { instructions: result.instructions }),
		};
	}

	private async requestConnected(
		method: string,
		params: Record<string, unknown> | undefined,
		options: McpRequestOptions,
		headers?: Record<string, string>,
	): Promise<unknown> {
		const session = this.requireConnected();
		if (session.era === "modern") return this.requestModern(method, params, options, headers);
		return this.rpc.request(method, params, {
			...this.peerOptions(options),
			...(headers === undefined ? {} : { headers }),
		});
	}

	/**
	 * A request of the stateless protocol. It carries the client's metadata, is sent again with the
	 * version an `UnsupportedProtocolVersionError` names, and, for methods that may ask for input, is
	 * sent again with the answers to the server's input requests until it completes. Every attempt is
	 * a new JSON-RPC request.
	 */
	private async requestModern(
		method: string,
		params: Record<string, unknown> | undefined,
		options: McpRequestOptions,
		headers: Record<string, string> | undefined,
		onSent?: (id: JsonRpcId) => void,
	): Promise<unknown> {
		let input: { inputResponses: Record<string, unknown>; requestState: string | undefined } | undefined;
		let versionRetried = false;
		for (let round = 0; ; ) {
			const session = this.requireConnected();
			if (session.era !== "modern") throw new McpConnectionClosedError();
			const attemptParams = input
				? {
						...params,
						inputResponses: input.inputResponses,
						...(input.requestState === undefined ? {} : { requestState: input.requestState }),
					}
				: params;
			let raw: unknown;
			try {
				raw = await this.rpc.request(
					method,
					withModernMeta(attemptParams, this.modernMeta(session.protocolVersion)),
					{
						...this.peerOptions(options),
						...(headers === undefined ? {} : { headers }),
						...(onSent === undefined ? {} : { onSent }),
					},
				);
			} catch (error) {
				const supported = error instanceof McpError ? supportedVersions(error) : undefined;
				const mutual = supported && mutualModernVersion(supported, session.versions);
				if (!mutual || versionRetried) throw error;
				versionRetried = true;
				this.session = { ...session, protocolVersion: mutual };
				continue;
			}
			if (!INPUT_METHODS.has(method)) {
				if (isObject(raw) && raw.resultType !== undefined && raw.resultType !== "complete") {
					throw invalid(`Unsupported MCP ${method} result type: ${String(raw.resultType)}`);
				}
				return raw;
			}
			const result = readModernResult(method, raw);
			if (result.kind === "complete") return result.result;
			if (++round > MAX_INPUT_ROUNDS) {
				throw new Error(`MCP ${method} still asks for input after ${MAX_INPUT_ROUNDS} rounds`);
			}
			input = {
				inputResponses: await this.answerInputRequests(result.inputRequests, options.signal),
				requestState: result.requestState,
			};
		}
	}

	/** Answer a modern server's input requests with the handlers registered for their methods. */
	private async answerInputRequests(
		requests: Record<string, InputRequest>,
		signal: AbortSignal | undefined,
	): Promise<Record<string, unknown>> {
		const responses: Record<string, unknown> = {};
		for (const [key, request] of Object.entries(requests)) {
			const handler = this.rpc.requestHandler(request.method);
			if (!handler) throw new Error(`MCP server asked for input this client does not provide: ${request.method}`);
			responses[key] = (await handler(request.params, { signal: signal ?? new AbortController().signal })) ?? {};
		}
		return responses;
	}

	private requireConnected(): Session {
		if (this.transport && this.session && this.state === "connected") return this.session;
		throw new McpConnectionClosedError(`MCP client is ${this.state}`);
	}

	private peerOptions(options: McpRequestOptions) {
		return {
			timeoutMs: options.timeoutMs ?? this.requestTimeoutMs(),
			notifyCancel: true,
			...(options.signal === undefined ? {} : { signal: options.signal }),
			...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
		};
	}

	private requestTimeoutMs(): number {
		return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	private clientInfo(): Implementation {
		return {
			name: this.options.name,
			version: this.options.version,
			...(this.options.title === undefined ? {} : { title: this.options.title }),
		};
	}

	private clientCapabilities(): ClientCapabilities {
		const capabilities: ClientCapabilities = { ...this.options.capabilities };
		if (this.options.roots && capabilities.roots === undefined) capabilities.roots = {};
		return capabilities;
	}

	private modernMeta(protocolVersion: ModernProtocolVersion): ModernRequestMeta {
		return {
			protocolVersion,
			clientInfo: this.clientInfo(),
			clientCapabilities: this.clientCapabilities(),
			logLevel: this.options.logLevel,
		};
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

	/** `notifications/subscriptions/acknowledged` names the subscription it acknowledges in `_meta`. */
	private handleAcknowledged(params: unknown): void {
		const id = subscriptionIdOf(params);
		const filter = isObject(params) && isObject(params.notifications) ? params.notifications : {};
		if (id !== undefined) this.subscriptions.get(id)?.acknowledge(filter as SubscriptionFilter);
	}

	/** Modern servers send `notifications/cancelled` only to end a subscription. */
	private handleServerCancelled(params: unknown): void {
		const requestId = isObject(params) ? params.requestId : undefined;
		if (typeof requestId === "string" || typeof requestId === "number") {
			this.subscriptions.get(normalizeOwnRequestId(requestId))?.end();
		}
	}

	private handleTransportClose(): void {
		this.markClosed(new McpConnectionClosedError());
	}

	/** Idempotent: rejects in-flight requests, aborts server requests we are serving, and flips the state. */
	private markClosed(error: Error): void {
		const wasClosed = this.state === "closed";
		this.state = "closed";
		this.rpc.failAll(error);
		if (wasClosed) return;
		for (const listener of [...this.closeListeners]) {
			try {
				listener();
			} catch (listenerError) {
				this.rpc.emitError(listenerError);
			}
		}
	}

	private disposeTransportListeners(): void {
		for (const dispose of this.disposers.splice(0)) dispose();
	}
}

function subscriptionIdOf(params: unknown): JsonRpcId | undefined {
	const meta = isObject(params) && isObject(params._meta) ? params._meta : undefined;
	const id = meta?.[META_SUBSCRIPTION_ID];
	return typeof id === "string" || typeof id === "number" ? normalizeOwnRequestId(id) : undefined;
}
