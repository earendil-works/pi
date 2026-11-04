import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { Connection, detectPlatform, openTerminal, type RemoteTerminal, sshConnection } from "@earendil-works/pi-env";
import { takeProcessLock } from "../../src/runtime/process-lock.ts";
import { localSystem, requireTerminalSupport, terminalDaemon } from "./daemon.ts";
import { terminalHostAddress, terminalHostVersion } from "./detached.ts";
import { envRevision, loadEnvs, sshOptions } from "./envs.ts";
import { Ghostty, type VtTerminal } from "./ghostty.ts";
import {
	encodeFrame,
	readFrames,
	TERMINAL_OUTPUT_WINDOW,
	type TerminalEvent,
	type TerminalInfo,
	type TerminalRequest,
	type TerminalTheme,
} from "./protocol.ts";

// The terminal host: owns the pi-env connections and the programs running in terminals, independent of the server and
// the session workers, so terminals survive their restarts (detached.ts). A headless libghostty terminal
// follows each one, so a browser that attaches later gets the current screen. It exits when it has had no terminals
// and no connections for a while. One per data directory. It is its own program, started by path (not a facet built by
// the plugin loader), so it and the files only it runs (daemon.ts, envs.ts, log-preload.ts) import p2's base code and
// Chord directly.

const IDLE_EXIT_MS = 10 * 60_000;
const SCROLLBACK = 10_000;
/** A client that falls this far behind is disconnected; reconnecting gets a fresh snapshot. */
const MAX_BACKLOG = 8 * 1024 * 1024;
/** The colors programs see until a viewer reports its theme: the browser's dark theme. */
const DEFAULT_THEME: TerminalTheme = { foreground: 0xe6e6e6, background: 0x141414, scheme: "dark" };

const directory = process.argv[2];
if (!directory) throw new Error("usage: main.ts <data directory>");
const log = (message: string) => console.error(`${new Date().toISOString()} ${message}`);

const addressForLock = await terminalHostAddress(directory);
try {
	await takeProcessLock(`p2:terminals:${addressForLock}`);
} catch {
	// Another host serves this data directory.
	process.exit(0);
}
const address = await terminalHostAddress(directory);
// We hold the lock: a socket file left behind is a killed host's.
if (!address.startsWith("\0") && !address.startsWith("\\\\")) await rm(address, { force: true });
const version = await terminalHostVersion(fileURLToPath(new URL("../../", import.meta.url)));
const ghostty = await Ghostty.load(await readFile(new URL("vendor/ghostty/ghostty-vt.wasm", import.meta.url)));

/**
 * Output flow control per viewer: `sent` and `acked` count output bytes (snapshots included) since it attached. A
 * viewer with more than `TERMINAL_OUTPUT_WINDOW` unacknowledged output after its latest snapshot (see `lag`) is
 * `behind`: it gets no more output, only the headless terminal follows the program. When its acknowledgements catch up
 * it gets a fresh snapshot instead of the bytes it missed, so a flood (`find /`) costs a slow viewer one screen, not the
 * whole stream, and nothing buffers without bound.
 *
 * The snapshot itself never counts against the window, as chord lets one large frame exceed its window: a screen with
 * colored scrollback can be larger than the window, and counting it would mark the viewer behind as soon as it was sent,
 * so every catch-up would send it again, forever, without any new output.
 */
type Client = {
	socket: Socket;
	attached?: Hosted;
	theme: TerminalTheme;
	sent: number;
	acked: number;
	/** `sent` right after the latest snapshot. */
	snapshotEnd: number;
	behind: boolean;
};
type Hosted = {
	info: TerminalInfo;
	vt: VtTerminal;
	pty?: RemoteTerminal;
	/** The colors of its latest viewer, which answer the program's color queries. */
	theme: TerminalTheme;
	/** Input that arrived before the program started. */
	pending: Uint8Array[];
	pendingBytes: number;
	clients: Set<Client>;
	connection: string;
};

const terminals = new Map<string, Hosted>();
const clients = new Set<Client>();
/** pi-env connections by environment ("" for this machine), with the configuration they were made for. */
const connections = new Map<string, { revision: string; connection: Promise<Connection> }>();
let idleSince = Date.now();

function send(client: Client, message: TerminalEvent | Uint8Array): void {
	if (client.socket.destroyed) return;
	if (client.socket.writableLength > MAX_BACKLOG) {
		client.socket.destroy();
		return;
	}
	client.socket.write(encodeFrame(message));
}

/** Unacknowledged output after the latest snapshot. */
function lag(client: Client): number {
	return client.sent - Math.max(client.acked, client.snapshotEnd);
}

function output(client: Client, bytes: Uint8Array): void {
	if (client.behind) return;
	send(client, bytes);
	client.sent += bytes.length;
	if (lag(client) > TERMINAL_OUTPUT_WINDOW) client.behind = true;
}

/** Replays the current screen to a viewer as on attach, which also resets its terminal. */
function resync(client: Client, hosted: Hosted): void {
	client.behind = false;
	send(client, { type: "attached", terminal: hosted.info });
	const snapshot = hosted.vt.snapshot();
	send(client, snapshot);
	client.sent += snapshot.length;
	client.snapshotEnd = client.sent;
}

