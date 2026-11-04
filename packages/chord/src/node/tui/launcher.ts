// `startTerminal` (slice 11 §4, decision "Slice 11, P8"): the trusted launcher of a terminal client. It signs in with
// its token (given, from a file, or by pairing), downloads the terminal kind's base bundle and plugin scripts, and
// runs them in the sandbox, always. It keeps the credentials, the real terminal and the user's choices: the sandbox
// gets input and resizes, its frames pass the output filter, its Chord link is a socket the launcher opens and relays,
// its plugin script fetches go only to the terminal surface's files, and its actions on the machine (copy, open a URL,
// attach a file) are confirmed by the launcher's own prompt. A new base bundle on the server starts a new sandbox.
// Nothing the sandbox sends can end the launcher (fix round 2, Opus E3): its messages are checked (`pipe.ts`), a send
// on a socket not yet open is dropped, every buffer and the requests in flight are bounded, a signal cannot open the
// launcher's inspector, and however the launcher's process ends the terminal is given back (fix round 3, Opus E8,
// E10, E11). During a prompt Ctrl-C ends the client: its keys are the launcher's; and three Ctrl-C within a second
// always end it (Opus R2).

import type { Readable, Writable } from "node:stream";
import { WebSocket } from "ws";
import type { ColorDepth } from "../../surfaces/index.ts";
import type { BridgeRequest, SandboxMessage } from "../../tui/bridge.ts";
import type { TuiStart } from "../surfaces/tui.ts";
import { act, attach, type PromptTerminal, promptLines } from "./actions.ts";
import { type TerminalCredentials, tokenOf } from "./credentials.ts";
import { filterOutput } from "./filter.ts";
import { MAX_BUNDLE, requireSandboxNode, Sandbox } from "./sandbox.ts";

/** What `startTerminal` takes. */
export type TerminalOptions = {
	/** The app's server (`http://127.0.0.1:8788`). */
	readonly url: string;
	readonly credentials: TerminalCredentials;
	/** The terminal's input and output: the process's by default (raw mode while running, when a TTY). */
	readonly input?: Readable & { setRawMode?(raw: boolean): unknown; readonly isTTY?: boolean };
	readonly output?: Writable & { readonly columns?: number; readonly rows?: number };
	/** How many colours the terminal shows: true colour when `COLORTERM` says so, else 256. */
	readonly colors?: ColorDepth;
	/** The terminal's background, choosing between the user's dark and light theme: dark by default. */
	readonly mode?: "dark" | "light";
	/** The user's languages, most preferred first, until they choose one: the system's locale by default. */
	readonly locales?: readonly string[];
	/** Opens a URL the user confirmed: the platform's opener by default. */
	readonly opener?: (url: string) => Promise<void>;
};

/** A running terminal client: its exit code once it ends, and its stop. */
export type RunningTerminal = { readonly exited: Promise<number>; stop(): Promise<void> };

/** The terminal surface's files (the server's `TUI_PREFIX`). */
const PREFIX = "/_chord/tui/";

/**
 * `path` resolved on the server `server` when it names one of the terminal surface's files (dot segments and encodings
 * resolved first: Opus M2, Fable L1); throws otherwise: the sandbox reaches nothing else of the server through the
 * launcher's token.
 */
export function terminalFile(path: unknown, server: URL): string {
	const target = typeof path === "string" ? new URL(path, server) : undefined;
	if (
		target === undefined ||
		target.origin !== server.origin ||
		target.search !== "" ||
		!TERMINAL_FILE.test(target.pathname)
	) {
		throw new Error("terminal: no terminal file");
	}
	return target.pathname;
}

/** A terminal surface file's path, as the sandbox may ask for it. */
const TERMINAL_FILE = /^\/_chord\/tui\/(?:plugin\/)?[\w.~@-]+$/;

/** The most frames held while a prompt is open: 1 MiB (characters); later ones are dropped. */
const MAX_HELD = 1024 * 1024;

/** The most link sockets the sandbox may have open at once. */
const MAX_SOCKETS = 4;

/** The most bytes a link socket may have waiting to go out; a sandbox sending more loses the socket. */
const MAX_SOCKET_BUFFER = 16 * 1024 * 1024;

