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
	private stdoutBuffer = Buffer.alloc(0);
	private stderrBuffer = Buffer.alloc(0);

	constructor(options: JsonRpcLineReaderOptions) {
		this.options = options;
	}

	/** The last `maxStderrBytes` of stderr. */
	get stderr(): string {
		return this.stderrBuffer.toString("utf8");
	}

	/** Takes the next stdout bytes and reports every complete message, or the error parsing it. */
	readStdout(chunk: Uint8Array): void {
		this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
		const maxMessageBytes = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
		while (true) {
			const newline = this.stdoutBuffer.indexOf(0x0a);
			if (newline < 0) {
				if (this.stdoutBuffer.length > maxMessageBytes) {
					this.stdoutBuffer = Buffer.alloc(0);
					this.options.onError(new Error(`MCP stdio message exceeds ${maxMessageBytes} bytes`));
				}
				return;
			}
			const line = this.stdoutBuffer.subarray(0, newline);
			this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
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
		if (this.stdoutBuffer.toString("utf8").trim()) {
			this.options.onError(new Error("MCP stdio server closed with an incomplete JSON-RPC message"));
		}
		this.stdoutBuffer = Buffer.alloc(0);
	}
}
