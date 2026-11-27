import type { AuthProvider, McpFetch } from "../auth-provider.ts";
import { PROTOCOL_VERSION_HEADER, standardRequestHeaders } from "../protocol/http-headers.ts";
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
	McpAbortError,
	McpConnectionClosedError,
	normalizeOwnRequestId,
	parseJsonRpcMessage,
	toError,
} from "../protocol/jsonrpc.ts";
import { META_PROTOCOL_VERSION } from "../protocol/modern.ts";
import {
	isModernProtocolVersion,
	type ModernProtocolVersion,
	type SupportedProtocolVersion,
} from "../protocol/types.ts";
import { McpAuthRequiredError, McpHttpError, McpSessionExpiredError } from "./http-errors.ts";
import {
	DEFAULT_MAX_MESSAGE_BYTES,
	type McpModernTransportSupport,
	type McpTransport,
	type McpTransportSendOptions,
	TransportEvents,
} from "./transport.ts";

export { McpAuthRequiredError, McpHttpError, McpSessionExpiredError };

const MAX_ERROR_BODY_BYTES = 8 * 1024;
const ERROR_MESSAGE_BODY_CHARS = 500;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_MAX_RETRIES = 5;

export interface SseEvent {
	event?: string;
	data: string;
	id?: string;
}

export interface ConsumeSseOptions {
	maxEventBytes?: number;
	/** Stops reading and closes the stream; the returned promise then resolves. */
	signal?: AbortSignal;
	onEvent(event: SseEvent): void;
	/** Called for every `id` field, including events without data (for example resumption priming events). */
	onId?(id: string): void;
	/** Called for every valid `retry` field, in milliseconds. */
	onRetry?(delayMs: number): void;
}