/** How long after a prompt appears its keys are ignored: a key typed for the sandbox does not answer it (Opus E4). */
const PROMPT_GUARD_MS = 300;

/**
 * The terminal modes the sandbox may have set, back to the shell's: sync, mouse, focus, paste, cursor, the scroll region
 * (the cursor kept where it was) and autowrap (Opus E11), screen, colours.
 */
const RESET_MODES =
	"\x1b[?2026l\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?25h\x1b7\x1b[r\x1b8\x1b[?7h\x1b[?1049l\x1b[0m";

/** The most requests of one sandbox the launcher answers at once; more are refused at once (Opus E10). */
const MAX_REQUESTS = 8;

/**
 * Ctrl-C: during a prompt it ends the client, so a sandbox asking again and again can always be left (Opus E11); and
 * three within a second always end it, whatever the sandbox does with them (Opus R2).
 */
const INTERRUPT = "\x03";

/** How many Ctrl-C within `INTERRUPT_WINDOW_MS` end the client however the sandbox takes them. */
const INTERRUPTS_TO_END = 3;
const INTERRUPT_WINDOW_MS = 1000;

/** Starts a terminal client; rejects when it cannot sign in or download, or Node is too old for the sandbox. */
export async function startTerminal(options: TerminalOptions): Promise<RunningTerminal> {
	requireSandboxNode();
	const output = options.output ?? process.stdout;
	const url = new URL(options.url);
	const abort = new AbortController();
	// What the launcher prints of the server's (the pairing's code) passes the output filter too.
	const token = await tokenOf(
		options.credentials,
		url,
		(line) => output.write(`${filterOutput(line)}\r\n`),
		abort.signal,
	);
	const launcher = new Launcher(url, token, options);
	await launcher.start();
	return { exited: launcher.exited, stop: () => launcher.finish(0) };
}

/** One terminal client's launcher. */
class Launcher {
	readonly #url: URL;
	readonly #headers: Readonly<Record<string, string>>;
	readonly #options: TerminalOptions;
	readonly #input: NonNullable<TerminalOptions["input"]>;
	readonly #output: NonNullable<TerminalOptions["output"]>;
	readonly #sockets = new Map<number, WebSocket>();
	#sandbox: Sandbox | undefined;
	/** The running base bundle's hash: an `outdated` sandbox restarts only for another. */
	#base = "";
	/**
	 * Whether an action is being confirmed (one at a time), from its request to its end: meanwhile the sandbox's frames
	 * are held (`#held`, at most `MAX_HELD` bytes), so nothing draws over the prompt, even before it appears.
	 */
	#confirming = false;
	/** The running sandbox's requests being answered (at most `MAX_REQUESTS`). */
	#requests = 0;
	/** The prompt open: its lines, its answer, and when its keys start to count. Keys go to it, not the sandbox. */
	#prompt:
		| { readonly lines: readonly string[]; readonly answer: (yes: boolean) => void; readonly ready: number }
		| undefined;
	#held: string[] = [];
	#heldBytes = 0;
	#finished = false;
	#exit!: (code: number) => void;
	readonly exited = new Promise<number>((resolve) => {
		this.#exit = resolve;
	});
	readonly #onInput = (data: Buffer | string): void => {
		const text = data.toString();
		if (this.#interrupted(text)) {
			void this.finish(130);
			return;
		}
		if (this.#prompt === undefined) this.#sandbox?.post({ kind: "input", data: text });
		else if (text.includes(INTERRUPT)) void this.finish(130);
		else if (Date.now() >= this.#prompt.ready) this.#answered(text === "y" || text === "Y");
	};
	readonly #onResize = (): void => {
		if (this.#prompt !== undefined) this.#drawPrompt();
		this.#sandbox?.post({ kind: "resize", columns: this.#columns, rows: this.#rows });
	};
	/** When the last Ctrl-C keys came: three within a second end the client. */
	#interrupts: number[] = [];
	/** The terminal given back if the launcher's process ends without `finish` (a crash). */
	readonly #onExit = (): void => {
		this.#output.write(RESET_MODES);
		if (this.#input.isTTY === true) this.#input.setRawMode?.(false);
	};

	constructor(url: URL, token: string, options: TerminalOptions) {
		this.#url = url;
		this.#headers = { authorization: `Bearer ${token}` };
		this.#options = options;
		this.#input = options.input ?? process.stdin;
		this.#output = options.output ?? process.stdout;
	}

	/** Whether `text` brings the third Ctrl-C within a second (each still goes to the sandbox otherwise). */
	#interrupted(text: string): boolean {
		const now = Date.now();
		for (const character of text) if (character === INTERRUPT) this.#interrupts.push(now);
		this.#interrupts = this.#interrupts.filter((at) => now - at < INTERRUPT_WINDOW_MS);
		return this.#interrupts.length >= INTERRUPTS_TO_END;
	}

