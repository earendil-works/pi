import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import { DEFAULT_RADIUS_GATEWAY, normalizeRadiusGatewayUrl } from "@earendil-works/pi-ai/providers/radius-config";
import { WebSocket } from "ws";
import type { Forwards } from "../ports/contract.ts";
import {
	encodeRelayUser,
	RELAY_ORIGIN_HEADER,
	RELAY_SECRET_HEADER,
	RELAY_SHELL_HEADER,
	RELAY_USER_HEADER,
	type RelayAccess,
} from "./relay-access.ts";

/**
 * p2 as a Radius brain
 * ===========================
 *
 * The brain keeps one outbound WebSocket to its relay in Radius (relay protocol
 * v4, `radius/packages/gateway/src/servers/protocol.ts`). Radius multiplexes
 * every browser connection over it as a channel and tells the brain who opened
 * it. Each channel becomes a loopback request to this server, marked with the
 * relay secret so the server treats it as the owner on the brain's cortex origin
 * (see relay-access.ts). No port is exposed and nothing listens publicly.
 *
 * The brain's Radius identity is separate from model providers: `radius.json`
 * in the data directory holds the gateway, a stable server ID, and an OAuth
 * credential from `npm run radius:login`.
 *
 * Who may open a channel. The owner reaches everything the owner reaches
 * locally. Radius also admits people, in any organization, to the brain's UI
 * when the brain shared a session with their email (`reportShares`): Radius
 * verifies the email, and the brain passes such a user on as a Radius user (not
 * an owner), whom p2's sharing maps to the sessions shared with that email now.
 * A user without an email, service accounts, and everyone but the owner on
 * forward origins are refused. Browser cookies never reach the server through
 * the brain's UI channels.
 *
 * Shares. Radius admits and lists a brain for the emails the brain reports with
 * `PUT /v1/servers/<id>/shares`, which replaces the whole set. The brain reports
 * whenever the set changes and after every connect, so a report lost while
 * offline is repaired by the next connection. Radius learns nothing else: not
 * which sessions, nor their titles.
 *
 * Backpressure. Nothing may buffer without bound between a loopback source and
 * a slow browser; the relay itself cannot see a slow WebSocket reader.
 *
 * - HTTP channels use the relay's credit flow control (`pi-server.host.v3`):
 *   response bodies stop at the window until the relay returns credit as the
 *   browser reads, and request bodies earn the relay credit as the loopback
 *   request takes them.
 * - WebSocket channels rely on the application acknowledging end to end (the
 *   terminal does; see shared/terminals.ts; chord links do too).
 * - Whatever the case, while more than CONGESTION_HIGH_BYTES are unsent on the
 *   socket to Radius, every loopback source on it is paused, so a slow uplink
 *   slows the server down instead of growing this process's memory.
 *
 * Channel sockets (relay protocol v5). One socket to Radius is one TCP stream:
 * a 500 KiB transcript snapshot in one tab delays the echo of a terminal in
 * another by the time the snapshot takes to cross the uplink, and the pause
 * above stops every channel at once. A v5 relay therefore has the brain open
 * one socket per WebSocket channel (`/v1/servers/<id>/channels/<connection>`,
 * authenticated like the host socket), and the brain pipes it to the loopback
 * socket unchanged. Each direction pauses its source while its destination has
 * more than PIPE_HIGH_BYTES unsent, so a slow reader slows only its own
 * channel. HTTP channels stay on the host socket with credit flow control.
 *
 * Port forwards (relay protocol v4). A channel whose `connection_open` names a
 * `forward` comes from that forward's own origin
 * (`fwd--<label>--<forward>.rdtun.com`, see shared/forwards.ts), not from the
 * brain's UI. It goes to `localhost:<port>` of the forward, never to this
 * server: it carries no relay secret, `Host` is the target's own, and `Origin`
 * and redirects to `localhost` are translated between the two origins. A
 * forward ID this server does not know answers 404 (HTTP) or closes the
 * channel. `stream` channels, end-to-end forwards whose TLS terminates in the
 * environment, are not supported yet and are closed at once.
 *
 * Reconnecting. A network loss rarely closes the socket: packets just stop, and
 * TCP may take many minutes to notice (after a laptop sleeps, the socket can look
 * open indefinitely). The brain therefore watches for anything from the relay.
 * After HEARTBEAT_IDLE_MS of silence it sends a `ping`, which the relay answers
 * with `pong`; after HEARTBEAT_TIMEOUT_MS of silence it terminates the socket and
 * reconnects with backoff. The handshake has its own timeout, so a connection
 * attempt into a dead network fails instead of hanging. The relay keeps a lost
 * host until its own heartbeat expires (90 s by default) and refuses a second
 * one meanwhile with 409. A brain that noticed the loss first would stay
 * offline until then, up to 90 s, while browsers opened channels into the
 * dead socket and waited for them to time out. The brain therefore connects with
 * `?replace=1`: the relay fails the old host and its channels and takes the new
 * socket at once. Relays that predate the parameter ignore it and answer 409,
 * which the backoff retries until the old host expires.
 *
 * Two p2 processes with the same `radius.json` share one server ID, so they
 * would replace each other in turn. The relay closes a replaced host with 1012
 * "Server host replaced", and that is always another process: this one gives up
 * its own socket before it reconnects. The brain then yields: it reconnects
 * without `replace`, gets 409 until the other process is gone, and replaces
 * again once it is connected. So the most recently started process wins.
 *
 * Public forwards. Radius opens channels from a forward's public origin
 * (`pub--<label>--<forward>`) without a principal: nobody signed in. Such a
 * channel reaches only a forward the owner marked public; for any other
 * forward, and for the brain's own UI, it is refused like an unknown forward.
 */

