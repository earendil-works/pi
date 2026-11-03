// The launcher's end of the sandbox's pipes (slice 11 §4; fix round 2: the sandbox a child process): messages as
// plain length-prefixed binary frames, not Node's IPC. A frame is a 4-byte big-endian length, then the payload: a
// 4-byte big-endian header length, the header (the message as JSON, its body field left out), and the body (the raw
// bytes of `bytes`, or the UTF-8 text of `data`). The sandbox's bootstrap has the same codec (`sandbox.ts`). What the
// sandbox sends is untrusted: each frame is bounded, and each message checked here before the launcher acts on it.

import type { BridgeRequest, LauncherMessage, SandboxMessage } from "../../tui/bridge.ts";

/** The largest frame either side takes: 17 MiB (an attached file of 16 MiB and its header). */
export const MAX_PIPE_FRAME = 17 * 1024 * 1024;

/** The largest header of a frame from the sandbox: 1 MiB (a request's text or URL; frames carry their text as body). */
const MAX_HEADER = 1024 * 1024;

/** `message` as one frame for the sandbox. */
export function launcherFrame(message: LauncherMessage): Buffer {
	if (message.kind === "input") return frame({ kind: "input" }, Buffer.from(message.data));
	if (message.kind === "socket_message") return frame({ kind: message.kind, socket: message.socket }, message.bytes);
	if (message.kind === "attached")
		return frame({ kind: message.kind, id: message.id, name: message.name }, message.bytes);
	return frame(message, undefined);
}

/** The first frame: the bridge's start and the base bundle's text as body. */
export function startFrame(start: unknown, source: string): Buffer {
	return frame({ kind: "start", start }, Buffer.from(source));
}

/** A frame of `header` and `body`. */
function frame(header: object, body: Uint8Array | undefined): Buffer {
	const json = Buffer.from(JSON.stringify(header));
	const prefix = Buffer.allocUnsafe(8);
	prefix.writeUInt32BE(4 + json.length + (body?.length ?? 0), 0);
	prefix.writeUInt32BE(json.length, 4);
	return Buffer.concat(body === undefined ? [prefix, json] : [prefix, json, body]);
}

/**
 * Cuts the sandbox's output into messages as chunks arrive; throws (the sandbox is ended) on a frame over
 * `MAX_PIPE_FRAME`, a header over 1 MiB, or a message of no known shape. Each byte is copied in once, however small the
 * chunks the sandbox writes.
 */
export class FrameReader {
	#buffer = Buffer.alloc(64 * 1024);
	#start = 0;
	#end = 0;

	/** The messages complete with `chunk`. */
	push(chunk: Buffer): SandboxMessage[] {
		this.#append(chunk);
		const messages: SandboxMessage[] = [];
		while (this.#end - this.#start >= 4) {
			const length = this.#buffer.readUInt32BE(this.#start);
			if (length < 4 || length > MAX_PIPE_FRAME) throw new Error("terminal: the sandbox sent a malformed frame");
			if (this.#end - this.#start < 4 + length) break;
			// The message copies what it keeps: the buffer is reused.
			messages.push(sandboxMessage(this.#buffer.subarray(this.#start + 4, this.#start + 4 + length)));
			this.#start += 4 + length;
		}
		if (this.#start === this.#end) this.#start = this.#end = 0;
		return messages;
	}

	/** Copies `chunk` in after the unread bytes, moving them to the front or growing the buffer when it is full. */
	#append(chunk: Buffer): void {
		const unread = this.#end - this.#start;
		if (this.#end + chunk.length > this.#buffer.length) {
			const needed = unread + chunk.length;
			const target =
				needed <= this.#buffer.length
					? this.#buffer
					: Buffer.alloc(Math.max(needed, Math.min(this.#buffer.length * 2, MAX_PIPE_FRAME + 4)));
			this.#buffer.copy(target, 0, this.#start, this.#end);
			this.#buffer = target;
			this.#start = 0;
			this.#end = unread;
		}
		chunk.copy(this.#buffer, this.#end);
		this.#end += chunk.length;
	}
}

/**
 * The message in `payload` (a frame from the sandbox, without its length); throws for anything else. Trust boundary:
 * the sandbox's pipe.
 */
function sandboxMessage(payload: Buffer): SandboxMessage {
	const headerLength = payload.readUInt32BE(0);
	if (headerLength > MAX_HEADER || 4 + headerLength > payload.length) throw malformed();
	const header = JSON.parse(payload.toString("utf8", 4, 4 + headerLength)) as Record<string, unknown> | null;
	const body = payload.subarray(4 + headerLength);
	if (typeof header !== "object" || header === null) throw malformed();
	const socket = header.socket;
	switch (header.kind) {
		case "write":
			return { kind: "write", data: body.toString("utf8") };
		case "socket_send":
			if (!Number.isSafeInteger(socket)) throw malformed();
			// A copy: the payload's memory is the reader's.
			return { kind: "socket_send", socket: socket as number, bytes: new Uint8Array(body) };
		case "socket_open":
		case "socket_close":
			if (!Number.isSafeInteger(socket)) throw malformed();
			return { kind: header.kind, socket: socket as number };
		case "request":
			if (!Number.isSafeInteger(header.id)) throw malformed();
			return { kind: "request", id: header.id as number, request: bridgeRequest(header.request) };
		case "outdated":
			return { kind: "outdated" };
		case "failed":
			return { kind: "failed", message: String(header.message) };
		case "exit":
			return { kind: "exit", code: Number.isSafeInteger(header.code) ? (header.code as number) : 1 };
		default:
			throw malformed();
	}
}

/** The request `value` names; throws for anything else. */
function bridgeRequest(value: unknown): BridgeRequest {
	const request = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
	if (request.kind === "base") return { kind: "base" };
	if (request.kind === "fetch" && typeof request.path === "string") return { kind: "fetch", path: request.path };
	if (request.kind === "copy" && typeof request.text === "string") return { kind: "copy", text: request.text };
	if (request.kind === "open" && typeof request.url === "string") return { kind: "open", url: request.url };
	if (request.kind === "attach" && typeof request.path === "string") return { kind: "attach", path: request.path };
	throw malformed();
}

function malformed(): Error {
	return new Error("terminal: the sandbox sent a malformed message");
}
