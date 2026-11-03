import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type McpOAuthServerStore, MemoryOAuthStateStore } from "../src/oauth/index.ts";
import { listen, readBody } from "./helpers.ts";

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * Authorization server of an MCP server at `<origin>/mcp`: discovery, dynamic client registration,
 * PKCE, and rotating refresh tokens. Token responses name no scope. `cimd` advertises Client ID
 * Metadata Documents, `issParameter` the `iss` parameter of authorization responses. Paths in `stall`
 * never answer. Close it with `closeServers` from `afterEach`.
 */
export async function startAuthorizationServer(options: { cimd?: boolean; issParameter?: boolean } = {}) {
	const registrations: Record<string, unknown>[] = [];
	const authorizations: URLSearchParams[] = [];
	const tokenRequests: URLSearchParams[] = [];
	const challenges = new Map<string, string>();
	const refreshTokens = new Set<string>();
	const stall = new Set<string>();
	let refreshFailure: { error: string; onRequest?: () => Promise<void> } | undefined;
	let issued = 0;

	const issueTokens = () => {
		issued++;
		refreshTokens.add(`refresh-${issued}`);
		return { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, token_type: "Bearer" };
	};

	const origin = await listen(async (request: IncomingMessage, response: ServerResponse, origin: string) => {
		const url = new URL(request.url ?? "/", origin);
		if (stall.has(url.pathname)) return;
		switch (url.pathname) {
			case "/.well-known/oauth-protected-resource/mcp":
				return json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
			case "/.well-known/oauth-authorization-server":
				return json(response, 200, {
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
					...(options.cimd ? { client_id_metadata_document_supported: true } : {}),
					...(options.issParameter ? { authorization_response_iss_parameter_supported: true } : {}),
				});
			case "/register": {
				const metadata = JSON.parse(await readBody(request)) as Record<string, unknown>;
				registrations.push(metadata);
				return json(response, 201, { ...metadata, client_id: `client-${registrations.length}` });
			}
			case "/authorize": {
				authorizations.push(url.searchParams);
				const code = `code-${authorizations.length}`;
				challenges.set(code, url.searchParams.get("code_challenge") ?? "");
				const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
				redirect.searchParams.set("code", code);
				redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
				if (options.issParameter) redirect.searchParams.set("iss", origin);
				response.writeHead(302, { location: redirect.href }).end();
				return;
			}
			case "/token": {
				const params = new URLSearchParams(await readBody(request));
				tokenRequests.push(params);
				if (params.get("grant_type") === "authorization_code") {
					const code = params.get("code") ?? "";
					const verifier = createHash("sha256")
						.update(params.get("code_verifier") ?? "")
						.digest("base64url");
					if (challenges.get(code) !== verifier) return json(response, 400, { error: "invalid_grant" });
					challenges.delete(code);
					return json(response, 200, issueTokens());
				}
				const failure = refreshFailure;
				refreshFailure = undefined;
				if (failure) {
					await failure.onRequest?.();
					return json(response, 400, { error: failure.error });
				}
				if (!refreshTokens.delete(params.get("refresh_token") ?? "")) {
					return json(response, 400, { error: "invalid_grant" });
				}
				return json(response, 200, issueTokens());
			}
			default:
				response.writeHead(404).end();
		}
	});
	return {
		serverUrl: `${origin}/mcp`,
		/** Client metadata of dynamic client registrations. */
		registrations,
		/** Query parameters of authorization requests. */
		authorizations,
		/** Parameters of token requests. */
		tokenRequests,
		stall,
		/** Makes every refresh fail with `invalid_grant`, like a revoked grant. */
		revokeRefreshTokens: () => refreshTokens.clear(),
		/** Answers the next refresh with the OAuth `error`, after running `onRequest`. */
		failNextRefresh: (error: string, onRequest?: () => Promise<void>) => {
			refreshFailure = { error, onRequest };
		},
	};
}

export type AuthorizationServer = Awaited<ReturnType<typeof startAuthorizationServer>>;

/** An in-memory store whose refresh lock only runs `fn`: there is one process. */
export function memoryStore(): McpOAuthServerStore {
	return Object.assign(new MemoryOAuthStateStore(), { withRefreshLock: <T>(fn: () => Promise<T>) => fn() });
}

/**
 * An in-memory store that records whether each save happened while the refresh lock was held. With
 * `lockError`, taking the lock fails with it; `hold()` stands for another process holding the lock until
 * the returned function releases it. `lockRuns` are the calls of `withRefreshLock`.
 */
export function recordingStore(options: { lockError?: Error } = {}) {
	const memory = new MemoryOAuthStateStore();
	const saves: { locked: boolean; accessToken: string | undefined }[] = [];
	const lockRuns: Promise<unknown>[] = [];
	let locked = false;
	let held: Promise<void> | undefined;
	const store: McpOAuthServerStore = {
		load: () => memory.load(),
		save: (state) => {
			saves.push({ locked, accessToken: state.tokens?.access_token });
			memory.save(state);
		},
		withRefreshLock: (fn) => {
			const run = (async () => {
				await held;
				if (options.lockError) throw options.lockError;
				locked = true;
				try {
					return await fn();
				} finally {
					locked = false;
				}
			})();
			lockRuns.push(run.catch(() => undefined));
			return run;
		},
	};
	const hold = () => {
		let release = () => {};
		held = new Promise((resolve) => {
			release = resolve;
		});
		return release;
	};
	return { store, saves, lockRuns, hold, isLocked: () => locked };
}

/** Follows the authorization URL like a browser, up to the redirect back to the application. */
export async function authorizeInBrowser(authorizationUrl: string): Promise<string> {
	const response = await fetch(authorizationUrl, { redirect: "manual" });
	return response.headers.get("location") ?? "";
}
