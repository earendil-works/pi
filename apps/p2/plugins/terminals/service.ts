import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { forbidden } from "@p2/app/v1";
import { WebSocket, WebSocketServer } from "ws";
import {
	attachTerminalHost,
	connectRunningTerminalHost,
	type TerminalAttachment,
	terminalHostVersion,
} from "./detached.ts";
import {
	encodeFrame,
	type HostCall,
	type HostResult,
	MAX_BACKLOG,
	readFrames,
	type TerminalEvent,
	type TerminalInfo,
	type TerminalRequest,
} from "./protocol.ts";

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

/** What a call to a terminal host running older code fails with: it does not know the calls. */
export const OUTDATED_HOST =
	"The terminal host runs older code: restart it from the terminal panel (this ends its terminals)";

/**
 * The server's connection for calls with replies (the agent's terminal tool, archiving): one attachment, made when
 * the first call needs it and again after the host went away. Cancelling a call tells the host, which ends its wait.
 */
export class HostCalls {
	readonly #directory: string;
	readonly #app: string;
	readonly #version: string;
	#attachment: TerminalAttachment | undefined;
	/** The attached host's version, from its hello. */
	#hostVersion: string | undefined;
	#next = 1;
	readonly #pending = new Map<number, { resolve: (result: HostResult) => void; reject: (error: Error) => void }>();
	#closed = false;

	constructor(directory: string, app: string, version: string) {
		this.#directory = directory;
		this.#app = app;
		this.#version = version;
	}

	async call(call: HostCall, signal?: AbortSignal): Promise<HostResult> {
		signal?.throwIfAborted();
		if (this.#closed) throw new Error("The terminal service is closed");
		const attachment = this.#attach();
		await attachment.ready;
		if (this.#hostVersion !== this.#version) throw new Error(OUTDATED_HOST);
		const id = this.#next++;
		const reply = Promise.withResolvers<HostResult>();
		this.#pending.set(id, reply);
		const abort = () => {
			if (!this.#pending.delete(id)) return;
			try {
				attachment.write({ type: "cancel", id });
			} catch {}
			reply.reject(signal?.reason instanceof Error ? signal.reason : new Error("Cancelled"));
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			attachment.write({ type: "call", id, call });
			return await reply.promise;
		} finally {
			this.#pending.delete(id);
			signal?.removeEventListener("abort", abort);
		}
	}

	#attach(): TerminalAttachment {
		if (this.#attachment) return this.#attachment;
		const attachment = attachTerminalHost(
			this.#directory,
			this.#app,
			(frame) => this.#frame(frame),
			() => {
				if (this.#attachment !== attachment) return;
				this.#attachment = undefined;
				this.#fail(new Error("Terminal host disconnected"));
			},
		);
		this.#attachment = attachment;
		this.#hostVersion = undefined;
		return attachment;
	}

	#frame(frame: unknown): void {
		if (frame instanceof Uint8Array) return;
		const event = frame as TerminalEvent;
		if (event.type === "hello") this.#hostVersion = event.version;
		if (event.type !== "reply") return;
		const pending = this.#pending.get(event.id);
		this.#pending.delete(event.id);
		if ("error" in event) pending?.reject(new Error(event.error));
		else pending?.resolve(event.result);
	}

	#fail(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}

	close(): void {
		this.#closed = true;
		const attachment = this.#attachment;
		this.#attachment = undefined;
		attachment?.detach();
		this.#fail(new Error("The terminal service is closed"));
	}
}

export class TerminalService {
	readonly directory: string;
	/** The p2 app directory (`Server.info.app`): where the terminal host's code is. */
	readonly app: string;
	readonly #sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
	readonly #views = new Set<TerminalView>();
	readonly #tokens = new Map<string, { view: TerminalView; expires: number }>();
	#calls: Promise<HostCalls> | undefined;

	constructor(directory: string, app: string) {
		this.directory = directory;
		this.app = app;
	}

	/** One call to the terminal host (starting it when none runs); `signal` cancels it. */
	async call(call: HostCall, signal?: AbortSignal): Promise<HostResult> {
		this.#calls ??= terminalHostVersion(this.app).then((version) => new HostCalls(this.directory, this.app, version));
		return (await this.#calls).call(call, signal);
	}

	/**
	 * Closes the session's terminals; without a running host there are none, and none is started. A host running older
	 * code does not know `closeSession`: it closes them as the panel does, attaching to each and closing it.
	 */
	async closeSession(sessionId: string): Promise<void> {
		const socket = await connectRunningTerminalHost(this.directory);
		if (!socket) return;
		try {
			const events = hostEvents(socket);
			const hello = await events.next(
				(event): event is Extract<TerminalEvent, { type: "hello" }> => event.type === "hello",
			);
			if (hello.version !== (await terminalHostVersion(this.app)))
				return await closeAsViewer(socket, events, sessionId);
		} finally {
			socket.destroy();
		}
		await this.call({ op: "closeSession", sessionId });
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
		void this.#calls?.then((calls) => calls.close());
		await Promise.all([...this.#views].map((view) => this.release(view)));
		await new Promise<void>((resolve) => this.#sockets.close(() => resolve()));
	}
}

/** How long closing a session's terminals on a host running older code may take. */
const VIEWER_CLOSE_MS = 10_000;

/** A host connection's events, in order: `next` waits for the first one after the last taken that `wanted` accepts. */
type HostEvents = { next<E extends TerminalEvent>(wanted: (event: TerminalEvent) => event is E): Promise<E> };

function hostEvents(socket: Socket): HostEvents {
	const queue: TerminalEvent[] = [];
	let wake = () => {};
	let ended = false;
	readFrames(socket, (frame) => {
		if (frame instanceof Uint8Array) return;
		queue.push(frame as TerminalEvent);
		wake();
	});
	socket.once("close", () => {
		ended = true;
		wake();
	});
	return {
		async next(wanted) {
			const deadline = Date.now() + VIEWER_CLOSE_MS;
			for (;;) {
				for (let event = queue.shift(); event; event = queue.shift()) if (wanted(event)) return event;
				if (ended) throw new Error("Terminal host disconnected");
				const left = deadline - Date.now();
				if (left <= 0) throw new Error("The terminal host did not answer");
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, left);
					wake = () => {
						clearTimeout(timer);
						resolve();
					};
				});
			}
		},
	};
}

/**
 * Closes the session's terminals with the viewer protocol every host version speaks: list them, then attach to each
 * and force its close; resolves once the host reported each closed.
 */
async function closeAsViewer(socket: Socket, events: HostEvents, sessionId: string): Promise<void> {
	socket.write(encodeFrame({ type: "list", sessionId } satisfies TerminalRequest));
	const listed = await events.next(
		(event): event is Extract<TerminalEvent, { type: "list" }> => event.type === "list",
	);
	const open = new Set(listed.terminals.map((terminal) => terminal.id));
	for (const terminalId of open) {
		socket.write(encodeFrame({ type: "attach", terminalId } satisfies TerminalRequest));
		socket.write(encodeFrame({ type: "close", force: true } satisfies TerminalRequest));
	}
	while (open.size > 0) {
		const closed = await events.next(
			(event): event is Extract<TerminalEvent, { type: "closed" }> => event.type === "closed",
		);
		open.delete(closed.terminalId);
	}
}