function changed(hosted: Hosted): void {
	for (const client of hosted.clients) send(client, { type: "changed", terminal: hosted.info });
}

async function connection(env: string | null): Promise<{ connection: Connection; shellEnv: Record<string, string> }> {
	if (env === null) {
		let entry = connections.get("");
		if (!entry) {
			const started = (async () => {
				const { platform, arch } = localSystem();
				const binary = await terminalDaemon(platform, arch, true);
				return new Connection({ command: [binary], onLog: (text) => log(`pi-env: ${text}`) });
			})();
			entry = { revision: "", connection: started };
			connections.set("", entry);
			started.catch(() => {
				if (connections.get("") === entry) connections.delete("");
			});
		}
		return { connection: await entry.connection, shellEnv: {} };
	}
	const config = (await loadEnvs(directory))[env];
	if (!config) throw new Error(`Unknown environment ${env}`);
	const revision = envRevision(config);
	let entry = connections.get(env);
	if (!entry || entry.revision !== revision) {
		const target = sshOptions(directory, env, config);
		const started = (async () => {
			const remote = await detectPlatform(target);
			const binary = await terminalDaemon(remote.platform, remote.arch, false);
			const daemon = sshConnection({ ...target, binary, onLog: (text) => log(`pi-env ${env}: ${text}`) }).connection;
			try {
				await requireTerminalSupport(daemon);
				return daemon;
			} catch (error) {
				daemon.close();
				throw error;
			}
		})();
		entry = { revision, connection: started };
		connections.set(env, entry);
		started.catch(() => {
			if (connections.get(env) === entry) connections.delete(env);
		});
	}
	return {
		connection: await entry.connection,
		shellEnv: { ...(config.shellEnv ?? {}), ...(config.shellPath ? { SHELL: config.shellPath } : {}) },
	};
}

/** Stop a connection's daemon once none of its terminals runs. */
function release(key: string): void {
	if ([...terminals.values()].some((hosted) => hosted.connection === key && !hosted.info.exited)) return;
	const entry = connections.get(key);
	connections.delete(key);
	void entry?.connection.then((value) => value.close()).catch(() => {});
}

/** Show the terminal in a viewer's colors; programs that asked to hear about light/dark changes (mode 2031) do. */
function applyTheme(hosted: Hosted, theme: TerminalTheme): void {
	const previous = hosted.theme;
	hosted.theme = theme;
	hosted.vt.setColors(theme);
	if (previous.scheme !== theme.scheme && hosted.vt.mode(2031))
		hosted.pty?.write(new TextEncoder().encode(`\x1b[?997;${theme.scheme === "dark" ? 1 : 2}n`));
}

function attach(client: Client, hosted: Hosted): void {
	client.attached?.clients.delete(client);
	client.attached = hosted;
	hosted.clients.add(client);
	applyTheme(hosted, client.theme);
	client.sent = 0;
	client.acked = 0;
	resync(client, hosted);
}

async function open(client: Client, request: Extract<TerminalRequest, { type: "open" }>): Promise<void> {
	const id = randomBytes(6).toString("base64url");
	const info: TerminalInfo = {
		id,
		sessionId: request.sessionId,
		cwd: request.cwd,
		env: request.env,
		title: "",
		createdAt: Date.now(),
		cols: request.cols,
		rows: request.rows,
	};
	let pty: RemoteTerminal | undefined;
	let hosted: Hosted | undefined;
	const vt = ghostty.terminal({
		cols: request.cols,
		rows: request.rows,
		scrollback: SCROLLBACK,
		colors: client.theme,
		colorScheme: () => hosted?.theme.scheme,
		// Answers to queries (cursor position, device attributes) come from here, never from the browsers.
		onReply: (bytes) => {
			if (terminals.has(id)) pty?.write(bytes);
		},
	});
	hosted = {
		info,
		vt,
		theme: client.theme,
		pending: [],
		pendingBytes: 0,
		clients: new Set(),
		connection: request.env ?? "",
	};
	terminals.set(id, hosted);
	attach(client, hosted);
	const end = (exited: TerminalInfo["exited"]) => {
		if (terminals.get(id) !== hosted) return;
		info.exited = exited;
		changed(hosted);
		release(hosted.connection);
	};
	try {
		const { connection: daemon, shellEnv } = await connection(request.env);
		pty = await openTerminal(daemon, {
			cwd: request.cwd,
			// COLORFGBG: light or dark for programs that only look at the environment.
			env: {
				...shellEnv,
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
				COLORFGBG: client.theme.scheme === "dark" ? "15;0" : "0;15",
			},
			cols: request.cols,
			rows: request.rows,
			onData: (bytes) => {
				// Output racing a close: the headless terminal is already freed.
				if (!terminals.has(id)) return;
				vt.write(bytes);
				for (const viewer of hosted.clients) output(viewer, bytes);
				const title = vt.title();
				if (title !== info.title) {
					info.title = title;
					changed(hosted);
				}
			},
		});
		hosted.pty = pty;
		// Closed meanwhile: the program must not outlive its terminal.
		if (!terminals.has(id)) pty.close();
		if (info.cols !== request.cols || info.rows !== request.rows) pty.resize(info.cols, info.rows);
		for (const bytes of hosted.pending.splice(0)) pty.write(bytes);
		hosted.pendingBytes = 0;
		pty.exited.then(
			(code) => end({ code }),
			(error: unknown) => end({ error: error instanceof Error ? error.message : String(error) }),
		);
	} catch (error) {
		end({ error: error instanceof Error ? error.message : String(error) });
	}
}