/** Offered newest first; v3 adds credit flow control for HTTP channels, v4 port forwards, v5 channel sockets. */
const HOST_SUBPROTOCOLS = ["pi-server.host.v5", "pi-server.host.v4", "pi-server.host.v3", "pi-server.host.v2"];
const FLOW_SUBPROTOCOLS = new Set(["pi-server.host.v5", "pi-server.host.v4", "pi-server.host.v3"]);
const CHANNEL_HOST_SUBPROTOCOL = "pi-server.host.v5";
const CHANNEL_SUBPROTOCOL = "pi-server.channel.v1";
/** A channel socket's direction pauses its source above this many unsent bytes, and resumes below the low mark. */
const PIPE_HIGH_BYTES = 256 * 1024;
const PIPE_LOW_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** The relay's default window, for relays that do not state it in `connection_open`. */
const DEFAULT_HTTP_WINDOW = 256 * 1024;
const CONGESTION_HIGH_BYTES = 1024 * 1024;
const CONGESTION_LOW_BYTES = 256 * 1024;
const CONGESTION_POLL_MS = 10;
const PROTOCOL_VERSION = 2;
const DATA_HEADER_BYTES = 18;
const FRAME = { binary: 1, text: 2, end: 3 } as const;
const BODY_CHUNK_BYTES = 256 * 1024;
const REFRESH_MARGIN_MS = 5 * 60_000;
const SHELL_ORIGIN = /^https?:\/\/[^/\s]+$/;
const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** Silence from the relay after which the brain pings it; the relay pings an idle host itself only after 30 s. */
const HEARTBEAT_IDLE_MS = 20_000;
/** Silence from the relay after which the connection counts as lost and is replaced. */
const HEARTBEAT_TIMEOUT_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** The relay's close of a host socket another brain with this server ID replaced (relay protocol). */
const REPLACED_CODE = 1012;
const REPLACED_REASON = "Server host replaced";
/** Request headers the brain sets itself on loopback requests. */
const DROPPED_HEADERS = new Set([
	"host",
	"connection",
	"upgrade",
	"content-length",
	"transfer-encoding",
	"x-radius-shell-origin",
	RELAY_SECRET_HEADER,
	RELAY_ORIGIN_HEADER,
	RELAY_SHELL_HEADER,
	RELAY_USER_HEADER,
]);

export type RadiusBrainConfig = {
	gateway: string;
	serverId: string;
	/**
	 * The brain's own Radius origin (`https://<label>.rdtun.com`), as last seen on a relayed request for its UI. Saved so
	 * forward links are known after a restart before anyone opens Pi through Radius again.
	 */
	publicOrigin?: string;
	/**
	 * This brain's page in the Radius shell (`<shell>/pi/brains/<organization>/<server>`), as last seen on a relayed
	 * request for its UI. People sessions are shared with by email open them there, signed in to Radius.
	 */
	shellPage?: string;
	credential: OAuthCredential;
};

export type RadiusStatus =
	/** No radius.json: this p2 is local only. Checked again periodically, so a later login connects. */
	| { status: "signed_out" }
	| { status: "connecting" }
	| { status: "connected"; serverId: string; organizationId: string }
	| { status: "retrying"; error: string };

/** Who opened a channel; `email` (normalized, verified) is set for people other than the owner. */
type Principal = { kind: string; id: string; organization_id: string; email?: string };
type RequestHead = { method: string; path: string; headers: [string, string][] };
type Control =
	| {
			version: 2;
			type: "connection_open";
			connection_id: string;
			kind: "ws" | "http" | "stream";
			/** Absent on `stream` channels, which nobody has authenticated. */
			principal?: Principal;
			public_origin?: string;
			request?: RequestHead;
			/** HTTP channels with flow control: initial window of body bytes in each direction. */
			window?: number;
			/** Channels from a forward's origin: the forward ID. */
			forward?: string;
	  }
	| { version: 2; type: "connection_close"; connection_id: string; code?: number }
	| { version: 2; type: "credit"; connection_id: string; bytes: number }
	| { version: 2; type: "ping" }
	| { version: 2; type: "pong" };

/** Where a channel's loopback connection goes. */
type Target = {
	host: string;
	port: number;
	/** Rewrites a response's `Location`; forwards map `http://localhost:<port>` to their public origin. */
	location?: (value: string) => string;
	/** Forwards answer with this instead of closing when nothing listens on the port. */
	unavailable?: string;
};

