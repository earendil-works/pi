import { createServer, type Server, type ServerResponse } from "node:http";

export interface OAuthCallback {
	code: string;
	state: string;
	iss?: string;
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
	private path: string;
	private timeoutMs: number;
	private renderPage: ((page: OAuthCallbackPage) => string) | undefined;
	private pending = new Map<
		string,
		{
			resolve: (callback: OAuthCallback) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();

	private constructor(
		server: Server,
		redirectUrl: string,
		path: string,
		timeoutMs: number,
		renderPage: ((page: OAuthCallbackPage) => string) | undefined,
	) {
		this.server = server;
		this.redirectUrl = redirectUrl;
		this.path = path;
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
			path,
			options.timeoutMs ?? 5 * 60_000,
			options.renderPage,
		);
		return instance;
	}

	waitForCallback(state: string): Promise<OAuthCallback> {
		if (this.pending.has(state)) throw new Error("OAuth state is already pending");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(state);
				reject(new Error("OAuth callback timed out"));
			}, this.timeoutMs);
			this.pending.set(state, { resolve, reject, timer });
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

	private handle(rawUrl: string, response: ServerResponse): void {
		const url = new URL(rawUrl, this.redirectUrl);
		if (url.pathname !== this.path) {
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
		pending.resolve({ code, state, ...(iss ? { iss } : {}) });
		this.reply(response, 200, { ok: true });
	}
}
