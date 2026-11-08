import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { Connection, detectPlatform, openTerminal, type RemoteTerminal } from "@earendil-works/pi-env";
import { takeProcessLock } from "../../src/runtime/process-lock.ts";
import { localSystem, requireTerminalSupport, terminalDaemon } from "./daemon.ts";
import { terminalHostAddress, terminalHostVersion } from "./detached.ts";
import { connectionRevision, envConnection, loadEnvs, sandboxHost, sshOptions } from "./envs.ts";
import {
	BLINK,
	BOLD,
	type Cell,
	FAINT,
	Ghostty,
	INVERSE,
	INVISIBLE,
	ITALIC,
	STRIKETHROUGH,
	UNDERLINE,
	type VtTerminal,
} from "./ghostty.ts";
import { tmuxKey } from "./keys.ts";
import { OutputRing, plainText } from "./plain.ts";
import {
	encodeFrame,
	type HostCall,
	type HostResult,
	READ_TEXT_LIMIT,
	readFrames,
	TERMINAL_OUTPUT_WINDOW,
	type TerminalEvent,
	type TerminalInfo,
	type TerminalRead,
	type TerminalRequest,
	type TerminalTheme,
	type TerminalWait,
} from "./protocol.ts";

// The terminal host: owns the pi-env connections and the programs running in terminals, independent of the server and
// the session workers, so terminals survive their restarts (detached.ts). A headless libghostty terminal
// follows each one, so a browser that attaches later gets the current screen. It exits when it has had no terminals
// and no connections for a while. One per data directory. It is its own program, started by path (not a facet built by
// the plugin loader), so it and the files only it runs (daemon.ts, envs.ts, log-preload.ts) import p2's base code and
// Chord directly.
//
// The agent's terminal tool reaches the same terminals through calls with replies (`call`, see `HostCall`): each
// terminal keeps its last MiB of output and a read cursor for it here, so reads continue where the last one ended,
// also across server and worker restarts.

const IDLE_EXIT_MS = 10 * 60_000;
const SCROLLBACK = 10_000;
/** A client that falls this far behind is disconnected; reconnecting gets a fresh snapshot. */
const MAX_BACKLOG = 8 * 1024 * 1024;
/** The colors programs see until a viewer reports its theme: the browser's dark theme. */
const DEFAULT_THEME: TerminalTheme = { foreground: 0xe6e6e6, background: 0x141414, scheme: "dark" };
/** Output each terminal keeps for the agent's reads. */
const RING_BYTES = 1024 * 1024;
/** Running terminals the agent may have opened in one session. */
const MAX_AGENT_TERMINALS = 8;
/** Results of calls with a key the host remembers, so a repeated call (a replayed tool call) is not done twice. */
const REMEMBERED_CALLS = 1024;
/** A `match` wait tests the plain text of at most this much of the latest output. */
const MATCH_WINDOW = 64 * 1024;
/** How long without output a `quiet` wait waits by default. */
const DEFAULT_QUIET_MS = 500;
/** Lines of scrollback `capture` returns at most. */
const MAX_CAPTURE_SCROLLBACK = 5000;

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
/** The envs plugin's sandbox launcher (this host is a separate program, not a facet: no `pluginFile`). */
const sandboxLauncher = fileURLToPath(new URL("../envs/sandbox/", import.meta.url));
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
	/** The session it listed last: it hears about that session's terminals changing (`terminals`). */
	session?: string;
	/** Cancels of its calls still running, by call id. */
	calls: Map<number, () => void>;
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
	/** The last MiB of output, for the agent's reads. */
	ring: OutputRing;
	/** Where the agent's next read starts (an offset into `ring`). */
	cursor: number;
	/** Waits for output, called on each output, the exit and the close. */
	waiters: Set<() => void>;
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
	listed(hosted.info.sessionId);
}

/** The session's terminals, oldest first. */
function sessionTerminals(sessionId: string): Hosted[] {
	return [...terminals.values()].filter((hosted) => hosted.info.sessionId === sessionId);
}