type Channel = {
	data(payload: Buffer, type: "binary" | "text" | "end"): void;
	close(): void;
	/** The relay's credit for response body bytes (HTTP channels with flow control). */
	credit(bytes: number): void;
	/** Stop or restart reading the loopback source while the socket to Radius is congested. */
	congested(paused: boolean): void;
};

export function radiusConfigPath(directory: string): string {
	return join(directory, "radius.json");
}

export async function readRadiusConfig(directory: string): Promise<RadiusBrainConfig | undefined> {
	let text: string;
	try {
		text = await readFile(radiusConfigPath(directory), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const value = JSON.parse(text) as Partial<RadiusBrainConfig>;
	if (typeof value.gateway !== "string" || typeof value.serverId !== "string" || value.credential?.type !== "oauth")
		throw new Error("Invalid radius.json");
	return value as RadiusBrainConfig;
}

export async function writeRadiusConfig(directory: string, config: RadiusBrainConfig): Promise<void> {
	const path = radiusConfigPath(directory);
	await writeFile(`${path}.tmp`, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
	await rename(`${path}.tmp`, path);
}

/** Gateway for new logins: `PI_RADIUS_GATEWAY`, as in the coding agent, else production. */
export function radiusGatewayFromEnv(): string {
	return normalizeRadiusGatewayUrl(process.env.PI_RADIUS_GATEWAY ?? DEFAULT_RADIUS_GATEWAY);
}

export function newServerId(): string {
	return randomUUID();
}

function radiusOAuth(gateway: string) {
	const oauth = radiusProvider({ gateway }).auth.oauth;
	if (!oauth) throw new Error("The Radius provider has no OAuth support");
	return oauth;
}

export function loginToRadius(gateway: string, onDeviceCode: (url: string, code: string) => void, signal: AbortSignal) {
	return radiusOAuth(gateway).login({
		signal,
		prompt: async () => "device-code",
		notify: (event) => {
			if (event.type === "device_code") onDeviceCode(event.verificationUri, event.userCode);
		},
	});
}

/** Maintains the brain's relay connection until closed. */
export class RadiusBrain {
	readonly #directory: string;
	readonly #port: () => number;
	readonly #relay: RelayAccess;
	readonly #forwards: Forwards | undefined;
	readonly #onStatus: (status: RadiusStatus) => void;
	readonly #channels = new Map<string, Channel>();
	#socket: WebSocket | undefined;
	/** The relay accepted `pi-server.host.v3`. */
	#flowControl = false;
	/** The relay accepted `pi-server.host.v5`: WebSocket channels get their own sockets. */
	#channelSockets = false;
	/** The configuration the host socket connected with; channel sockets authenticate with its credential. */
	#config: RadiusBrainConfig | undefined;
	#refreshing: Promise<RadiusBrainConfig> | undefined;
	#congestion: NodeJS.Timeout | undefined;
	#closed = false;
	readonly #abort = new AbortController();
	#retryMs = RETRY_INITIAL_MS;
	#retryTimer: NodeJS.Timeout | undefined;
	/** Connect with `?replace=1`; false while another brain with this server ID holds the relay. */
	#replace = true;
	#shellPage: string | undefined;
	/** The emails to report (see "Shares"), once known; `#reported` while Radius has them. */
	#shares: readonly string[] | undefined;
	#reported = false;
	/** Reports run one at a time, so an older set never lands after a newer one. */
	#reporting: Promise<void> = Promise.resolve();
	readonly #heartbeatIdleMs: number;
	readonly #heartbeatTimeoutMs: number;
	readonly #handshakeTimeoutMs: number;

	constructor(options: {
		directory: string;
		port: () => number;
		relay: RelayAccess;
		/** Port forwards; without them, forward channels answer as unknown forwards. */
		forwards?: Forwards;
		onStatus?: (status: RadiusStatus) => void;
		/** Overrides for tests. */
		timing?: { heartbeatIdleMs?: number; heartbeatTimeoutMs?: number; handshakeTimeoutMs?: number };
	}) {
		this.#directory = options.directory;
		this.#port = options.port;
		this.#relay = options.relay;
		this.#forwards = options.forwards;
		this.#onStatus = options.onStatus ?? (() => {});
		this.#heartbeatIdleMs = options.timing?.heartbeatIdleMs ?? HEARTBEAT_IDLE_MS;
		this.#heartbeatTimeoutMs = options.timing?.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
		this.#handshakeTimeoutMs = options.timing?.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
	}

	start(): void {
		void this.#connect();
	}

	/** Reports the emails sessions are shared with now if connected, else after the next connect (see "Shares"). */
	reportShares(emails: readonly string[]): void {
		this.#shares = emails;
		this.#reported = false;
		this.#report();
	}

	/** This brain's page in the Radius shell, once known (see `RadiusBrainConfig.shellPage`). */
	get shellPage(): string | undefined {
		return this.#shellPage;
	}

	close(): void {
		this.#closed = true;
		this.#abort.abort();
		clearTimeout(this.#retryTimer);
		clearInterval(this.#congestion);
		this.#socket?.close(1000);
		for (const channel of this.#channels.values()) channel.close();
		this.#channels.clear();
	}

	async #connect(): Promise<void> {
		if (this.#closed) return;
		let config: RadiusBrainConfig;
		let owner: Principal;
		try {
			if (!(await readRadiusConfig(this.#directory))) {
				this.#onStatus({ status: "signed_out" });
				this.#retryTimer = setTimeout(() => void this.#connect(), RETRY_MAX_MS);
				return;
			}
			this.#onStatus({ status: "connecting" });
			config = await this.#freshConfig();
			owner = await this.#owner(config);
			if (this.#forwards && !this.#forwards.radiusOrigin && config.publicOrigin)
				this.#forwards.radiusOrigin = config.publicOrigin;
			this.#shellPage ??= config.shellPage;
		} catch (error) {
			this.#retry(error);
			return;
		}
		if (this.#closed) return;
		this.#config = config;
		const url = new URL(`/v1/servers/${config.serverId}/connect`, config.gateway);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		if (this.#replace) url.searchParams.set("replace", "1");
		const socket = new WebSocket(url, HOST_SUBPROTOCOLS, {
			headers: { authorization: `Bearer ${config.credential.access}` },
			maxPayload: 16 * 1024 * 1024 + DATA_HEADER_BYTES,
			handshakeTimeout: this.#handshakeTimeoutMs,
		});
		socket.binaryType = "nodebuffer";
		this.#socket = socket;
		let failure: unknown;
		// Wall-clock time on purpose: after a sleep the elapsed time includes it, so a stale socket is replaced at once.
		let lastReceived = Date.now();
		let lastPing = 0;
		let heartbeat: NodeJS.Timeout | undefined;
		socket.on("open", () => {
			this.#retryMs = RETRY_INITIAL_MS;
			this.#replace = true;
			this.#flowControl = FLOW_SUBPROTOCOLS.has(socket.protocol);
			this.#channelSockets = socket.protocol === CHANNEL_HOST_SUBPROTOCOL;
			lastReceived = Date.now();
			heartbeat = setInterval(
				() => {
					const now = Date.now();
					// A backward clock step (NTP, manual change) would otherwise stop pings and the timeout until it caught up.
					if (now < Math.max(lastReceived, lastPing)) lastReceived = lastPing = now;
					if (now - lastReceived >= this.#heartbeatTimeoutMs) {
						failure ??= new Error(`no message from Radius for ${Math.round((now - lastReceived) / 1000)} s`);
						socket.terminate();
					} else if (now - Math.max(lastReceived, lastPing) >= this.#heartbeatIdleMs) {
						lastPing = now;
						socket.send(JSON.stringify({ version: PROTOCOL_VERSION, type: "ping" }));
					}
				},
				Math.max(10, Math.min(this.#heartbeatIdleMs, this.#heartbeatTimeoutMs) / 4),
			);
			this.#onStatus({ status: "connected", serverId: config.serverId, organizationId: owner.organization_id });
			this.#reported = false;
			this.#report();
		});
		// With this listener `ws` leaves a rejected handshake open; record why and abort it, which closes the socket.
		socket.on("unexpected-response", (_request, response) => {
			let body = "";
			response.on("data", (chunk: Buffer) => {
				body += chunk.toString("utf8");
			});
			response.on("end", () => {
				failure = new Error(`${response.statusCode}: ${body.slice(0, 200)}`);
				socket.terminate();
			});
		});
		socket.on("message", (data: Buffer, isBinary) => {
			lastReceived = Date.now();
			try {
				if (isBinary) this.#onData(data);
				else this.#onControl(socket, owner, JSON.parse(data.toString("utf8")) as Control);
			} catch {
				failure = new Error("Invalid Radius relay message");
				socket.terminate();
			}
		});
		socket.on("error", (error) => {
			failure ??= error;
		});
		socket.on("close", (code, reason) => {
			if (this.#socket === socket) this.#socket = undefined;
			clearInterval(heartbeat);
			clearInterval(this.#congestion);
			this.#congestion = undefined;
			for (const channel of this.#channels.values()) channel.close();
			this.#channels.clear();
			if (!failure && code === REPLACED_CODE && reason.toString("utf8") === REPLACED_REASON) {
				this.#replace = false;
				failure = new Error("another p2 with this server ID took over; waiting for it to disconnect");
			}
			this.#retry(failure ?? new Error(`relay closed (${code}${reason.length ? ` ${reason}` : ""})`));
		});
	}

	#retry(error: unknown): void {
		if (this.#closed) return;
		this.#onStatus({ status: "retrying", error: error instanceof Error ? error.message : String(error) });
		this.#retryTimer = setTimeout(() => void this.#connect(), this.#retryMs);
		this.#retryMs = Math.min(this.#retryMs * 2, RETRY_MAX_MS);
	}

	#report(): void {
		this.#reporting = this.#reporting
			.then(async () => {
				const shares = this.#shares;
				if (shares === undefined || this.#reported || this.#socket?.readyState !== WebSocket.OPEN) return;
				const config = await this.#currentConfig();
				const response = await fetch(new URL(`/v1/servers/${config.serverId}/shares`, config.gateway), {
					method: "PUT",
					headers: { authorization: `Bearer ${config.credential.access}`, "content-type": "application/json" },
					body: JSON.stringify({ emails: shares }),
					signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(30_000)]),
				});
				if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 200)}`);
				if (this.#shares === shares) this.#reported = true;
			})
			// The next change or connect reports again.
			.catch((error: unknown) => {
				if (!this.#closed)
					console.warn(`Radius: reporting shares failed (${error instanceof Error ? error.message : error})`);
			});
	}

	/** Reads radius.json again for every attempt and refreshes the access token when it is about to expire. */
	async #freshConfig(): Promise<RadiusBrainConfig> {
		const config = await readRadiusConfig(this.#directory);
		if (!config) throw new Error("Not signed in to Radius; run npm run radius:login");
		if (config.credential.expires - Date.now() > REFRESH_MARGIN_MS) return config;
		const credential = await radiusOAuth(config.gateway).refresh(
			config.credential,
			AbortSignal.any([this.#abort.signal, AbortSignal.timeout(30_000)]),
		);
		// Read again: the public origin may have been saved while the refresh ran.
		const refreshed = {
			...((await readRadiusConfig(this.#directory)) ?? config),
			credential: { ...credential, type: "oauth" as const },
		};
		await writeRadiusConfig(this.#directory, refreshed);
		return refreshed;
	}

	/** The current configuration, its credential refreshed when about to expire; one refresh at a time. */
	async #currentConfig(): Promise<RadiusBrainConfig> {
		const config = this.#config;
		if (config && config.credential.expires - Date.now() > REFRESH_MARGIN_MS) return config;
		this.#refreshing ??= this.#freshConfig().finally(() => {
			this.#refreshing = undefined;
		});
		this.#config = await this.#refreshing;
		return this.#config;
	}

	/** The principal the credential authenticates: the only principal this brain serves. */
	async #owner(config: RadiusBrainConfig): Promise<Principal> {
		const response = await fetch(new URL("/v1/context", config.gateway), {
			headers: { authorization: `Bearer ${config.credential.access}`, accept: "application/json" },
			signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(30_000)]),
		});
		if (!response.ok) throw new Error(`Radius context: ${response.status} ${(await response.text()).slice(0, 200)}`);
		const context = (await response.json()) as {
			actor: { principal_id: string; principal_kind: string };
			organization: { id: string };
		};
		return {
			kind: context.actor.principal_kind,
			id: context.actor.principal_id,
			organization_id: context.organization.id,
		};
	}

	#onControl(socket: WebSocket, owner: Principal, message: Control): void {
		if (message.type === "ping") {
			socket.send(JSON.stringify({ version: PROTOCOL_VERSION, type: "pong" }));
			return;
		}
		if (message.type === "pong") return;
		if (message.type === "connection_close") {
			this.#channels.get(message.connection_id)?.close();
			this.#channels.delete(message.connection_id);
			return;
		}
		if (message.type === "credit") {
			this.#channels.get(message.connection_id)?.credit(message.bytes);
			return;
		}
		const id = message.connection_id;
		const principal = message.principal;
		const isOwner =
			principal?.kind === owner.kind &&
			principal.id === owner.id &&
			principal.organization_id === owner.organization_id;
		// Someone a session is shared with, on the brain's UI only: sharing decides what they reach.
		const member = !isOwner && principal?.kind === "user" && !!principal.email && message.forward === undefined;
		// Only a public forward's origin connects without a principal; #openForward checks the forward is public.
		const anonymous = principal === undefined && message.forward !== undefined;
		if (
			message.kind === "stream" ||
			!(isOwner || member || anonymous) ||
			!message.request ||
			!message.public_origin
		) {
			this.#sendControl({ version: PROTOCOL_VERSION, type: "connection_close", connection_id: id, code: 1008 });
			return;
		}
		const head = message.request;
		const window = this.#flowControl ? (message.window ?? DEFAULT_HTTP_WINDOW) : Number.POSITIVE_INFINITY;
		const headers: Record<string, string> = {};
		let shellOrigin = "";
		for (const [rawName, value] of head.headers) {
			const name = rawName.toLowerCase();
			if (name === "x-radius-shell-origin") shellOrigin = value;
			if (!DROPPED_HEADERS.has(name)) headers[name] = value;
		}
		if (message.forward !== undefined) {
			this.#openForward(id, message.kind, message.forward, head, headers, message.public_origin, window, anonymous);
		} else {
			this.#remember(message.public_origin, shellOrigin, owner);
			// The brain's UI authenticates by Radius alone: no browser cookie may make a member the owner.
			delete headers.cookie;
			headers[RELAY_SECRET_HEADER] = this.#relay.secret;
			headers[RELAY_ORIGIN_HEADER] = message.public_origin;
			headers[RELAY_SHELL_HEADER] = shellOrigin;
			if (member && principal?.email)
				headers[RELAY_USER_HEADER] = encodeRelayUser({ id: principal.id, email: principal.email });
			const port = this.#port();
			const target = { host: "127.0.0.1", port };
			if (message.kind === "http") this.#openHttp(id, head, headers, window, target);
			else this.#openSocket(id, head, headers, target);
		}
		// A channel opened while congested starts paused.
		if (this.#congestion) this.#channels.get(id)?.congested(true);
	}

	/**
	 * A channel from a forward's origin, relayed to the forward's port as if the browser had opened
	 * `http://localhost:<port>`: dev servers check `Host` and `Origin` against their own address. The
	 * `X-Forwarded-*` headers tell frameworks the public address, and make this server refuse the request
	 * should a forward ever point at it.
	 */
	#openForward(
		id: string,
		kind: "ws" | "http",
		forwardId: string,
		head: RequestHead,
		headers: Record<string, string>,
		publicOrigin: string,
		window: number,
		anonymous: boolean,
	): void {
		const forward = this.#forwards?.get(forwardId);
		// An anonymous visitor learns nothing about forwards that are not public: they look unknown.
		if (!forward || forward.port === this.#port() || (anonymous && !forward.public)) {
			if (kind === "http") this.#respond(id, 404, "This port forward does not exist (any more).\n");
			else this.#sendControl({ version: PROTOCOL_VERSION, type: "connection_close", connection_id: id, code: 1008 });
			return;
		}
		const local = `localhost:${forward.port}`;
		const url = new URL(publicOrigin);
		delete headers["x-radius-shell-origin"];
		if (headers.origin === publicOrigin) headers.origin = `http://${local}`;
		headers["x-forwarded-host"] = url.host;
		headers["x-forwarded-proto"] = url.protocol.slice(0, -1);
		const prefixes = [`http://${local}`, `http://127.0.0.1:${forward.port}`];
		const target: Target = {
			host: "localhost",
			port: forward.port,
			location: (value) => {
				const prefix = prefixes.find(
					(candidate) =>
						value === candidate || value.startsWith(`${candidate}/`) || value.startsWith(`${candidate}?`),
				);
				return prefix ? `${publicOrigin}${value.slice(prefix.length)}` : value;
			},
			unavailable: `Nothing is listening on port ${forward.port} of this device.\n`,
		};
		if (kind === "http") this.#openHttp(id, head, headers, window, target);
		else this.#openSocket(id, head, headers, target);
	}

	/**
	 * Keeps the brain's Radius addresses, in memory and in radius.json: its origin for forward links, and its page in the
	 * shell that framed the request for share links.
	 */
	#remember(origin: string, shellOrigin: string, owner: Principal): void {
		const shellPage =
			SHELL_ORIGIN.test(shellOrigin) && this.#config
				? `${shellOrigin}/pi/brains/${encodeURIComponent(owner.organization_id)}/${encodeURIComponent(this.#config.serverId)}`
				: this.#shellPage;
		const newOrigin = this.#forwards !== undefined && this.#forwards.radiusOrigin !== origin;
		if (!newOrigin && shellPage === this.#shellPage) return;
		if (this.#forwards) this.#forwards.radiusOrigin = origin;
		this.#shellPage = shellPage;
		void (async () => {
			const config = await readRadiusConfig(this.#directory);
			if (config && (config.publicOrigin !== origin || config.shellPage !== shellPage))
				await writeRadiusConfig(this.#directory, {
					...config,
					publicOrigin: origin,
					...(shellPage ? { shellPage } : {}),
				});
		})().catch(() => {});
	}

	/** A short plain-text response the brain makes up itself; well within any flow-control window. */
	#respond(id: string, status: number, text: string): void {
		this.#sendControl({
			version: PROTOCOL_VERSION,
			type: "response",
			connection_id: id,
			status,
			headers: [["content-type", "text/plain; charset=utf-8"]],
		});
		this.#sendData(id, Buffer.from(text), FRAME.binary);
		this.#sendData(id, Buffer.alloc(0), FRAME.end);
	}

	#onData(frame: Buffer): void {
		if (frame.length < DATA_HEADER_BYTES || frame[0] !== PROTOCOL_VERSION) return;
		const hex = frame.subarray(2, DATA_HEADER_BYTES).toString("hex");
		const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		const type = frame[1] === FRAME.text ? "text" : frame[1] === FRAME.end ? "end" : "binary";
		this.#channels.get(id)?.data(frame.subarray(DATA_HEADER_BYTES), type);
	}

	/**
	 * Tunnels one HTTP request. `window` is how many response body bytes may be in flight before the relay returns
	 * credit (infinite without flow control). Body chunks beyond it wait here, and the loopback response is paused, so
	 * the server only produces what the browser actually reads.
	 */
	#openHttp(id: string, head: RequestHead, headers: Record<string, string>, window: number, target: Target): void {
		let available = window;
		const pending: Buffer[] = [];
		let source: IncomingMessage | undefined;
		let ended = false;
		let waitingForCredit = false;
		let congested = false;
		const pace = () => {
			if (!source) return;
			if (waitingForCredit || congested) source.pause();
			else source.resume();
		};
		const flush = () => {
			while (pending.length && available > 0) {
				let chunk = pending[0] as Buffer;
				if (chunk.length > available) {
					pending[0] = chunk.subarray(available);
					chunk = chunk.subarray(0, available);
				} else pending.shift();
				available -= chunk.length;
				for (let offset = 0; offset < chunk.length; offset += BODY_CHUNK_BYTES)
					this.#sendData(id, chunk.subarray(offset, offset + BODY_CHUNK_BYTES), FRAME.binary);
			}
			if (!pending.length && ended && this.#channels.has(id)) {
				this.#sendData(id, Buffer.alloc(0), FRAME.end);
				this.#channels.delete(id);
			}
			waitingForCredit = pending.length > 0;
			pace();
		};
		const upstream = httpRequest(
			{
				host: target.host,
				port: target.port,
				method: head.method,
				path: head.path,
				headers: { ...headers, host: `${target.host}:${target.port}` },
			},
			(response) => {
				source = response;
				const responseHeaders: [string, string][] = [];
				for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
					const [name, value] = response.rawHeaders.slice(index, index + 2);
					if (name !== undefined && value !== undefined)
						responseHeaders.push([
							name,
							target.location && name.toLowerCase() === "location" ? target.location(value) : value,
						]);
				}
				this.#sendControl({
					version: PROTOCOL_VERSION,
					type: "response",
					connection_id: id,
					status: response.statusCode ?? 502,
					headers: responseHeaders,
				});
				response.on("data", (chunk: Buffer) => {
					pending.push(chunk);
					flush();
				});
				response.on("end", () => {
					ended = true;
					flush();
				});
				pace();
			},
		);
		upstream.on("error", () => {
			if (!this.#channels.has(id)) return;
			this.#channels.delete(id);
			if (!source && target.unavailable) this.#respond(id, 502, target.unavailable);
			else this.#sendControl({ version: PROTOCOL_VERSION, type: "connection_close", connection_id: id });
		});
		const flowControl = Number.isFinite(window);
		this.#channels.set(id, {
			data: (payload, type) => {
				if (type === "end") {
					upstream.end();
					return;
				}
				// Credit the relay once the loopback request has taken the bytes, not when they arrive here.
				const bytes = payload.length;
				upstream.write(payload, () => {
					if (flowControl && this.#channels.has(id))
						this.#sendControl({ version: PROTOCOL_VERSION, type: "credit", connection_id: id, bytes });
				});
			},
			close: () => upstream.destroy(),
			credit: (bytes) => {
				available += bytes;
				flush();
			},
			congested: (paused) => {
				congested = paused;
				pace();
			},
		});
	}

	#openSocket(id: string, head: RequestHead, headers: Record<string, string>, target: Target): void {
		if (this.#channelSockets) this.#openChannelSocket(id, head, headers, target);
		else this.#openWebSocket(id, head, headers, target);
	}

	/** The loopback WebSocket of a channel, with the browser's subprotocols. */
	#loopback(head: RequestHead, headers: Record<string, string>, target: Target): WebSocket {
		const protocols = headers["sec-websocket-protocol"]?.split(",").map((protocol) => protocol.trim());
		delete headers["sec-websocket-protocol"];
		return new WebSocket(`ws://${target.host}:${target.port}${head.path}`, protocols, {
			headers,
			maxPayload: MAX_MESSAGE_BYTES,
		});
	}

	/**
	 * A WebSocket channel of a v5 relay: its own socket to Radius, piped to the loopback socket. Whichever side closes
	 * first closes the other with its code. Until the channel socket is connected the relay is still waiting for it, so
	 * a channel that ends before (its socket or the loopback failed) is refused on the host socket: the relay then fails
	 * the client's upgrade at once instead of at its timeout.
	 */
	#openChannelSocket(id: string, head: RequestHead, headers: Record<string, string>, target: Target): void {
		let ended = false;
		let paired = false;
		const sockets: WebSocket[] = [];
		const end = (code: number, reason = "", tellRelay = !paired) => {
			if (ended) return;
			ended = true;
			this.#channels.delete(id);
			if (tellRelay)
				this.#sendControl({ version: PROTOCOL_VERSION, type: "connection_close", connection_id: id, code: 1011 });
			for (const socket of sockets) socket.close(sendableCode(code), reason);
		};
		this.#channels.set(id, {
			data: () => {},
			// The relay ended the channel itself.
			close: () => end(1001, "", false),
			credit: () => {},
			congested: () => {},
		});
		void this.#currentConfig().then(
			(config) => {
				if (ended) return;
				const url = new URL(`/v1/servers/${config.serverId}/channels/${id}`, config.gateway);
				url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
				const channel = new WebSocket(url, CHANNEL_SUBPROTOCOL, {
					headers: { authorization: `Bearer ${config.credential.access}` },
					maxPayload: MAX_MESSAGE_BYTES,
					handshakeTimeout: this.#handshakeTimeoutMs,
				});
				const upstream = this.#loopback(head, headers, target);
				sockets.push(channel, upstream);
				channel.on("open", () => {
					paired = true;
				});
				channel.on("error", () => {});
				upstream.on("error", () => {});
				channel.on("close", (code, reason) => end(code, reason.toString()));
				upstream.on("close", (code, reason) => end(code, reason.toString()));
				pipe(channel, upstream);
				pipe(upstream, channel);
			},
			() => end(1011),
		);
	}

	#openWebSocket(id: string, head: RequestHead, headers: Record<string, string>, target: Target): void {
		const upstream = this.#loopback(head, headers, target);
		const queued: { payload: Buffer; text: boolean }[] = [];
		upstream.on("open", () => {
			for (const item of queued.splice(0)) upstream.send(item.text ? item.payload.toString("utf8") : item.payload);
		});
		upstream.on("message", (data: Buffer, isBinary) => {
			this.#sendData(id, data, isBinary ? FRAME.binary : FRAME.text);
		});
		const closeChannel = () => {
			if (!this.#channels.delete(id)) return;
			this.#sendControl({ version: PROTOCOL_VERSION, type: "connection_close", connection_id: id, code: 1000 });
		};
		upstream.on("close", closeChannel);
		upstream.on("error", closeChannel);
		this.#channels.set(id, {
			data: (payload, type) => {
				if (type === "end") return;
				if (upstream.readyState === WebSocket.OPEN)
					upstream.send(type === "text" ? payload.toString("utf8") : payload);
				else queued.push({ payload: Buffer.from(payload), text: type === "text" });
			},
			close: () => upstream.close(),
			credit: () => {},
			congested: (paused) => {
				// Stops reading the loopback socket; the server's own backlog checks then see a slow reader.
				if (upstream.readyState !== WebSocket.OPEN) return;
				if (paused) upstream.pause();
				else upstream.resume();
			},
		});
	}

	#sendControl(message: object): void {
		if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
	}

	#sendData(id: string, payload: Buffer, type: number): void {
		const socket = this.#socket;
		if (socket?.readyState !== WebSocket.OPEN) return;
		const frame = Buffer.alloc(DATA_HEADER_BYTES + payload.length);
		frame[0] = PROTOCOL_VERSION;
		frame[1] = type;
		Buffer.from(id.replaceAll("-", ""), "hex").copy(frame, 2);
		payload.copy(frame, DATA_HEADER_BYTES);
		socket.send(frame);
		if (!this.#congestion && socket.bufferedAmount > CONGESTION_HIGH_BYTES) this.#congested(socket);
	}

	/** Pauses every loopback source on the host socket until it has drained below CONGESTION_LOW_BYTES. */
	#congested(socket: WebSocket): void {
		for (const channel of this.#channels.values()) channel.congested(true);
		this.#congestion = setInterval(() => {
			if (this.#socket === socket && socket.bufferedAmount > CONGESTION_LOW_BYTES) return;
			clearInterval(this.#congestion);
			this.#congestion = undefined;
			for (const channel of this.#channels.values()) channel.congested(false);
		}, CONGESTION_POLL_MS);
	}
}

