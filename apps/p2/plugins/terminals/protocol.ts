// Dedicated terminal byte channel and detached-host framing. Adapted from apps/mobile.
import type { Socket } from "node:net";

export type TerminalInfo = {
	id: string;
	sessionId: string;
	/** Its number in the session, stable while it lives: the lowest free one from 1 (the agent's `-t 2`). */
	index: number;
	/** A name given when it was opened (`new-window -n`). */
	name?: string;
	/** The agent opened it (the terminal tool); the owner's own have no mark. */
	agent?: true;
	cwd: string;
	env: string | null;
	title: string;
	createdAt: number;
	cols: number;
	rows: number;
	exited?: { code?: number; error?: string };
};
export type TerminalTheme = { foreground: number; background: number; scheme: "light" | "dark" };
export type TerminalRequest =
	| { type: "list"; sessionId: string }
	| ({ type: "theme" } & TerminalTheme)
	| { type: "open"; sessionId: string; cwd: string; env: string | null; cols: number; rows: number }
	| { type: "attach"; terminalId: string }
	| { type: "resize"; cols: number; rows: number }
	| { type: "ack"; bytes: number }
	| { type: "close"; force?: boolean }
	| { type: "shutdown" }
	/** A request with a reply (`reply` with the same id): the agent's terminal tool and the server's own requests. */
	| { type: "call"; id: number; call: HostCall }
	/** Ends a call still waiting (a wait for output): it replies with an error. */
	| { type: "cancel"; id: number };

/** How long a read waits for output, and for what. A timeout is no error: the read returns what is there. */
export type TerminalWait = {
	until: "quiet" | "exit" | "match";
	/** `match`: a regular expression (JavaScript, multiline) tested against the plain text read. */
	pattern?: string;
	ignoreCase?: boolean;
	/** `quiet`: how long without output counts as quiet. */
	quietMs?: number;
	timeoutMs: number;
};

/**
 * The host's calls. Each names its session: a terminal of another session is unknown to it. `key` makes a call that
 * changes something idempotent: a call with a key the host has seen returns the first call's result, done once.
 */
export type HostCall =
	| { op: "list"; sessionId: string }
	| {
			op: "open";
			sessionId: string;
			key: string;
			cwd: string;
			env: string | null;
			name?: string;
			/** Typed into the new shell, then Enter. */
			command?: string;
			cols: number;
			rows: number;
	  }
	/** tmux `send-keys`: key names (`Enter`, `C-c`) as keys, other arguments as text; all text when `literal`. */
	| { op: "send"; sessionId: string; key: string; target: string; keys: string[]; literal: boolean }
	/** The terminal's read cursor: where the next read without `from` starts. */
	| { op: "cursor"; sessionId: string; target: string }
	/** Output since `from` (default: the read cursor) as plain text, after an optional wait; moves the read cursor. */
	| { op: "read"; sessionId: string; target: string; from?: number; wait?: TerminalWait }
	/** tmux `capture-pane`: the screen as plain text, with up to `scrollback` lines before it; styled with `escapes`. */
	| { op: "capture"; sessionId: string; target: string; scrollback: number; escapes?: boolean }
	| { op: "close"; sessionId: string; key: string; target: string }
	/** Closes every terminal of the session (archived). */
	| { op: "closeSession"; sessionId: string };

/** What a read returns. */
export type TerminalRead = {
	terminal: TerminalInfo;
	/** The output read: `from` to `to`, absolute byte offsets of the terminal's output. */
	from: number;
	to: number;
	/** Plain text: escape sequences removed, carriage-return overwrites applied. */
	text: string;
	/** Bytes after `from` the host no longer kept (its ring holds the last MiB). */
	skipped: number;
	/** Characters of `text` left out at its start (it keeps the last `READ_TEXT_LIMIT`). */
	truncated: number;
	/** A full-screen program (alternate screen) runs: its screen as plain text, which says more than its output. */
	screen?: string;
	/** Why a wait ended. */
	waited?: "quiet" | "exit" | "match" | "timeout" | "closed";
	/** The job in front of the shell (an editor, a build), when one runs; absent at the prompt or once exited. */
	foreground?: string;
};

export type HostResult =
	| { kind: "list"; windows: { terminal: TerminalInfo; foreground?: string }[] }
	| { kind: "terminal"; terminal: TerminalInfo }
	| { kind: "cursor"; terminal: TerminalInfo; offset: number }
	| ({ kind: "read" } & TerminalRead)
	| { kind: "capture"; terminal: TerminalInfo; text: string }
	| { kind: "closed"; terminalId: string }
	| { kind: "done" };

/** Plain text a read returns at most: its last characters. */
export const READ_TEXT_LIMIT = 256 * 1024;
export type TerminalEvent =
	| { type: "list"; terminals: TerminalInfo[] }
	| { type: "attached"; terminal: TerminalInfo }
	| { type: "changed"; terminal: TerminalInfo }
	| { type: "closed"; terminalId: string }
	| { type: "busy"; terminalId: string; program?: string }
	| { type: "error"; message: string }
	| { type: "hello"; version: string; running: number; pid: number }
	| { type: "outdated"; running?: number }
	/** The session's terminals changed (opened, closed, exited, renamed): sent to every connection that listed it. */
	| { type: "terminals"; terminals: TerminalInfo[] }
	| { type: "reply"; id: number; result: HostResult }
	| { type: "reply"; id: number; error: string };
/**
 * Output a viewer may have unacknowledged. It bounds how long a keystroke's echo can wait behind earlier output: at
 * 5 Mbit/s, 256 KiB is 0.4 s. Viewers acknowledge every 64 KiB (Terminal.tsx), so four batches are in flight.
 */
export const TERMINAL_OUTPUT_WINDOW = 256 * 1024;
export const MAX_BACKLOG = 8 * 1024 * 1024;
const MAX_FRAME = 16 * 1024 * 1024;

export function encodeFrame(message: object | Uint8Array): Buffer {
	const binary = message instanceof Uint8Array;
	const body = binary ? message : Buffer.from(JSON.stringify(message), "utf8");
	const header = Buffer.alloc(5);
	header.writeUInt32BE(body.length + 1, 0);
	header.writeUInt8(binary ? 1 : 0, 4);
	return Buffer.concat([header, body]);
}

export function readFrames(socket: Socket, onFrame: (frame: unknown | Uint8Array) => void): void {
	let pending: Buffer = Buffer.alloc(0);
	socket.on("data", (chunk: Buffer) => {
		let buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
		while (buffer.length >= 4) {
			const length = buffer.readUInt32BE(0);
			if (length < 1 || length > MAX_FRAME) {
				socket.destroy(new Error("Corrupt terminal frame"));
				return;
			}
			if (buffer.length < 4 + length) break;
			const kind = buffer.readUInt8(4);
			const body = buffer.subarray(5, 4 + length);
			buffer = buffer.subarray(4 + length);
			if (kind === 1) {
				onFrame(new Uint8Array(body));
				continue;
			}
			if (kind !== 0) {
				socket.destroy(new Error("Corrupt terminal frame"));
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(body.toString("utf8"));
			} catch {
				socket.destroy(new Error("Corrupt terminal frame"));
				return;
			}
			onFrame(parsed);
		}
		pending = Buffer.from(buffer);
	});
}