function close(hosted: Hosted): void {
	terminals.delete(hosted.info.id);
	hosted.pty?.close();
	for (const client of hosted.clients) {
		send(client, { type: "closed", terminalId: hosted.info.id });
		client.attached = undefined;
	}
	hosted.clients.clear();
	hosted.vt.free();
	release(hosted.connection);
}

function handle(client: Client, message: unknown): void {
	if (message instanceof Uint8Array) {
		const hosted = client.attached;
		if (!hosted || hosted.info.exited) return;
		if (hosted.pty) hosted.pty.write(message);
		else {
			if (hosted.pendingBytes + message.length > MAX_BACKLOG) {
				client.socket.destroy();
				return;
			}
			hosted.pending.push(message);
			hosted.pendingBytes += message.length;
		}
		return;
	}
	const request = message as TerminalRequest;
	switch (request.type) {
		case "list":
			send(client, {
				type: "list",
				terminals: [...terminals.values()]
					.filter((hosted) => hosted.info.sessionId === request.sessionId)
					.map((hosted) => hosted.info),
			});
			return;
		case "open":
			void open(client, request).catch((error: unknown) =>
				send(client, { type: "error", message: error instanceof Error ? error.message : String(error) }),
			);
			return;
		case "attach": {
			const hosted = terminals.get(request.terminalId);
			if (hosted) attach(client, hosted);
			else send(client, { type: "error", message: "This terminal no longer exists" });
			return;
		}
		case "ack": {
			client.acked = Math.min(client.sent, client.acked + request.bytes);
			const hosted = client.attached;
			if (hosted && client.behind && lag(client) <= TERMINAL_OUTPUT_WINDOW / 4) resync(client, hosted);
			return;
		}
		case "theme":
			client.theme = { foreground: request.foreground, background: request.background, scheme: request.scheme };
			if (client.attached) applyTheme(client.attached, client.theme);
			return;
		case "resize": {
			const hosted = client.attached;
			if (!hosted) return;
			if (hosted.info.cols === request.cols && hosted.info.rows === request.rows) return;
			hosted.info.cols = request.cols;
			hosted.info.rows = request.rows;
			hosted.vt.resize(request.cols, request.rows);
			hosted.pty?.resize(request.cols, request.rows);
			changed(hosted);
			return;
		}
		case "close": {
			const hosted = client.attached;
			if (!hosted) return;
			if (request.force || !hosted.pty || hosted.info.exited) {
				close(hosted);
				return;
			}
			// A job in front of the shell (an editor, a build): the viewer asks before killing it. Background jobs do not
			// count. When the daemon cannot tell (it predates `ptyForeground`, or the terminal just ended), close.
			void hosted.pty
				.foreground()
				.catch(() => undefined)
				.then((job) => {
					if (terminals.get(hosted.info.id) !== hosted) return;
					if (job && !hosted.info.exited)
						send(client, {
							type: "busy",
							terminalId: hosted.info.id,
							...(job.name ? { program: job.name } : {}),
						});
					else close(hosted);
				});
			return;
		}
		case "shutdown":
			log("shutting down on request");
			for (const hosted of terminals.values()) close(hosted);
			for (const entry of connections.values()) void entry.connection.then((value) => value.close()).catch(() => {});
			// Let the daemons see their input end before this process goes.
			setTimeout(() => process.exit(0), 100);
			return;
		default:
			send(client, { type: "error", message: "Unknown request" });
	}
}

const server = createServer((socket) => {
	const client: Client = { socket, theme: DEFAULT_THEME, sent: 0, acked: 0, snapshotEnd: 0, behind: false };
	clients.add(client);
	send(client, {
		type: "hello",
		version,
		pid: process.pid,
		running: [...terminals.values()].filter((hosted) => !hosted.info.exited).length,
	});
	readFrames(socket, (message) => {
		try {
			handle(client, message);
		} catch (error) {
			send(client, { type: "error", message: error instanceof Error ? error.message : String(error) });
		}
	});
	socket.on("error", () => socket.destroy());
	socket.on("close", () => {
		clients.delete(client);
		client.attached?.clients.delete(client);
		idleSince = Date.now();
	});
});
server.listen(address, () => log(`terminal host ${process.pid} (${version}) listening`));

setInterval(() => {
	const running = [...terminals.values()].some((hosted) => !hosted.info.exited);
	if (running || clients.size > 0) idleSince = Date.now();
	else if (Date.now() - idleSince > IDLE_EXIT_MS) {
		log("idle, exiting");
		process.exit(0);
	}
}, 30_000).unref();
