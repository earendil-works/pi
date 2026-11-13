// The TUI launcher through Radius (`npm run tui -- --radius`): the launcher's own Radius sign-in, finding the server,
// and its requests as Radius client connections, which the server's Radius plugin answers (plugins/radius/brain.ts,
// "Client channels").
//
// Temporary: one Radius connection per request. Every connection counts against Radius's limit on new connections
// (120 a minute per user, shared with the server's own reconnects), so the launcher checks for a new bundle only every
// RADIUS_POLL_MS. The proper form carries all of a launcher's requests and its chord link over one connection; see
// docs/p2-notes.md "TUI through Radius".
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import { DEFAULT_RADIUS_GATEWAY, normalizeRadiusGatewayUrl } from "@earendil-works/pi-ai/providers/radius-config";
import { WebSocket } from "ws";
import { configDirectory } from "./tui-config.ts";
import type { TuiRequestInit, TuiSocket, TuiSocketEvents, TuiTransport } from "./tui-transport.ts";

/** A signed-in Radius user: the gateway and a current access token. */
export type RadiusClient = {
	readonly gateway: string;
	access(): Promise<string>;
};

/** A transport through Radius, and the server's origin as its last answer named it (see `TunnelHead.origin`). */
export type RadiusTransport = TuiTransport & { readonly origin: string | undefined };

/** How often a launcher through Radius checks for a new bundle (see the file comment). */
export const RADIUS_POLL_MS = 10_000;

type RadiusLogin = { gateway: string; credential: OAuthCredential };

/**
 * The launcher's Radius sign-in, kept in `<config>/radius.json` (0600): read, or made once by device code (`print`
 * shows the code), and refreshed before the token expires. Separate from a p2 server's own `radius.json`.
 */
export async function radiusClient(
	print: (text: string) => void,
	signal: AbortSignal,
	directory = configDirectory(),
): Promise<RadiusClient> {
	const path = join(directory, "radius.json");
	let login = readLogin(path);
	if (!login) {
		const gateway = normalizeRadiusGatewayUrl(process.env.PI_RADIUS_GATEWAY ?? DEFAULT_RADIUS_GATEWAY);
		print(`Signing in to Radius at ${gateway}`);
		const credential = await radiusOAuth(gateway).login({
			signal,
			prompt: async () => "device-code",
			notify: (event) => {
				if (event.type === "device_code")
					print(`Open ${event.verificationUri} and enter the code ${event.userCode}`);
			},
		});
		login = { gateway, credential: { ...credential, type: "oauth" } };
		saveLogin(directory, path, login);
	}
	let current = login;
	let refreshing: Promise<RadiusLogin> | undefined;
	return {
		gateway: current.gateway,
		access: async () => {
			if (current.credential.expires - Date.now() > REFRESH_MARGIN_MS) return current.credential.access;
			refreshing ??= radiusOAuth(current.gateway)
				.refresh(current.credential, AbortSignal.timeout(30_000))
				.then((credential) => {
					const next: RadiusLogin = { gateway: current.gateway, credential: { ...credential, type: "oauth" } };
					saveLogin(directory, path, next);
					return next;
				})
				.finally(() => {
					refreshing = undefined;
				});
			current = await refreshing;
			return current.credential.access;
		},
	};
}

const REFRESH_MARGIN_MS = 5 * 60_000;

function readLogin(path: string): RadiusLogin | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const value = JSON.parse(text) as Partial<RadiusLogin>;
	// A file on disk: checked before use.
	if (typeof value.gateway !== "string" || value.credential?.type !== "oauth")
		throw new Error(`Invalid ${path}; delete it to sign in to Radius again`);
	return value as RadiusLogin;
}

function saveLogin(directory: string, path: string, login: RadiusLogin): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(login, null, "\t")}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
}

function radiusOAuth(gateway: string) {
	const oauth = radiusProvider({ gateway }).auth.oauth;
	if (!oauth) throw new Error("The Radius provider has no OAuth support");
	return oauth;
}

