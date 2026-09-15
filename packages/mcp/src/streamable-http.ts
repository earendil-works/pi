import type { AuthProvider } from "./auth-provider.ts";
import { type JsonRpcMessage, McpConnectionClosedError, parseJsonRpcMessage } from "./protocol/jsonrpc.ts";
import { consumeSseStream } from "./sse.ts";
import type { McpTransport } from "./transport.ts";
import { TransportEvents } from "./transport-events.ts";

const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 8 * 1024;

export type McpFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface StreamableHttpTransportOptions {
	url: string | URL;
	headers?: Record<string, string>;
	fetch?: McpFetch;
	openGetStream?: boolean;
	maxMessageBytes?: number;
	authProvider?: AuthProvider;
}

export class McpHttpError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, message: string, body = "") {
		super(message);
		this.name = "McpHttpError";
		this.status = status;
		this.body = body;
	}
}

export class McpAuthRequiredError extends McpHttpError {
	readonly wwwAuthenticate: string | null;

	constructor(response: Response, body = "") {
		super(401, "MCP server requires authentication", body);
		this.name = "McpAuthRequiredError";
		this.wwwAuthenticate = response.headers.get("www-authenticate");
	}
}

export class McpSessionExpiredError extends McpHttpError {
	constructor(body = "") {
		super(404, "MCP session expired", body);
		this.name = "McpSessionExpiredError";
	}
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

export class StreamableHttpTransport extends TransportEvents implements McpTransport {
	readonly url: URL;
	readonly options: Readonly<StreamableHttpTransportOptions>;
	private fetch: McpFetch;
	private controller = new AbortController();
	private started = false;
	private closed = false;
	private closeEmitted = false;
	private sessionIdValue: string | undefined;
	private protocolVersion: string | undefined;
	private lastEventId: string | undefined;
	private getStreamStarted = false;

	constructor(options: StreamableHttpTransportOptions) {
		super();
		this.options = Object.freeze({ ...options, headers: options.headers ? { ...options.headers } : undefined });
		this.url = new URL(options.url);
		this.fetch = options.fetch ?? globalThis.fetch;
	}

	get sessionId(): string | undefined {
		return this.sessionIdValue;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("MCP Streamable HTTP transport already started");
		if (this.closed) throw new McpConnectionClosedError();
		this.started = true;
	}

	setProtocolVersion(version: string): void {
		this.protocolVersion = version;
		if (this.options.openGetStream !== false) void this.openGetStream();
	}

	async send(message: JsonRpcMessage): Promise<void> {
		await this.sendRequest(message, false);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.controller.abort();
		if (this.started && this.sessionIdValue) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 1_000);
			await this.fetch(this.url, {
				method: "DELETE",
				headers: await this.headers(),
				signal: controller.signal,
			}).catch(() => undefined);
			clearTimeout(timeout);
		}
		this.emitCloseOnce();
	}

	private async sendRequest(message: JsonRpcMessage, retriedAuth: boolean): Promise<void> {
		if (!this.started || this.closed) throw new McpConnectionClosedError();
		const response = await this.fetch(this.url, {
			method: "POST",
			headers: await this.headers({
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
			}),
			body: JSON.stringify(message),
			signal: this.controller.signal,
		});
		if (response.status === 401 && !retriedAuth && this.options.authProvider?.onUnauthorized) {
			try {
				await this.options.authProvider.onUnauthorized({ response, serverUrl: this.url, fetch: this.fetch });
			} finally {
				await response.body?.cancel().catch(() => {});
			}
			return this.sendRequest(message, true);
		}
		await this.checkResponse(response);
		this.captureSession(response);
		if (response.status === 202 || response.status === 204) return;
		const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
		if (contentType === "application/json") {
			this.emitMessage(parseJsonRpcMessage(await response.json()));
			return;
		}
		if (contentType === "text/event-stream" && response.body) {
			void this.consumeSse(response.body).catch((error) => this.emitError(toError(error)));
			return;
		}
		if (response.headers.get("content-length") === "0") return;
		throw new McpHttpError(response.status, `Unsupported MCP response content type: ${contentType ?? "missing"}`);
	}

	private async headers(extra: Record<string, string> = {}): Promise<Headers> {
		const headers = new Headers(this.options.headers);
		for (const [name, value] of Object.entries(extra)) headers.set(name, value);
		if (this.sessionIdValue) headers.set("Mcp-Session-Id", this.sessionIdValue);
		if (this.protocolVersion) headers.set("MCP-Protocol-Version", this.protocolVersion);
		if (this.lastEventId) headers.set("Last-Event-ID", this.lastEventId);
		const token = await this.options.authProvider?.token();
		if (token) headers.set("Authorization", `Bearer ${token}`);
		return headers;
	}

	private captureSession(response: Response): void {
		const sessionId = response.headers.get("mcp-session-id");
		if (sessionId) this.sessionIdValue = sessionId;
	}

	private async checkResponse(response: Response): Promise<void> {
		if (response.ok) return;
		const body = (await response.text().catch(() => "")).slice(0, MAX_ERROR_BODY_BYTES);
		if (response.status === 401) throw new McpAuthRequiredError(response, body);
		if (response.status === 404 && this.sessionIdValue) throw new McpSessionExpiredError(body);
		throw new McpHttpError(response.status, `MCP HTTP request failed with status ${response.status}`, body);
	}

	private async consumeSse(stream: ReadableStream<Uint8Array>): Promise<void> {
		await consumeSseStream(stream, {
			maxEventBytes: this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
			onEvent: (event) => {
				if (event.id) this.lastEventId = event.id;
				this.emitMessage(parseJsonRpcMessage(JSON.parse(event.data)));
			},
		});
	}

	private async openGetStream(): Promise<void> {
		if (this.getStreamStarted || this.closed || !this.started) return;
		this.getStreamStarted = true;
		try {
			const response = await this.fetch(this.url, {
				method: "GET",
				headers: await this.headers({ accept: "text/event-stream" }),
				signal: this.controller.signal,
			});
			if (response.status === 405) return;
			await this.checkResponse(response);
			this.captureSession(response);
			const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
			if (contentType !== "text/event-stream" || !response.body) {
				throw new McpHttpError(
					response.status,
					`Unsupported MCP GET response content type: ${contentType ?? "missing"}`,
				);
			}
			await this.consumeSse(response.body);
		} catch (error) {
			if (!this.closed) this.emitError(toError(error));
		}
	}

	private emitCloseOnce(): void {
		if (this.closeEmitted) return;
		this.closeEmitted = true;
		this.emitClose();
	}
}