/**
 * Passes `from`'s messages to `to` unchanged (text stays text), holding the few that arrive before `to` is open. While
 * `to` has more than PIPE_HIGH_BYTES unsent, `from` is not read, so a backlog stays in the TCP buffers behind it
 * instead of growing here; reading resumes below PIPE_LOW_BYTES.
 */
function pipe(from: WebSocket, to: WebSocket): void {
	const waiting: { data: Buffer; binary: boolean }[] = [];
	let drain: NodeJS.Timeout | undefined;
	const send = (data: Buffer, binary: boolean) => {
		to.send(data, { binary });
		if (drain || to.bufferedAmount <= PIPE_HIGH_BYTES) return;
		from.pause();
		drain = setInterval(() => {
			if (to.readyState === WebSocket.OPEN && to.bufferedAmount > PIPE_LOW_BYTES) return;
			clearInterval(drain);
			drain = undefined;
			if (from.readyState === WebSocket.OPEN) from.resume();
		}, CONGESTION_POLL_MS);
	};
	to.on("open", () => {
		for (const item of waiting.splice(0)) send(item.data, item.binary);
	});
	from.on("message", (data: Buffer, binary) => {
		if (to.readyState === WebSocket.OPEN) send(data, binary);
		else if (to.readyState === WebSocket.CONNECTING) waiting.push({ data, binary });
	});
	const stop = () => clearInterval(drain);
	from.on("close", stop);
	to.on("close", stop);
}

/** A close code one side reported, as one the other side may send (1005 and 1006 are never sent). */
function sendableCode(code: number): number {
	if (code === 1005) return 1000;
	const valid = (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1006) || (code >= 3000 && code <= 4999);
	return valid ? code : 1011;
}
