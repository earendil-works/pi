import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { forbidden } from "@p2/app/v1";
import { WebSocket, WebSocketServer } from "ws";
import { attachTerminalHost, type TerminalAttachment, terminalHostVersion } from "./detached.ts";
import { MAX_BACKLOG, type TerminalEvent, type TerminalInfo, type TerminalRequest } from "./protocol.ts";

/**
 * How often a viewer's socket gets `{"type":"ping"}`. An idle terminal sends nothing, so without it a dead connection
 * looks open to the viewer and idle-timeouts on the way may close it. Not part of protocol.ts: that file is hashed into
 * the terminal host's version, and the host never sees viewer pings.
 */
export const TERMINAL_PING_MS = 15_000;

/** One server attachment. Closing it never stops the host or its programs. */
export class TerminalView {
	readonly session: string;
	readonly #directory: string;
	readonly #app: string;
	/** The current attachment; a new one is made by the next `ready` after it ended. */
	#attachment: TerminalAttachment | undefined;
	readonly #version: string;
	#socket?: WebSocket;
	#queue: (TerminalEvent | Uint8Array)[] = [];
	#queued = 0;
	#list?: ReturnType<typeof Promise.withResolvers<TerminalInfo[]>>;
	#serial: Promise<unknown> = Promise.resolve();
	#closed = false;

	constructor(directory: string, app: string, session: string, version: string) {
		this.session = session;
		this.#directory = directory;
		this.#app = app;
		this.#version = version;
	}

	ready(): Promise<void> {
		if (!this.#attachment) {
			const attachment = attachTerminalHost(
				this.#directory,
				this.#app,
				(frame) => this.#frame(frame),
				() => {
					if (this.#attachment !== attachment) return;
					this.#attachment = undefined;
					this.#socket?.close(1011, "Terminal host disconnected");
				},
			);
			this.#attachment = attachment;
		}
		return this.#attachment.ready;
	}

	/** Detaches from the host (it and its programs live on). */
	#detach(): void {
		const attachment = this.#attachment;
		this.#attachment = undefined;
		attachment?.detach();
	}

	#write(message: object | Uint8Array): void {
		if (!this.#attachment) throw new Error("Terminal host is disconnected");
		this.#attachment.write(message);
	}

	#frame(frame: unknown): void {
		if (frame instanceof Uint8Array) {
			this.#forward(frame);
			return;
		}
		const event = frame as TerminalEvent;
		if (event.type === "hello") {
			if (event.version !== this.#version) this.#forward({ type: "outdated", running: event.running });
			return;
		}
		if (event.type === "list" && this.#list) {
			this.#list.resolve(event.terminals);
			this.#list = undefined;
			return;
		}
		this.#forward(event);
	}

	#forward(frame: TerminalEvent | Uint8Array): void {
		const bytes = frame instanceof Uint8Array ? frame.length : Buffer.byteLength(JSON.stringify(frame));
		if (this.#socket?.readyState === WebSocket.OPEN) {
			if (this.#socket.bufferedAmount + bytes > MAX_BACKLOG) {
				this.#socket.terminate();
				return;
			}
			this.#socket.send(frame instanceof Uint8Array ? frame : JSON.stringify(frame));
		} else {
			this.#queued += bytes;
			if (this.#queued > MAX_BACKLOG) {
				this.#detach();
				this.#queue = [];
				this.#queued = 0;
				return;
			}
			this.#queue.push(frame);
		}
	}

	bind(socket: WebSocket): void {
		this.#socket?.terminate();
		this.#socket = socket;
		for (const frame of this.#queue.splice(0)) this.#forward(frame);
		this.#queued = 0;
		// Keepalive; see TERMINAL_PING_MS.
		const ping = setInterval(() => {
			if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"ping"}');
		}, TERMINAL_PING_MS);
		ping.unref();
		socket.on("message", (data, binary) => {
			if (!binary) {
				socket.close(1003, "Terminal channel accepts bytes only");
				return;
			}
			const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
			try {
				this.#write(bytes);
			} catch {
				socket.terminate();
			}
		});
		socket.on("error", () => socket.terminate());
		socket.on("close", () => {
			clearInterval(ping);
			if (this.#socket !== socket) return;
			this.#socket = undefined;
			this.#queue = [];
			this.#queued = 0;
			this.#detach();
		});
	}

	command(request: TerminalRequest): Promise<void> {
		const run = async () => {
			if (this.#closed) throw new Error("Terminal view is closed");
			await this.ready();
			if (request.type === "attach") {
				const list = Promise.withResolvers<TerminalInfo[]>();
				this.#list = list;
				this.#write({ type: "list", sessionId: this.session });
				const timeout = setTimeout(() => list.reject(new Error("Terminal list timed out")), 10_000);
				let terminals: TerminalInfo[];
				try {
					terminals = await list.promise;
				} finally {
					clearTimeout(timeout);
					if (this.#list === list) this.#list = undefined;
				}
				if (!terminals.some((terminal) => terminal.id === request.terminalId))
					throw forbidden("This terminal does not belong to this session");
			}
			this.#write(request);
		};
		const result = this.#serial.then(run, run);
		this.#serial = result.catch(() => {});
		return result;
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#list?.reject(new Error("Terminal view closed"));
		this.#socket?.terminate();
		this.#socket = undefined;
		this.#detach();
	}
}

export class TerminalService {
	readonly directory: string;
	/** The p2 app directory (`Server.info.app`): where the terminal host's code is. */
	readonly app: string;
	readonly #sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
	readonly #views = new Set<TerminalView>();
	readonly #tokens = new Map<string, { view: TerminalView; expires: number }>();

	constructor(directory: string, app: string) {
		this.directory = directory;
		this.app = app;
	}

	async open(session: string): Promise<TerminalView> {
		const view = new TerminalView(this.directory, this.app, session, await terminalHostVersion(this.app));
		this.#views.add(view);
		try {
			await view.ready();
		} catch (error) {
			await this.release(view);
			throw error;
		}
		return view;
	}

	async channel(view: TerminalView): Promise<{ token: string }> {
		await view.ready();
		for (const [token, entry] of this.#tokens)
			if (entry.view === view || entry.expires < Date.now()) this.#tokens.delete(token);
		const token = randomBytes(24).toString("base64url");
		this.#tokens.set(token, { view, expires: Date.now() + 30_000 });
		return { token };
	}

	upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		const token = new URL(request.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
		const entry = this.#tokens.get(token);
		this.#tokens.delete(token);
		if (!entry || entry.expires < Date.now()) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		this.#sockets.handleUpgrade(request, socket, head, (ws) => entry.view.bind(ws));
	}

	async release(view: TerminalView): Promise<void> {
		this.#views.delete(view);
		for (const [token, entry] of this.#tokens) if (entry.view === view) this.#tokens.delete(token);
		await view.close();
	}

	async close(): Promise<void> {
		await Promise.all([...this.#views].map((view) => this.release(view)));
		await new Promise<void>((resolve) => this.#sockets.close(() => resolve()));
	}
}
