// Dedicated terminal byte channel and detached-host framing. Adapted from apps/mobile.
import type { Socket } from "node:net";

export type TerminalInfo = {
	id: string;
	sessionId: string;
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
	| { type: "shutdown" };
export type TerminalEvent =
	| { type: "list"; terminals: TerminalInfo[] }
	| { type: "attached"; terminal: TerminalInfo }
	| { type: "changed"; terminal: TerminalInfo }
	| { type: "closed"; terminalId: string }
	| { type: "busy"; terminalId: string; program?: string }
	| { type: "error"; message: string }
	| { type: "hello"; version: string; running: number; pid: number }
	| { type: "outdated"; running?: number };
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