/** Tells every connection that listed the session (its viewers) its terminals now. */
function listed(sessionId: string): void {
	const list = sessionTerminals(sessionId).map((hosted) => hosted.info);
	for (const client of clients) if (client.session === sessionId) send(client, { type: "terminals", terminals: list });
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
	const configs = await loadEnvs(directory);
	const config = configs[env];
	if (!config) throw new Error(`Unknown environment ${env}`);
	const revision = connectionRevision(configs, config);
	let entry = connections.get(env);
	if (!entry || entry.revision !== revision) {
		const started = (async () => {
			// A sandbox runs its host's daemon in its VM (both Linux on the host's architecture).
			const target =
				config.type === "ssh" ? sshOptions(directory, env, config) : await sandboxHost(directory, env, config.host);
			const remote = await detectPlatform(target);
			const binary = await terminalDaemon(remote.platform, remote.arch, false);
			const daemon = envConnection(directory, env, config, {
				launcher: sandboxLauncher,
				binary,
				onLog: (text) => log(`pi-env ${env}: ${text}`),
			}).connection;
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
		shellEnv:
			config.type === "ssh"
				? { ...(config.shellEnv ?? {}), ...(config.shellPath ? { SHELL: config.shellPath } : {}) }
				: {},
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

type Opening = {
	sessionId: string;
	cwd: string;
	env: string | null;
	cols: number;
	rows: number;
	name?: string;
	agent?: true;
};

/** A new terminal, listed at once; `started` settles once its program started or failed to. */
function create(request: Opening, theme: TerminalTheme): { hosted: Hosted; started: Promise<void> } {
	const id = randomBytes(6).toString("base64url");
	const taken = new Set(sessionTerminals(request.sessionId).map((each) => each.info.index));
	let index = 1;
	while (taken.has(index)) index++;
	const info: TerminalInfo = {
		id,
		sessionId: request.sessionId,
		index,
		...(request.name ? { name: request.name } : {}),
		...(request.agent ? { agent: true as const } : {}),
		cwd: request.cwd,
		env: request.env,
		title: "",
		createdAt: Date.now(),
		cols: request.cols,
		rows: request.rows,
	};
	let pty: RemoteTerminal | undefined;
	const vt = ghostty.terminal({
		cols: request.cols,
		rows: request.rows,
		scrollback: SCROLLBACK,
		colors: theme,
		colorScheme: () => hosted.theme.scheme,
		// Answers to queries (cursor position, device attributes) come from here, never from the browsers.
		onReply: (bytes) => {
			if (terminals.has(id)) pty?.write(bytes);
		},
	});
	const hosted: Hosted = {
		info,
		vt,
		theme,
		pending: [],
		pendingBytes: 0,
		clients: new Set(),
		connection: request.env ?? "",
		ring: new OutputRing(RING_BYTES),
		cursor: 0,
		waiters: new Set(),
	};
	terminals.set(id, hosted);
	listed(request.sessionId);
	const end = (exited: TerminalInfo["exited"]) => {
		if (terminals.get(id) !== hosted) return;
		info.exited = exited;
		changed(hosted);
		poke(hosted);
		release(hosted.connection);
	};
	const started = (async () => {
		try {
			const { connection: daemon, shellEnv } = await connection(request.env);
			pty = await openTerminal(daemon, {
				cwd: request.cwd,
				// COLORFGBG: light or dark for programs that only look at the environment.
				env: {
					...shellEnv,
					TERM: "xterm-256color",
					COLORTERM: "truecolor",
					COLORFGBG: theme.scheme === "dark" ? "15;0" : "0;15",
				},
				cols: request.cols,
				rows: request.rows,
				onData: (bytes) => {
					// Output racing a close: the headless terminal is already freed.
					if (!terminals.has(id)) return;
					vt.write(bytes);
					hosted.ring.append(bytes);
					for (const viewer of hosted.clients) output(viewer, bytes);
					const title = vt.title();
					if (title !== info.title) {
						info.title = title;
						changed(hosted);
					}
					poke(hosted);
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
	})();
	return { hosted, started };
}

/** Wakes the terminal's waits. */
function poke(hosted: Hosted): void {
	for (const waiter of hosted.waiters) waiter();
}

/** Input for the program; held until it started. False when too much is held already. */
function input(hosted: Hosted, bytes: Uint8Array): boolean {
	if (hosted.pty) {
		hosted.pty.write(bytes);
		return true;
	}
	if (hosted.pendingBytes + bytes.length > MAX_BACKLOG) return false;
	hosted.pending.push(bytes);
	hosted.pendingBytes += bytes.length;
	return true;
}

function close(hosted: Hosted): void {
	if (terminals.get(hosted.info.id) !== hosted) return;
	terminals.delete(hosted.info.id);
	hosted.pty?.close();
	for (const client of hosted.clients) {
		send(client, { type: "closed", terminalId: hosted.info.id });
		client.attached = undefined;
	}
	hosted.clients.clear();
	hosted.vt.free();
	release(hosted.connection);
	poke(hosted);
	listed(hosted.info.sessionId);
}

function handle(client: Client, message: unknown): void {
	if (message instanceof Uint8Array) {
		const hosted = client.attached;
		if (!hosted || hosted.info.exited) return;
		if (!input(hosted, message)) client.socket.destroy();
		return;
	}
	const request = message as TerminalRequest;
	switch (request.type) {
		case "list":
			client.session = request.sessionId;
			send(client, { type: "list", terminals: sessionTerminals(request.sessionId).map((hosted) => hosted.info) });
			return;
		case "open":
			attach(client, create(request, client.theme).hosted);
			return;
		case "call":
			call(client, request.id, request.call);
			return;
		case "cancel":
			client.calls.get(request.id)?.();
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

/** Results of calls with a key, by session, operation and key; the oldest go first. */
const remembered = new Map<string, Promise<HostResult>>();

/** Runs a call and replies; the caller may cancel it while it waits. */
function call(client: Client, id: number, request: HostCall): void {
	const cancelled = Promise.withResolvers<never>();
	cancelled.promise.catch(() => {});
	client.calls.set(id, () => cancelled.reject(new Error("cancelled")));
	const result = "key" in request ? once(request) : perform(request, cancelled.promise);
	Promise.race([result, cancelled.promise])
		.then(
			(value) => send(client, { type: "reply", id, result: value }),
			(error: unknown) =>
				send(client, { type: "reply", id, error: error instanceof Error ? error.message : String(error) }),
		)
		.finally(() => client.calls.delete(id));
}

/** A call with a key, done once: a call with a key the host has seen gets the first one's result. */
function once(request: Extract<HostCall, { key: string }>): Promise<HostResult> {
	const key = JSON.stringify([request.sessionId, request.op, request.key]);
	const known = remembered.get(key);
	if (known) return known;
	// Calls with a key never wait, so nothing cancels them.
	const first = perform(request, new Promise<never>(() => {}));
	remembered.set(key, first);
	// A failed call may be tried again.
	first.catch(() => {
		if (remembered.get(key) === first) remembered.delete(key);
	});
	for (const old of remembered.keys()) {
		if (remembered.size <= REMEMBERED_CALLS) break;
		remembered.delete(old);
	}
	return first;
}

/** One call; `cancelled` rejects when the caller gives up (a wait then ends). */
async function perform(request: HostCall, cancelled: Promise<never>): Promise<HostResult> {
	switch (request.op) {
		case "list":
			return {
				kind: "list",
				windows: await Promise.all(
					sessionTerminals(request.sessionId).map(async (hosted) => {
						const job = await foreground(hosted);
						return { terminal: hosted.info, ...(job ? { foreground: job } : {}) };
					}),
				),
			};
		case "open":
			return { kind: "terminal", terminal: await openForAgent(request) };
		case "send": {
			const hosted = target(request.sessionId, request.target);
			if (hosted.info.exited) throw new Error(`window ${hosted.info.index} has exited`);
			const parts: Uint8Array[] = [];
			for (const key of request.keys) {
				const press = request.literal ? undefined : tmuxKey(key);
				const bytes = press ? hosted.vt.encodeKey(press) : new TextEncoder().encode(key);
				if (!bytes) throw new Error(`unknown key: ${key}`);
				parts.push(bytes);
			}
			if (!input(hosted, Buffer.concat(parts))) throw new Error("too much input before the program started");
			return { kind: "terminal", terminal: hosted.info };
		}
		case "cursor": {
			const hosted = target(request.sessionId, request.target);
			return { kind: "cursor", terminal: hosted.info, offset: hosted.cursor };
		}
		case "read":
			return { kind: "read", ...(await read(request, cancelled)) };
		case "capture": {
			const hosted = target(request.sessionId, request.target);
			return {
				kind: "capture",
				terminal: hosted.info,
				text: capture(hosted.vt, request.scrollback, request.escapes === true),
			};
		}
		case "close": {
			const hosted = target(request.sessionId, request.target);
			close(hosted);
			return { kind: "closed", terminalId: hosted.info.id };
		}
		case "closeSession":
			for (const hosted of sessionTerminals(request.sessionId)) close(hosted);
			return { kind: "done" };
	}
}

/** The session's terminal `name`: its id, its number (`2` or tmux's `:2`), or its name. */
function target(sessionId: string, name: string): Hosted {
	const own = sessionTerminals(sessionId);
	const bare = name.startsWith(":") ? name.slice(1) : name;
	const found =
		own.find((hosted) => hosted.info.id === name) ??
		own.find((hosted) => String(hosted.info.index) === bare) ??
		own.find((hosted) => hosted.info.name === bare);
	if (!found) throw new Error(`can't find window: ${name}`);
	return found;
}

/** A terminal the agent opens; its program has started when this returns, or it is gone with the error. */
async function openForAgent(request: Extract<HostCall, { op: "open" }>): Promise<TerminalInfo> {
	const running = sessionTerminals(request.sessionId).filter((hosted) => hosted.info.agent && !hosted.info.exited);
	if (running.length >= MAX_AGENT_TERMINALS)
		throw new Error(
			`the agent has ${MAX_AGENT_TERMINALS} terminals running in this session already: close one with kill-window`,
		);
	const { hosted, started } = create(
		{
			sessionId: request.sessionId,
			cwd: request.cwd,
			env: request.env,
			cols: request.cols,
			rows: request.rows,
			agent: true,
			...(request.name ? { name: request.name } : {}),
		},
		DEFAULT_THEME,
	);
	// The shell reads it once it is ready, as typed ahead.
	if (request.command) input(hosted, new TextEncoder().encode(`${request.command}\r`));
	await started;
	const failed = hosted.info.exited?.error;
	if (failed) {
		close(hosted);
		throw new Error(failed);
	}
	return hosted.info;
}

/** Output since `from` (default: the read cursor) as plain text, after the wait; moves the read cursor past it. */
async function read(request: Extract<HostCall, { op: "read" }>, cancelled: Promise<never>): Promise<TerminalRead> {
	const hosted = target(request.sessionId, request.target);
	const from = request.from ?? hosted.cursor;
	const waited = request.wait ? await Promise.race([waitFor(hosted, from, request.wait), cancelled]) : undefined;
	const { bytes, skipped } = hosted.ring.since(from);
	const to = hosted.ring.end;
	hosted.cursor = Math.max(hosted.cursor, to);
	const plain = plainText(new TextDecoder().decode(bytes));
	const truncated = Math.max(0, plain.length - READ_TEXT_LIMIT);
	const open = terminals.get(hosted.info.id) === hosted;
	const screen = open && hosted.vt.alternateScreen() ? capture(hosted.vt, 0, false) : undefined;
	const job = await foreground(hosted);
	return {
		terminal: hosted.info,
		from,
		to,
		text: truncated ? plain.slice(truncated) : plain,
		skipped,
		truncated,
		...(screen === undefined ? {} : { screen }),
		...(waited ? { waited } : {}),
		...(job ? { foreground: job } : {}),
	};
}

/** The name of the job in front of the terminal's shell, while one runs. */
async function foreground(hosted: Hosted): Promise<string | undefined> {
	if (terminals.get(hosted.info.id) !== hosted || !hosted.pty || hosted.info.exited) return undefined;
	const job = await hosted.pty.foreground().catch(() => undefined);
	return job ? (job.name ?? `process ${job.pid}`) : undefined;
}

/**
 * Waits for the terminal: until its output is quiet, matches, or it exits, whichever was asked, or the timeout. It
 * also ends when the program exits or the terminal closes.
 */
function waitFor(hosted: Hosted, from: number, wait: TerminalWait): Promise<NonNullable<TerminalRead["waited"]>> {
	// A bad pattern fails the read before it waits.
	const pattern = wait.until === "match" ? new RegExp(wait.pattern ?? "", wait.ignoreCase ? "mi" : "m") : undefined;
	return new Promise((resolve) => {
		let quiet: ReturnType<typeof setTimeout> | undefined;
		let check: ReturnType<typeof setTimeout> | undefined;
		const matches = () => {
			const { bytes } = hosted.ring.since(Math.max(from, hosted.ring.end - MATCH_WINDOW));
			return pattern?.test(plainText(new TextDecoder().decode(bytes))) === true;
		};
		const finish = (why: NonNullable<TerminalRead["waited"]>) => {
			clearTimeout(timeout);
			clearTimeout(quiet);
			clearTimeout(check);
			hosted.waiters.delete(waiter);
			resolve(why);
		};
		const waiter = () => {
			if (terminals.get(hosted.info.id) !== hosted) finish(pattern && matches() ? "match" : "closed");
			else if (hosted.info.exited) finish(pattern && matches() ? "match" : "exit");
			else if (wait.until === "quiet") {
				clearTimeout(quiet);
				quiet = setTimeout(() => finish("quiet"), wait.quietMs ?? DEFAULT_QUIET_MS);
			} else if (pattern && check === undefined)
				// Output comes in many small chunks: test once they settled a little.
				check = setTimeout(() => {
					check = undefined;
					if (matches()) finish("match");
				}, 50);
		};
		const timeout = setTimeout(() => finish("timeout"), wait.timeoutMs);
		hosted.waiters.add(waiter);
		if (pattern && matches()) finish("match");
		else waiter();
	});
}

/**
 * The screen as plain text, with up to `scrollback` lines before it; trailing blank lines left out. `escapes` keeps
 * colors and attributes as SGR sequences (tmux's `capture-pane -e`).
 */
function capture(vt: VtTerminal, scrollback: number, escapes: boolean): string {
	const { total, length } = vt.scrollbar();
	const first = Math.max(0, total - length - Math.min(scrollback, MAX_CAPTURE_SCROLLBACK));
	const lines: string[] = [];
	// The viewport shows `length` rows at a time: page from `first` to the bottom, then scroll back down.
	vt.scroll("bottom");
	vt.scroll(first - (total - length));
	let next = first;
	for (;;) {
		const shown = vt.scrollbar();
		const rows = vt.frame(true).changed.map((row) => (escapes ? styledRow(row.cells) : plainRow(row.cells)));
		lines.push(...rows.slice(next - shown.offset));
		next = shown.offset + rows.length;
		if (shown.offset + shown.length >= shown.total) break;
		vt.scroll(shown.length);
	}
	vt.scroll("bottom");
	while (lines.length > 0 && plainText(lines.at(-1) as string) === "") lines.pop();
	return lines.join("\n");
}

function plainRow(cells: readonly Cell[]): string {
	return cells
		.filter((cell) => cell.width !== 0)
		.map((cell) => cell.text || " ")
		.join("")
		.replace(/\s+$/, "");
}

/** SGR parameters of cell flags, in `Cell.flags` bit order. */
const SGR_FLAGS: [number, number][] = [
	[BOLD, 1],
	[FAINT, 2],
	[ITALIC, 3],
	[UNDERLINE, 4],
	[BLINK, 5],
	[INVERSE, 7],
	[INVISIBLE, 8],
	[STRIKETHROUGH, 9],
];

/** A row with its colors and attributes as SGR sequences, reset at its end. */
function styledRow(cells: readonly Cell[]): string {
	const color = (base: number, value: number) =>
		value < 0 ? [] : [base, 2, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	let row = "";
	let style = "0";
	for (const cell of cells) {
		if (cell.width === 0) continue;
		const params = [
			0,
			...SGR_FLAGS.filter(([flag]) => cell.flags & flag).map(([, sgr]) => sgr),
			...color(38, cell.fg),
			...color(48, cell.bg),
		].join(";");
		if (params !== style) {
			row += `\x1b[${params}m`;
			style = params;
		}
		row += cell.text || " ";
	}
	// Unstyled trailing blanks carry nothing.
	const trimmed = style === "0" ? row.replace(/ +$/, "") : row;
	return `${trimmed}${style === "0" ? "" : "\x1b[0m"}`;
}

const server = createServer((socket) => {
	const client: Client = {
		socket,
		theme: DEFAULT_THEME,
		sent: 0,
		acked: 0,
		snapshotEnd: 0,
		behind: false,
		calls: new Map(),
	};
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
		for (const cancel of client.calls.values()) cancel();
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