	// A pseudo-terminal may report 0 (Opus E4).
	get #columns(): number {
		return this.#output.columns || 80;
	}

	get #rows(): number {
		return this.#output.rows || 24;
	}

	/** Downloads the base bundle and the plugins, starts the sandbox and takes the terminal. */
	async start(): Promise<void> {
		await this.#startSandbox();
		if (this.#input.isTTY === true) this.#input.setRawMode?.(true);
		this.#input.on("data", this.#onInput);
		this.#output.on("resize", this.#onResize);
		process.once("exit", this.#onExit);
		// Node opens its inspector on SIGUSR1 unless the signal has a listener: a sandbox may signal its launcher, and
		// an inspector would give any local process the launcher's token and files (Opus E8). Windows has no SIGUSR1.
		if (process.platform !== "win32") process.on("SIGUSR1", ignoreSignal);
	}

	/** Ends the client with `code`: the terminal given back, the sockets closed, the sandbox ended. */
	async finish(code: number): Promise<void> {
		if (this.#finished) return;
		this.#finished = true;
		this.#input.off("data", this.#onInput);
		this.#output.off("resize", this.#onResize);
		process.off("exit", this.#onExit);
		if (process.platform !== "win32") process.off("SIGUSR1", ignoreSignal);
		if (this.#input.isTTY === true) this.#input.setRawMode?.(false);
		this.#prompt?.answer(false);
		this.#prompt = undefined;
		this.#output.write(RESET_MODES);
		this.#closeSockets();
		await this.#sandbox?.terminate();
		this.#exit(code);
	}

	/** A new sandbox with what the server serves now. */
	async #startSandbox(): Promise<void> {
		const start = JSON.parse(await this.#get(`${PREFIX}start`)) as TuiStart;
		const [source, combined] = await Promise.all([this.#get(start.script), this.#get(start.combined)]);
		this.#base = start.base;
		const colors =
			this.#options.colors ?? (/truecolor|24bit/.test(process.env.COLORTERM ?? "") ? "truecolor" : "256");
		const bridge = {
			base: start.base,
			combined,
			columns: this.#columns,
			rows: this.#rows,
			colors,
			mode: this.#options.mode ?? "dark",
			locales: this.#options.locales ?? systemLocales(),
		} as const;
		this.#requests = 0;
		this.#sandbox = await Sandbox.start(
			source,
			bridge,
			(message) => this.#message(message),
			() => void this.finish(1),
		);
	}

	/** One message of the sandbox; one the launcher fails on ends the client, never the launcher's process. */
	#message(message: SandboxMessage): void {
		try {
			this.#handle(message);
		} catch {
			void this.finish(1);
		}
	}

	#handle(message: SandboxMessage): void {
		switch (message.kind) {
			case "write":
				this.#write(message.data);
				return;
			case "socket_open":
				this.#openSocket(message.socket);
				return;
			case "socket_send":
				this.#send(message.socket, message.bytes);
				return;
			case "socket_close":
				this.#sockets.get(message.socket)?.close();
				return;
			case "request":
				void this.#answer(message.id, message.request);
				return;
			case "outdated":
				void this.#outdated();
				return;
			case "failed":
				this.#output.write("terminal: the terminal client failed to start\n");
				void this.finish(1);
				return;
			case "exit":
				void this.finish(message.code);
		}
	}

	/** Writes the sandbox's frame through the output filter (held while a prompt is open); one over 64 KiB is dropped. */
	#write(data: string): void {
		if (this.#confirming) {
			if (typeof data === "string" && this.#heldBytes + data.length <= MAX_HELD) {
				this.#held.push(data);
				this.#heldBytes += data.length;
			}
			return;
		}
		try {
			this.#output.write(filterOutput(data));
		} catch {
			// Over 64 KiB (or no text): dropped, as an escape it could hide would be.
		}
	}

	/** Opens socket `socket` to the links endpoint with the launcher's token, relaying it to the sandbox. */
	#openSocket(socket: number): void {
		// A few at a time: the connection loop needs one; a runaway sandbox gets no more.
		if (this.#sockets.size >= MAX_SOCKETS) {
			this.#sandbox?.post({ kind: "socket_closed", socket });
			return;
		}
		const target = new URL("/chord", this.#url);
		target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(target, { headers: this.#headers });
		this.#sockets.set(socket, ws);
		ws.on("open", () => this.#sandbox?.post({ kind: "socket_opened", socket }));
		ws.on("message", (data: Buffer) => {
			this.#sandbox?.post({ kind: "socket_message", socket, bytes: new Uint8Array(data) });
		});
		const closed = (): void => {
			if (this.#sockets.get(socket) !== ws) return;
			this.#sockets.delete(socket);
			this.#sandbox?.post({ kind: "socket_closed", socket });
		};
		ws.on("close", closed);
		ws.on("error", closed);
	}

	/**
	 * Sends `bytes` on socket `socket` once it is open (before, the sandbox's link holds its messages; a send then is
	 * dropped: Opus E3); a socket with more than 16 MiB waiting is closed.
	 */
	#send(socket: number, bytes: Uint8Array): void {
		const ws = this.#sockets.get(socket);
		if (ws?.readyState !== WebSocket.OPEN) return;
		if (ws.bufferedAmount + bytes.length > MAX_SOCKET_BUFFER) ws.terminate();
		else ws.send(bytes);
	}

	/** Answers the sandbox's request `id`. */
	async #answer(id: number, request: BridgeRequest): Promise<void> {
		// The sandbox that asked: a reply never goes to the one a restart started meanwhile.
		const sandbox = this.#sandbox;
		if (sandbox === undefined) return;
		if (this.#requests >= MAX_REQUESTS) {
			sandbox.post({ kind: "refused", id, message: "terminal: too many requests at once" });
			return;
		}
		this.#requests++;
		try {
			let value: unknown;
			if (request.kind === "fetch") value = await this.#get(terminalFile(request.path, this.#url));
			else if (request.kind === "base") value = JSON.parse(await this.#get(`${PREFIX}base`));
			else if (request.kind === "attach") {
				const file = await this.#confirm(() => attach(request.path, this.#prompter()));
				if (file !== null) {
					sandbox.post({ kind: "attached", id, name: file.name, bytes: file.bytes });
					return;
				}
				value = null;
			} else value = await this.#confirm(() => act(request, this.#prompter(), this.#options.opener));
			sandbox.post({ kind: "reply", id, value });
		} catch (error) {
			sandbox.post({ kind: "refused", id, message: error instanceof Error ? error.message : String(error) });
		} finally {
			if (this.#sandbox === sandbox) this.#requests--;
		}
	}

	/**
	 * Runs the action `run` (it asks the user), one at a time: a second is refused while one runs. Afterwards the held
	 * frames are written and the sandbox asked to redraw.
	 */
	async #confirm<T>(run: () => Promise<T>): Promise<T> {
		if (this.#confirming) throw new Error("terminal: a prompt is open");
		this.#confirming = true;
		try {
			return await run();
		} finally {
			this.#confirming = false;
			const held = this.#held;
			this.#held = [];
			this.#heldBytes = 0;
			for (const frame of held) this.#write(frame);
			this.#sandbox?.post({ kind: "resize", columns: this.#columns, rows: this.#rows });
		}
	}

	/** The launcher's own prompt on the real terminal, for the action being confirmed: its key not the sandbox's. */
	#prompter(): PromptTerminal {
		return {
			columns: this.#columns,
			ask: (lines) => {
				// Shown whole or not at all: a prompt is never cut.
				if (promptLines(lines, this.#columns).length >= this.#rows) {
					return Promise.reject(new Error("terminal: the prompt does not fit the terminal"));
				}
				return new Promise<boolean>((answer) => {
					this.#prompt = { lines, answer, ready: Date.now() + PROMPT_GUARD_MS };
					this.#drawPrompt();
				});
			},
			write: (data) => this.#output.write(data),
		};
	}

	/**
	 * Draws the open prompt on the bottom lines after closing a synchronized update the sandbox began: its attributes
	 * reset and its colours explicit, black on white, so no state the sandbox left (concealed, black on black: Opus E4)
	 * applies to it.
	 */
	#drawPrompt(): void {
		const lines = promptLines(this.#prompt!.lines, this.#columns);
		const top = Math.max(1, this.#rows - lines.length + 1);
		const drawn = lines.map((line, index) => `\x1b[${top + index};1H\x1b[0;30;47m\x1b[2K ${line} `);
		this.#output.write(`\x1b[?2026l\x1b[s${drawn.join("")}\x1b[0m`);
	}

	/** The prompt answered: cleared, the cursor back where the sandbox had it. */
	#answered(yes: boolean): void {
		const { lines, answer } = this.#prompt!;
		this.#prompt = undefined;
		const rows = promptLines(lines, this.#columns);
		const top = Math.max(1, this.#rows - rows.length + 1);
		const cleared = rows.map((_row, index) => `\x1b[${top + index};1H\x1b[0m\x1b[2K`).join("");
		this.#output.write(`${cleared}\x1b[u`);
		answer(yes);
	}

	/** The sandbox says its code is outdated: a new sandbox only when the server's base bundle is another. */
	async #outdated(): Promise<void> {
		const base = JSON.parse(await this.#get(`${PREFIX}base`).catch(() => "null")) as unknown;
		if (typeof base === "string" && base !== this.#base) await this.#restart();
	}

	/** The server has a new base bundle: a new sandbox with it, the old one ended. */
	async #restart(): Promise<void> {
		this.#closeSockets();
		await this.#sandbox?.terminate();
		this.#sandbox = undefined;
		try {
			await this.#startSandbox();
			this.#onResize();
		} catch {
			await this.finish(1);
		}
	}

	#closeSockets(): void {
		for (const ws of this.#sockets.values()) ws.close();
		this.#sockets.clear();
	}

	/** The text at `path` on the server, signed in; at most 8 MiB, read no further. */
	async #get(path: string): Promise<string> {
		const response = await fetch(new URL(path, this.#url), { headers: this.#headers });
		if (!response.ok || response.body === null) throw new Error(`terminal: GET ${path} answered ${response.status}`);
		if (Number(response.headers.get("content-length") ?? 0) > MAX_BUNDLE)
			throw new Error(`terminal: ${path} exceeds 8 MiB`);
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of response.body) {
			size += chunk.length;
			if (size > MAX_BUNDLE) throw new Error(`terminal: ${path} exceeds 8 MiB`);
			chunks.push(chunk);
		}
		return new TextDecoder().decode(Buffer.concat(chunks));
	}
}

/** The launcher's SIGUSR1 listener: the signal does nothing. */
function ignoreSignal(): void {}

/**
 * The system's languages: `LANGUAGE` (a colon list), then `LC_ALL`, `LC_MESSAGES`, `LANG` (`de_DE.UTF-8` is `de-DE`;
 * `C` and `POSIX` name none), then the runtime's default locale.
 */
function systemLocales(): readonly string[] {
	const { LANGUAGE, LC_ALL, LC_MESSAGES, LANG } = process.env;
	const named = [...(LANGUAGE ?? "").split(":"), LC_ALL, LC_MESSAGES, LANG].flatMap((value) => {
		const tag = value?.replace(/[.@].*$/, "").replace(/_/g, "-");
		return tag === undefined || tag === "" || tag === "C" || tag === "POSIX" ? [] : [tag];
	});
	return [...new Set([...named, Intl.DateTimeFormat().resolvedOptions().locale])];
}
