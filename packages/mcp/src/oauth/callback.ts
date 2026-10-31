import { createServer, type Server, type ServerResponse } from "node:http";

export type OAuthCallbackResponse = OAuthCallbackPage | { redirectUrl: string };

export interface OAuthCallback {
	code: string;
	state: string;
	iss?: string;
	respond?: (result: OAuthCallbackResponse) => boolean;
}

/** Outcome shown on the browser page after the redirect. */
export type OAuthCallbackPage = { ok: true } | { ok: false; message: string; details?: string };

export interface OAuthCallbackServerOptions {
	/** Address to listen on. Default: `127.0.0.1`. */
	host?: string;
	/**
	 * Host name in `redirectUrl`, for example `localhost` for a client registered with it while
	 * listening on `127.0.0.1`. Default: `host`.
	 */
	redirectHost?: string;
	port?: number;
	path?: string;
	/** More paths that receive the callback, for example a server-specific path of a redirect URI. */
	extraPaths?: string[];
	timeoutMs?: number;
	/** Render the browser page as HTML. Default: a plain-text message. */
	renderPage?: (page: OAuthCallbackPage) => string;
}

function plainText(page: OAuthCallbackPage): string {
	if (page.ok) return "Authorization complete. You may close this window.";
	return page.details ? `${page.message}\n\n${page.details}` : page.message;
}

export class OAuthCallbackServer {
	readonly redirectUrl: string;
	private server: Server;
	private paths: string[];
	private timeoutMs: number;
	private renderPage: ((page: OAuthCallbackPage) => string) | undefined;
	private pending = new Map<
		string,
		{
			resolve: (callback: OAuthCallback) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
			path: string | undefined;
			deferResponse: boolean;
		}
	>();

	private constructor(
		server: Server,
		redirectUrl: string,
		paths: string[],
		timeoutMs: number,
		renderPage: ((page: OAuthCallbackPage) => string) | undefined,
	) {
		this.server = server;
		this.redirectUrl = redirectUrl;
		this.paths = paths;
		this.timeoutMs = timeoutMs;
		this.renderPage = renderPage;
	}

	static async listen(options: OAuthCallbackServerOptions = {}): Promise<OAuthCallbackServer> {
		const host = options.host ?? "127.0.0.1";
		const redirectHost = options.redirectHost ?? host;
		const path = options.path ?? "/callback";
		let instance: OAuthCallbackServer | undefined;
		const server = createServer((request, response) => instance?.handle(request.url ?? "/", response));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port ?? 0, host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("OAuth callback server did not bind to TCP");
		instance = new OAuthCallbackServer(
			server,
			`http://${redirectHost.includes(":") ? `[${redirectHost}]` : redirectHost}:${address.port}${path}`,
			[path, ...(options.extraPaths ?? [])],
			options.timeoutMs ?? 5 * 60_000,
			options.renderPage,
		);
		return instance;
	}

	/**
	 * Wait for the authorization response with `state`. With `path`, a response on another path fails, so
	 * a server-specific redirect URI can tell authorization servers apart (RFC 9700 section 4.4.2.2).
	 */
	waitForCallback(state: string, path?: string, options: { deferResponse?: boolean } = {}): Promise<OAuthCallback> {
		if (this.pending.has(state)) throw new Error("OAuth state is already pending");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(state);
				reject(new Error("OAuth callback timed out"));
			}, this.timeoutMs);
			this.pending.set(state, { resolve, reject, timer, path, deferResponse: options.deferResponse === true });
		});
	}

	async close(): Promise<void> {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("OAuth callback server closed"));
		}
		this.pending.clear();
		await new Promise<void>((resolve, reject) => {
			this.server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	private reply(response: ServerResponse, status: number, page: OAuthCallbackPage): void {
		if (this.renderPage) {
			response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			response.end(this.renderPage(page));
		} else {
			response.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(plainText(page));
		}
	}

	private complete(response: ServerResponse, result: OAuthCallbackResponse): boolean {
		if (response.headersSent || response.destroyed) return false;
		if ("redirectUrl" in result) {
			response.shouldKeepAlive = false;
			response.writeHead(302, {
				location: result.redirectUrl,
				"cache-control": "no-store",
				connection: "close",
			});
			response.end();
			return true;
		}
		this.reply(response, result.ok ? 200 : 500, result);
		return true;
	}

	private handle(rawUrl: string, response: ServerResponse): void {
		const url = new URL(rawUrl, this.redirectUrl);
		if (!this.paths.includes(url.pathname)) {
			this.reply(response, 404, { ok: false, message: "Not found" });
			return;
		}
		const state = url.searchParams.get("state");
		const pending = state ? this.pending.get(state) : undefined;
		if (!state || !pending) {
			this.reply(response, 400, { ok: false, message: "Invalid or expired OAuth state" });
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(state);
		if (pending.path !== undefined && url.pathname !== pending.path) {
			pending.reject(new Error("The authorization response arrived on another redirect URI"));
			this.reply(response, 400, { ok: false, message: "Unexpected redirect URI" });
			return;
		}
		const error = url.searchParams.get("error");
		if (error) {
			const description = url.searchParams.get("error_description") ?? error;
			pending.reject(new Error(description));
			this.reply(response, 200, {
				ok: false,
				message: "Authorization failed. You may close this window.",
				details: description,
			});
			return;
		}
		const code = url.searchParams.get("code");
		if (!code) {
			pending.reject(new Error("OAuth callback did not include an authorization code"));
			this.reply(response, 400, { ok: false, message: "Missing authorization code" });
			return;
		}
		const iss = url.searchParams.get("iss");
		if (pending.deferResponse) {
			let responded = false;
			pending.resolve({
				code,
				state,
				...(iss ? { iss } : {}),
				respond: (result) => {
					if (responded) return false;
					responded = true;
					return this.complete(response, result);
				},
			});
			return;
		}
		pending.resolve({ code, state, ...(iss ? { iss } : {}) });
		this.reply(response, 200, { ok: true });
	}
}