/** The server to connect to: `serverId`, else this user's only server Radius reports online. */
export async function radiusServer(client: RadiusClient, serverId: string | undefined): Promise<string> {
	if (serverId) return serverId;
	const response = await fetch(new URL("/v1/servers", client.gateway), {
		headers: { authorization: `Bearer ${await client.access()}`, accept: "application/json" },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Radius did not list your servers (${response.status})`);
	const { servers } = (await response.json()) as { servers: { server_id: string; status: string }[] };
	const online = servers.filter((server) => server.status === "online").map((server) => server.server_id);
	if (online.length === 1) return online[0]!;
	throw new Error(
		online.length === 0
			? "None of your p2 servers is connected to Radius"
			: `Several of your servers are online; choose one with --radius <server-id>: ${online.join(", ")}`,
	);
}

/**
 * Requests to `serverId` through Radius, one client connection each. A request is one text message (`TunnelRequest`),
 * the body as binary messages and a text end marker. The server answers with one text message (`TunnelHead`): for
 * HTTP the response body follows as binary messages and a close with 1000 ends it; for the chord WebSocket, status 101
 * makes the connection the link itself.
 */
export function radiusTransport(client: RadiusClient, serverId: string): RadiusTransport {
	let origin: string | undefined;
	const connect = async (): Promise<WebSocket> => {
		const url = new URL(`/v1/servers/${encodeURIComponent(serverId)}/connect`, client.gateway);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		return new WebSocket(url, CLIENT_SUBPROTOCOL, {
			headers: { authorization: `Bearer ${await client.access()}` },
			maxPayload: MAX_MESSAGE_BYTES,
			handshakeTimeout: 10_000,
			followRedirects: false,
		});
	};
	const head = (data: Buffer): TunnelHead => {
		const value = parseHead(data);
		origin = value.origin;
		return value;
	};
	return {
		get origin() {
			return origin;
		},
		request: async (path, init) => tunnelRequest(await connect(), path, init, head),
		socket: (path, events) => tunnelSocket(connect(), path, events, head),
	};
}

const CLIENT_SUBPROTOCOL = "pi-server.client.v2";
/** Radius's limit for one message. */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const BODY_CHUNK_BYTES = 256 * 1024;
/** A streamed request body waits while more than this is unsent. */
const SEND_HIGH_BYTES = 1024 * 1024;
/** Statuses whose Response may not have a body. */
const NULL_BODY = new Set([204, 205, 304]);

/** The server's answer to a request (brain.ts writes it). */
type TunnelHead = { status: number; headers: [string, string][]; origin: string };

/** The server's answer, from the wire: checked before use. */
function parseHead(data: Buffer): TunnelHead {
	const value = JSON.parse(data.toString("utf8")) as Partial<TunnelHead>;
	if (
		typeof value.status !== "number" ||
		typeof value.origin !== "string" ||
		!Array.isArray(value.headers) ||
		!value.headers.every(
			(pair) => Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === "string"),
		)
	)
		throw new Error("Invalid answer through Radius");
	return value as TunnelHead;
}

/** One HTTP request over its own connection; the body streams with the socket paused while the reader is behind. */
function tunnelRequest(
	socket: WebSocket,
	path: string,
	init: TuiRequestInit,
	head: (data: Buffer) => TunnelHead,
): Promise<Response> {
	return new Promise<Response>((resolve, reject) => {
		let body: ReadableStreamDefaultController<Uint8Array> | undefined;
		let done = false;
		/** Ends the request once; `settle` tells the reader why, unless the reader itself cancelled the body. */
		const finish = (error?: Error, settle = true) => {
			if (done) return;
			done = true;
			init.signal.removeEventListener("abort", abort);
			if (!body) reject(error ?? new Error("The server closed the connection without an answer"));
			else if (settle && error) body.error(error);
			else if (settle) body.close();
			socket.terminate();
		};
		const abort = () => finish(new Error("Request aborted"));
		init.signal.addEventListener("abort", abort, { once: true });
		socket.on("error", () => {});
		socket.on("unexpected-response", (_request, response) => {
			response.resume();
			const status = response.statusCode ?? 502;
			// Radius answers 403 when the server refused the connection and 401 for an invalid sign-in: like any server's.
			if (status === 401 || status === 403) resolve(new Response(null, { status }));
			finish(new Error(`Radius refused the connection (${status})`));
		});
		socket.on("open", () => {
			void sendRequest(socket, path, init).catch((error: unknown) =>
				finish(error instanceof Error ? error : new Error(String(error))),
			);
		});
		socket.on("message", (data: Buffer, binary) => {
			if (done) return;
			if (body) {
				if (!binary) return finish(new Error("Invalid answer through Radius"));
				body.enqueue(data);
				if ((body.desiredSize ?? 1) <= 0) socket.pause();
				return;
			}
			let answer: TunnelHead;
			try {
				answer = head(data);
			} catch (error) {
				return finish(error as Error);
			}
			const stream = new ReadableStream<Uint8Array>(
				{
					start: (controller) => {
						body = controller;
					},
					pull: () => {
						socket.resume();
					},
					cancel: () => finish(undefined, false),
				},
				{ highWaterMark: 4 },
			);
			resolve(
				new Response(NULL_BODY.has(answer.status) ? null : stream, {
					status: answer.status,
					headers: answer.headers,
				}),
			);
		});
		socket.on("close", (code) =>
			finish(code === 1000 ? undefined : new Error(`The connection through Radius was lost (${code})`)),
		);
	});
}

async function sendRequest(socket: WebSocket, path: string, init: TuiRequestInit): Promise<void> {
	socket.send(JSON.stringify({ type: "http", method: init.method ?? "GET", path, headers: init.headers ?? {} }));
	const body = typeof init.body === "string" ? Buffer.from(init.body) : init.body;
	if (body instanceof Uint8Array)
		for (let offset = 0; offset < body.byteLength; offset += BODY_CHUNK_BYTES)
			socket.send(body.subarray(offset, offset + BODY_CHUNK_BYTES));
	else if (body)
		for await (const chunk of body) {
			socket.send(chunk);
			while (socket.bufferedAmount > SEND_HIGH_BYTES && socket.readyState === WebSocket.OPEN)
				await new Promise((resolve) => setTimeout(resolve, 10));
		}
	socket.send(JSON.stringify({ type: "end" }));
}

/** The chord WebSocket over its own connection: open once the server answers 101, then the link's frames unchanged. */
function tunnelSocket(
	connecting: Promise<WebSocket>,
	path: string,
	events: TuiSocketEvents,
	head: (data: Buffer) => TunnelHead,
): TuiSocket {
	let socket: WebSocket | undefined;
	let open = false;
	let terminated = false;
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		open = false;
		events.close();
	};
	void connecting.then((connected) => {
		socket = connected;
		connected.on("error", () => {});
		connected.on("unexpected-response", (_request, response) => {
			response.resume();
			connected.terminate();
			events.refused(response.statusCode ?? 502);
		});
		connected.on("open", () => connected.send(JSON.stringify({ type: "websocket", path, headers: {} })));
		connected.on("message", (data: Buffer, binary) => {
			if (open) return events.message(data, binary);
			let status: number | undefined;
			try {
				status = binary ? undefined : head(data).status;
			} catch {}
			if (status === 101) {
				open = true;
				events.open();
				return;
			}
			connected.terminate();
			if (status !== undefined) events.refused(status);
		});
		connected.on("close", close);
		if (terminated) connected.terminate();
	}, close);
	return {
		get open() {
			return open;
		},
		send: (data) => socket?.send(data),
		terminate: () => {
			terminated = true;
			socket?.terminate();
		},
	};
}
