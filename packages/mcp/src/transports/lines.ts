import { type JsonRpcMessage, parseJsonRpcMessage } from "../protocol/jsonrpc.ts";
import { DEFAULT_MAX_MESSAGE_BYTES } from "./transport.ts";

const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

export interface JsonRpcLineReaderOptions {
	maxMessageBytes?: number;
	maxStderrBytes?: number;
	/** Every stderr chunk, decoded as UTF-8. */
	onStderr?: (chunk: string) => void;
	onMessage(message: JsonRpcMessage): void;
	onError(error: unknown): void;
}

/**
 * Reads a program's output as MCP's stdio framing: newline-delimited JSON-RPC messages on stdout, and a bounded
 * tail of stderr for diagnostics.
 */
export class JsonRpcLineReader {
	private readonly options: JsonRpcLineReaderOptions;
	/** The bytes of the incomplete message received so far. */
	private stdoutChunks: Buffer[] = [];
	private stdoutPendingBytes = 0;
	private stderrBuffer = Buffer.alloc(0);

	constructor(options: JsonRpcLineReaderOptions) {
		this.options = options;
	}

	/** The last `maxStderrBytes` of stderr. */
	get stderr(): string {
		return this.stderrBuffer.toString("utf8");
	}

	/**
	 * Takes the next stdout bytes and reports every complete message, or the error parsing it. Bytes of an
	 * incomplete message are kept as chunks and joined once when its newline arrives, so a large message that
	 * arrives in many chunks is copied and scanned only once.
	 */
	readStdout(chunk: Uint8Array): void {
		const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		const maxMessageBytes = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		let start = 0;
		while (true) {
			const newline = data.indexOf(0x0a, start);
			if (newline < 0) {
				if (start < data.length) {
					// Copied, since the caller may reuse the chunk's memory.
					this.stdoutChunks.push(Buffer.from(data.subarray(start)));
					this.stdoutPendingBytes += data.length - start;
				}
				if (this.stdoutPendingBytes > maxMessageBytes) {
					this.stdoutChunks = [];
					this.stdoutPendingBytes = 0;
					this.options.onError(new Error(`MCP stdio message exceeds ${maxMessageBytes} bytes`));
				}
				return;
			}
			let line = data.subarray(start, newline);
			if (this.stdoutChunks.length > 0) {
				this.stdoutChunks.push(line);
				line = Buffer.concat(this.stdoutChunks, this.stdoutPendingBytes + line.length);
				this.stdoutChunks = [];
				this.stdoutPendingBytes = 0;
			}
			start = newline + 1;
			if (line.length > maxMessageBytes) {
				this.options.onError(new Error(`MCP stdio message exceeds ${maxMessageBytes} bytes`));
				continue;
			}
			const text = line.toString("utf8").replace(/\r$/, "");
			if (!text.trim()) continue;
			try {
				this.options.onMessage(parseJsonRpcMessage(JSON.parse(text)));
			} catch (error) {
				this.options.onError(error);
			}
		}
	}

	/** Takes the next stderr bytes into the tail and passes them to `onStderr`. */
	readStderr(chunk: Uint8Array): void {
		const maxStderrBytes = this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
		this.stderrBuffer = Buffer.concat([this.stderrBuffer, chunk]);
		if (this.stderrBuffer.length > maxStderrBytes) this.stderrBuffer = this.stderrBuffer.subarray(-maxStderrBytes);
		this.options.onStderr?.(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8"));
	}

	/** Ends stdout: a message without its newline is reported as an error and dropped. */
	end(): void {
		if (Buffer.concat(this.stdoutChunks).toString("utf8").trim()) {
			this.options.onError(new Error("MCP stdio server closed with an incomplete JSON-RPC message"));
		}
		this.stdoutChunks = [];
		this.stdoutPendingBytes = 0;
	}
}
