import { createServer, type Server, type ServerResponse } from "node:http";

export interface OAuthCallback {
	code: string;
	state: string;
	iss?: string;
}

export interface OAuthCallbackServerOptions {
	host?: string;
	port?: number;
	path?: string;
	timeoutMs?: number;
}

export class OAuthCallbackServer {
	readonly redirectUrl: string;
	private server: Server;
	private path: string;
	private timeoutMs: number;
	private pending = new Map<
		string,
		{
			resolve: (callback: OAuthCallback) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();

	private constructor(server: Server, redirectUrl: string, path: string, timeoutMs: number) {
		this.server = server;
		this.redirectUrl = redirectUrl;
		this.path = path;
		this.timeoutMs = timeoutMs;
	}

	static async listen(options: OAuthCallbackServerOptions = {}): Promise<OAuthCallbackServer> {
		const host = options.host ?? "127.0.0.1";
		const path = options.path ?? "/oauth/callback";
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
			`http://${host.includes(":") ? `[${host}]` : host}:${address.port}${path}`,
			path,
			options.timeoutMs ?? 5 * 60_000,
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

	private handle(rawUrl: string, response: ServerResponse): void {
		const url = new URL(rawUrl, this.redirectUrl);
		if (url.pathname !== this.path) {
			response.writeHead(404).end("Not found");
			return;
		}
		const state = url.searchParams.get("state");
		const pending = state ? this.pending.get(state) : undefined;
		if (!state || !pending) {
			response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Invalid or expired OAuth state");
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(state);
		const error = url.searchParams.get("error");
		if (error) {
			const message = url.searchParams.get("error_description") ?? error;
			pending.reject(new Error(message));
			response
				.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
				.end("Authorization failed. You may close this window.");
			return;
		}
		const code = url.searchParams.get("code");
		if (!code) {
			pending.reject(new Error("OAuth callback did not include an authorization code"));
			response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Missing authorization code");
			return;
		}
		pending.resolve({
			code,
			state,
			...(url.searchParams.get("iss") ? { iss: url.searchParams.get("iss") as string } : {}),
		});
		response
			.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
			.end("Authorization complete. You may close this window.");
	}
}