export async function consumeSseStream(stream: ReadableStream<Uint8Array>, options: ConsumeSseOptions): Promise<void> {
	const reader = stream.getReader();
	const cancel = () => void reader.cancel().catch(() => {});
	if (options.signal?.aborted) cancel();
	options.signal?.addEventListener("abort", cancel, { once: true });
	const decoder = new TextDecoder();
	// The incomplete last line. Only new text is scanned and the line is read once when it ends, so a large
	// line arriving in many chunks costs time linear in its size.
	let pendingLine = "";
	let pendingLineBytes = 0;
	let eventName: string | undefined;
	let eventId: string | undefined;
	let dataLines: string[] = [];
	// Bytes of the pending event's data, including the "\n" joins, so events streamed as many
	// short `data:` lines without a terminating blank line cannot grow without bound.
	let dataBytes = 0;
	const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_MESSAGE_BYTES;

	const dispatch = () => {
		if (dataLines.length === 0) {
			eventName = undefined;
			eventId = undefined;
			return;
		}
		const data = dataLines.join("\n");
		options.onEvent({ ...(eventName ? { event: eventName } : {}), data, ...(eventId ? { id: eventId } : {}) });
		eventName = undefined;
		eventId = undefined;
		dataLines = [];
		dataBytes = 0;
	};

	const processLine = (line: string) => {
		if (line === "") {
			dispatch();
			return;
		}
		if (line.startsWith(":")) return;
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") {
			dataBytes += Buffer.byteLength(value) + (dataLines.length > 0 ? 1 : 0);
			if (dataBytes > maxEventBytes) throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
			dataLines.push(value);
		} else if (field === "event") eventName = value;
		else if (field === "id" && !value.includes("\0")) {
			eventId = value;
			options.onId?.(value);
		} else if (field === "retry" && /^\d+$/.test(value)) options.onRetry?.(Number(value));
	};

	// SSE lines end with CRLF, LF, or a lone CR.
	let skipLeadingLf = false;
	const consumeLines = (text: string) => {
		let start = 0;
		for (let i = 0; i < text.length; i++) {
			const char = text[i];
			if (char !== "\r" && char !== "\n") continue;
			processLine(pendingLine + text.slice(start, i));
			pendingLine = "";
			pendingLineBytes = 0;
			if (char === "\r") {
				if (i + 1 < text.length) {
					if (text[i + 1] === "\n") i++;
				} else {
					skipLeadingLf = true;
				}
			}
			start = i + 1;
		}
		const rest = text.slice(start);
		pendingLine += rest;
		pendingLineBytes += Buffer.byteLength(rest);
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			let text = decoder.decode(value, { stream: true });
			// A CRLF split across chunks: the CR already ended the line, so drop the LF.
			if (skipLeadingLf && text.length > 0) {
				if (text.startsWith("\n")) text = text.slice(1);
				skipLeadingLf = false;
			}
			consumeLines(text);
			if (pendingLineBytes > maxEventBytes) throw new Error(`MCP SSE event exceeds ${maxEventBytes} bytes`);
		}
		let tail = decoder.decode();
		if (skipLeadingLf && tail.startsWith("\n")) tail = tail.slice(1);
		consumeLines(tail);
		if (pendingLine) processLine(pendingLine);
		dispatch();
	} catch (error) {
		// Releasing the lock alone leaves the response open; the original error wins over a failed cancel.
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		options.signal?.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

export interface StreamableHttpReconnectOptions {
	/** Delay before the first reconnection attempt, unless the server sent a `retry` field. Default: 1000. */
	initialDelayMs?: number;
	/** Upper bound for the exponential backoff. Default: 30000. */
	maxDelayMs?: number;
	/** Consecutive failed attempts before giving up on a stream. Default: 5. */
	maxRetries?: number;
}

export interface StreamableHttpTransportOptions {
	url: string | URL;
	headers?: Record<string, string>;
	fetch?: McpFetch;
	/** Open the server-to-client GET stream after initialization. Default: true. */
	openGetStream?: boolean;
	maxMessageBytes?: number;
	authProvider?: AuthProvider;
	/** Reconnection of dropped SSE streams (the GET stream, and response streams that carry event IDs). */
	reconnect?: StreamableHttpReconnectOptions;
}

function contentType(response: Response): string | undefined {
	return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

/** 401, or 403 with an `insufficient_scope` bearer challenge (step-up authorization). */
function needsAuthorization(response: Response): boolean {
	if (response.status === 401) return true;
	if (response.status !== 403) return false;
	return /(?:^|[\s,])error="?insufficient_scope"?/i.test(response.headers.get("www-authenticate") ?? "");
}

/** Statuses worth retrying when a stream fails to (re)open. */
function isTransientStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

function discard(response: Response): Promise<void> {
	return response.body?.cancel().catch(() => {}) ?? Promise.resolve();
}

/**
 * Reads a response body as text, decoding chunks as they arrive. Once the body exceeds `maxBytes`, the rest is
 * cancelled and the text holds only the first `maxBytes` bytes.
 */
async function readBodyText(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
	if (!response.body) return { text: "", truncated: false };
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let remaining = maxBytes;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return { text: text + decoder.decode(), truncated: false };
			if (value.byteLength > remaining) {
				await reader.cancel().catch(() => {});
				// Decoding a subarray copies only the kept bytes, so the result never references the dropped rest.
				return { text: text + decoder.decode(value.subarray(0, remaining), { stream: true }), truncated: true };
			}
			remaining -= value.byteLength;
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

function describeHttpFailure(status: number, body: string): string {
	const text = body.trim();
	const snippet = text.length > ERROR_MESSAGE_BODY_CHARS ? `${text.slice(0, ERROR_MESSAGE_BODY_CHARS - 3)}...` : text;
	return `MCP HTTP request failed with status ${status}${snippet ? `: ${snippet}` : ""}`;
}

interface StreamCursor {
	lastEventId: string | undefined;
	retryMs: number | undefined;
	/** Whether the stream delivered any event since it was (re)opened. */
	received: boolean;
}

/**
 * The version a request of the stateless protocol (MCP 2026-07-28) declares in its `_meta`. Read from
 * the message, so the `MCP-Protocol-Version` header always matches the body, as servers require.
 */
function modernVersionOf(message: JsonRpcRequest): ModernProtocolVersion | undefined {
	if (!isObject(message.params) || !isObject(message.params._meta)) return undefined;
	const version = message.params._meta[META_PROTOCOL_VERSION];
	return typeof version === "string" && isModernProtocolVersion(version) ? version : undefined;
}

/** The JSON-RPC error response in an HTTP error body, which modern servers send with 4xx statuses. */
function jsonRpcErrorIn(body: string, request: JsonRpcRequest): JsonRpcMessage | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (!isObject(parsed) || parsed.jsonrpc !== "2.0" || !isObject(parsed.error)) return undefined;
	const { code, message, data } = parsed.error;
	if (typeof code !== "number" || typeof message !== "string") return undefined;
	// Servers that reject a request before reading it cannot echo its id.
	return { jsonrpc: "2.0", id: request.id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export class StreamableHttpTransport extends TransportEvents implements McpTransport {
	readonly modernProtocol: McpModernTransportSupport = { headers: true };
	readonly url: URL;
	readonly options: Readonly<StreamableHttpTransportOptions>;
	private fetch: McpFetch;
	private controller = new AbortController();
	private started = false;
	private closed = false;
	private sessionIdValue: string | undefined;
	private protocolVersion: SupportedProtocolVersion | undefined;
	private getStreamStarted = false;
	/** Access token of the latest request, which `close()` reuses instead of asking the auth provider. */
	private lastToken: string | undefined;
	/** Requests of the stateless protocol in flight. Closing their response stream cancels them. */
	private modernRequests = new Set<JsonRpcId>();

	constructor(options: StreamableHttpTransportOptions) {
		super();
		this.options = Object.freeze({ ...options, headers: options.headers ? { ...options.headers } : undefined });
		this.url = new URL(options.url);
		const fetch = options.fetch ?? globalThis.fetch;
		// Call fetch without a receiver. `this.fetch(...)` and `context.fetch(...)` would pass the transport or
		// the auth context as `this`, which Cloudflare Workers reject for the platform fetch ("Illegal invocation").
		this.fetch = (input, init) => fetch(input, init);
	}

	get sessionId(): string | undefined {
		return this.sessionIdValue;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("MCP Streamable HTTP transport already started");
		if (this.closed) throw new McpConnectionClosedError();
		this.started = true;
	}

	setProtocolVersion(version: SupportedProtocolVersion): void {
		this.protocolVersion = version;
	}

	async send(message: JsonRpcMessage, options: McpTransportSendOptions = {}): Promise<void> {
		if (!this.started || this.closed) throw new McpConnectionClosedError();
		if (isJsonRpcRequest(message)) {
			const modernVersion = modernVersionOf(message);
			if (modernVersion !== undefined) {
				await this.sendModern(message, modernVersion, options);
				return;
			}
		}
		if (
			isJsonRpcNotification(message) &&
			message.method === "notifications/cancelled" &&
			isObject(message.params) &&
			isJsonRpcId(message.params.requestId) &&
			this.modernRequests.has(message.params.requestId)
		) {
			// MCP 2026-07-28 over HTTP cancels by closing the response stream, which aborting the send did.
			return;
		}
		const { signal } = options;
		const response = await this.authorizedFetch(
			"POST",
			{
				headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
				body: JSON.stringify(message),
			},
			signal,
		);
		await this.checkResponse(response);
		this.captureSession(response);

		if (!isJsonRpcRequest(message)) {
			// Notifications and responses are acknowledged with 202 and carry no reply; ignore any body.
			await discard(response);
			// The server-to-client stream may only open once the session is initialized.
			if ("method" in message && message.method === "notifications/initialized") this.startGetStream();
			return;
		}
		if (response.status === 202 || response.status === 204) {
			throw new McpHttpError(response.status, `MCP server accepted request ${message.method} without a response`);
		}
		const type = contentType(response);
		if (type === "application/json") {
			await this.readJsonResponse(response);
			return;
		}
		if (type === "text/event-stream" && response.body) {
			void this.consumeResponseStream(response.body, message.id);
			return;
		}
		await discard(response);
		throw new McpHttpError(response.status, `Unsupported MCP response content type: ${type ?? "missing"}`);
	}

	/**
	 * Send a request of the stateless protocol: its version, method, and name in headers, no session,
	 * and a response stream that cannot be resumed. Aborting `signal` closes the response stream, which
	 * cancels the request. A JSON-RPC error in a 4xx body is delivered as the response.
	 */
	private async sendModern(
		message: JsonRpcRequest,
		version: ModernProtocolVersion,
		{ signal, headers }: McpTransportSendOptions,
	): Promise<void> {
		this.modernRequests.add(message.id);
		let streaming = false;
		try {
			streaming = await this.postModern(message, version, signal, headers);
		} finally {
			if (!streaming) this.modernRequests.delete(message.id);
		}
	}

	/** Resolves to whether the answer streams in the background. */
	private async postModern(
		message: JsonRpcRequest,
		version: ModernProtocolVersion,
		signal: AbortSignal | undefined,
		headers: Record<string, string> | undefined,
	): Promise<boolean> {
		const response = await this.authorizedFetch(
			"POST",
			{
				headers: {
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
					...headers,
					...standardRequestHeaders(message.method, message.params),
					[PROTOCOL_VERSION_HEADER]: version,
				},
				body: JSON.stringify(message),
				session: false,
				// Closing the connection cancels the request, also before the response arrives.
				abort: signal,
			},
			signal,
		);
		if (!response.ok && response.status !== 401) {
			const body = (await readBodyText(response, MAX_ERROR_BODY_BYTES).catch(() => ({ text: "" }))).text;
			const error = jsonRpcErrorIn(body, message);
			if (!error) throw new McpHttpError(response.status, describeHttpFailure(response.status, body), body);
			this.emitMessage(error);
			return false;
		}
		await this.checkResponse(response);
		if (response.status === 202 || response.status === 204) {
			throw new McpHttpError(response.status, `MCP server accepted request ${message.method} without a response`);
		}
		const type = contentType(response);
		if (type === "application/json") {
			await this.readJsonResponse(response);
			return false;
		}
		if (type === "text/event-stream" && response.body) {
			void this.consumeModernResponseStream(response.body, message.id, signal).finally(() =>
				this.modernRequests.delete(message.id),
			);
			return true;
		}
		await discard(response);
		throw new McpHttpError(response.status, `Unsupported MCP response content type: ${type ?? "missing"}`);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.controller.abort();
		if (this.started && this.sessionIdValue) {
			// Best effort: the session expires on the server anyway. The auth provider may refresh tokens
			// over the network, so it is not asked here and closing never waits for a refresh.
			try {
				const response = await this.fetch(this.url, {
					method: "DELETE",
					headers: this.buildHeaders({}, this.lastToken),
					signal: AbortSignal.timeout(1_000),
				});
				await discard(response);
			} catch {}
		}
		this.emitClose();
	}

	private async readJsonResponse(response: Response): Promise<void> {
		const maxBytes = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		const { text, truncated } = await readBodyText(response, maxBytes);
		if (truncated) throw new Error(`MCP JSON response exceeds ${maxBytes} bytes`);
		const body: unknown = JSON.parse(text);
		for (const item of Array.isArray(body) ? body : [body]) this.emitMessage(parseJsonRpcMessage(item));
	}

	/**
	 * Fetch with auth headers. A 401 (or a 403 asking for more scope) is handed to the auth provider
	 * once, and the request is retried with whatever credentials it left behind. `session: false` leaves
	 * out the session and the negotiated version, for requests of the stateless protocol. `abort` also
	 * aborts the fetch itself.
	 *
	 * `signal` only stops dispatch: getting a token or the authorization recovery can take a while, and a
	 * request its sender gave up on in the meantime must not reach the server. It does not abort the shared
	 * recovery, which other requests may wait for.
	 */
	private async authorizedFetch(
		method: "GET" | "POST",
		init: { headers: Record<string, string>; body?: string; session?: boolean; abort?: AbortSignal | undefined },
		signal?: AbortSignal,
	): Promise<Response> {
		const onUnauthorized = this.options.authProvider?.onUnauthorized?.bind(this.options.authProvider);
		const fetchSignal = init.abort ? AbortSignal.any([this.controller.signal, init.abort]) : this.controller.signal;
		for (let attempt = 0; ; attempt++) {
			const { headers, token } = await this.headers(init.headers, init.session ?? true);
			if (signal?.aborted) throw new McpAbortError();
			const response = await this.fetch(this.url, {
				method,
				headers,
				body: init.body,
				signal: fetchSignal,
			});
			if (attempt > 0 || !onUnauthorized || !needsAuthorization(response)) return response;
			try {
				await onUnauthorized({ response, serverUrl: this.url, fetch: this.fetch, token });
			} finally {
				await discard(response);
			}
		}
	}

	private async headers(
		extra: Record<string, string>,
		session: boolean,
	): Promise<{ headers: Headers; token?: string }> {
		const token = await this.options.authProvider?.token();
		this.lastToken = token;
		return { headers: this.buildHeaders(extra, token, session), ...(token ? { token } : {}) };
	}

	private buildHeaders(extra: Record<string, string>, token: string | undefined, session = true): Headers {
		const headers = new Headers(this.options.headers);
		if (session && this.sessionIdValue) headers.set("Mcp-Session-Id", this.sessionIdValue);
		if (session && this.protocolVersion) headers.set(PROTOCOL_VERSION_HEADER, this.protocolVersion);
		for (const [name, value] of Object.entries(extra)) headers.set(name, value);
		if (token) headers.set("Authorization", `Bearer ${token}`);
		return headers;
	}

	private captureSession(response: Response): void {
		const sessionId = response.headers.get("mcp-session-id");
		if (sessionId) this.sessionIdValue = sessionId;
	}

	private async checkResponse(response: Response): Promise<void> {
		if (response.ok) return;
		// Reads only the excerpt the error keeps and cancels the rest, so a huge error body is never buffered.
		const body = (await readBodyText(response, MAX_ERROR_BODY_BYTES).catch(() => ({ text: "" }))).text;
		if (response.status === 401) throw new McpAuthRequiredError(response, body);
		if (response.status === 404 && this.sessionIdValue) throw new McpSessionExpiredError(body);
		throw new McpHttpError(response.status, describeHttpFailure(response.status, body), body);
	}

	private async consumeSse(
		stream: ReadableStream<Uint8Array>,
		cursor: StreamCursor,
		onMessage?: (message: JsonRpcMessage) => void,
		signal?: AbortSignal,
	): Promise<void> {
		await consumeSseStream(stream, {
			maxEventBytes: this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
			...(signal === undefined ? {} : { signal }),
			onId: (id) => {
				cursor.lastEventId = id;
			},
			onRetry: (delayMs) => {
				cursor.retryMs = delayMs;
			},
			onEvent: (event) => {
				cursor.received = true;
				// Events without data prime resumption; other event types are not JSON-RPC.
				if (!event.data.trim() || (event.event !== undefined && event.event !== "message")) return;
				let message: JsonRpcMessage;
				try {
					message = parseJsonRpcMessage(JSON.parse(event.data));
				} catch (error) {
					this.emitError(error);
					return;
				}
				onMessage?.(message);
				this.emitMessage(message);
			},
		});
	}

	/**
	 * Read the SSE stream answering one request. When the stream ends or breaks before the response
	 * arrives and the server assigned event IDs, resume it with GET and `Last-Event-ID`, as the
	 * server may close response streams at will. Otherwise only this request fails.
	 */
	private async consumeResponseStream(body: ReadableStream<Uint8Array>, requestId: JsonRpcId): Promise<void> {
		const cursor: StreamCursor = { lastEventId: undefined, retryMs: undefined, received: false };
		let answered = false;
		const onMessage = (message: JsonRpcMessage) => {
			if (isJsonRpcResponse(message) && normalizeOwnRequestId(message.id) === requestId) answered = true;
		};
		let stream: ReadableStream<Uint8Array> | undefined = body;
		let failure: unknown;
		for (let attempt = 0; ; ) {
			if (stream) {
				try {
					await this.consumeSse(stream, cursor, onMessage);
					failure = undefined;
				} catch (error) {
					failure = error;
				}
			}
			if (answered || this.closed) return;
			if (failure !== undefined && !this.isRetryable(failure)) break;
			if (cursor.lastEventId === undefined || attempt >= this.maxRetries()) break;
			if (cursor.received) attempt = 0;
			cursor.received = false;
			if (!(await this.sleep(this.reconnectDelay(attempt++, cursor.retryMs)))) return;
			try {
				stream = await this.openSseStream(cursor.lastEventId);
			} catch (error) {
				failure = error;
				if (!this.isRetryable(error)) break;
				stream = undefined;
			}
		}
		if (this.closed) return;
		const reason = failure === undefined ? "stream ended without a response" : toError(failure).message;
		this.emitMessage({
			jsonrpc: "2.0",
			id: requestId,
			error: { code: JSON_RPC_ERROR_CODES.internalError, message: `MCP response stream failed: ${reason}` },
		});
	}

	/**
	 * Read the SSE stream answering one request of the stateless protocol. Its streams cannot be resumed:
	 * when one ends or breaks before the response, the request fails. Aborting `signal` closes it.
	 */
	private async consumeModernResponseStream(
		body: ReadableStream<Uint8Array>,
		requestId: JsonRpcId,
		signal: AbortSignal | undefined,
	): Promise<void> {
		let answered = false;
		let failure: unknown;
		try {
			await this.consumeSse(
				body,
				{ lastEventId: undefined, retryMs: undefined, received: false },
				(message) => {
					if (isJsonRpcResponse(message) && normalizeOwnRequestId(message.id) === requestId) answered = true;
				},
				signal,
			);
		} catch (error) {
			failure = error;
		}
		if (answered || this.closed || signal?.aborted) return;
		const reason = failure === undefined ? "stream ended without a response" : toError(failure).message;
		this.emitMessage({
			jsonrpc: "2.0",
			id: requestId,
			error: { code: JSON_RPC_ERROR_CODES.internalError, message: `MCP response stream failed: ${reason}` },
		});
	}

	private startGetStream(): void {
		if (this.options.openGetStream === false || this.getStreamStarted || this.closed) return;
		this.getStreamStarted = true;
		void this.runGetStream();
	}

	/** Keep the server-to-client stream open, reconnecting with backoff when it drops. */
	private async runGetStream(): Promise<void> {
		const cursor: StreamCursor = { lastEventId: undefined, retryMs: undefined, received: false };
		for (let attempt = 0; !this.closed; ) {
			try {
				const stream = await this.openSseStream(cursor.lastEventId);
				// The server does not offer a GET stream.
				if (!stream) return;
				const openedAt = Date.now();
				await this.consumeSse(stream, cursor);
				// A stream that stayed up for a while counts as healthy, even if it was idle.
				if (cursor.received || Date.now() - openedAt > this.maxDelay()) attempt = 0;
			} catch (error) {
				if (this.closed) return;
				if (!this.isRetryable(error)) {
					this.emitError(error);
					return;
				}
			}
			cursor.received = false;
			if (attempt >= this.maxRetries()) {
				this.emitError(new Error("MCP server-to-client stream dropped and could not be reopened"));
				return;
			}
			if (!(await this.sleep(this.reconnectDelay(attempt++, cursor.retryMs)))) return;
		}
	}

	/** Open a GET SSE stream. Resolves to undefined when the server answers 405 (no GET stream). */
	private async openSseStream(lastEventId: string | undefined): Promise<ReadableStream<Uint8Array> | undefined> {
		const response = await this.authorizedFetch("GET", {
			headers: {
				accept: "text/event-stream",
				...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
			},
		});
		if (response.status === 405) {
			await discard(response);
			return undefined;
		}
		await this.checkResponse(response);
		this.captureSession(response);
		const type = contentType(response);
		if (type !== "text/event-stream" || !response.body) {
			await discard(response);
			throw new McpHttpError(response.status, `Unsupported MCP GET response content type: ${type ?? "missing"}`);
		}
		return response.body;
	}

	/**
	 * Network failures and transient statuses are retried; auth, session, and protocol errors are not.
	 * `fetch` reports network failures, including a connection dropped mid-body, as `TypeError`.
	 */
	private isRetryable(error: unknown): boolean {
		if (error instanceof McpHttpError) return isTransientStatus(error.status);
		if (error instanceof TypeError) return true;
		const code = (error as { code?: unknown } | undefined)?.code;
		return typeof code === "string" && (code.startsWith("E") || code.startsWith("UND_ERR"));
	}

	private reconnectDelay(attempt: number, serverDelayMs: number | undefined): number {
		if (serverDelayMs !== undefined) return serverDelayMs;
		const initial = this.options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
		return Math.min(initial * 2 ** attempt, this.maxDelay());
	}

	private maxDelay(): number {
		return this.options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
	}

	private maxRetries(): number {
		return this.options.reconnect?.maxRetries ?? DEFAULT_RECONNECT_MAX_RETRIES;
	}

	/** Resolves false when the transport closed while waiting. */
	private sleep(ms: number): Promise<boolean> {
		const signal = this.controller.signal;
		if (signal.aborted) return Promise.resolve(false);
		return new Promise((resolve) => {
			const onAbort = () => {
				clearTimeout(timer);
				resolve(false);
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve(true);
			}, ms);
			// A reconnect wait alone does not keep the process alive.
			timer.unref?.();
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}
