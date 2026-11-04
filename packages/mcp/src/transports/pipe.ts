import { type JsonRpcMessage, McpConnectionClosedError } from "../protocol/jsonrpc.ts";
import { JsonRpcLineReader } from "./lines.ts";
import { type McpTransport, TransportEvents } from "./transport.ts";

const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

/** A running program's stdio, as `@earendil-works/pi-env`'s `RemoteProcess` provides it. */
export interface McpPipe {
	write(data: Uint8Array | string): void;
	closeStdin(): void;
	/** Kill the program (and what it started). The pipe owns cleaning up what the program started. */
	close(): void;
	/** Settles when the program has ended, whatever the reason; it must also settle after `close()`. */
	readonly exited: Promise<unknown>;
}

/** Handlers `PipeTransportOptions.open` connects to the program's output. */
export interface McpPipeHandlers {
	onStdout(bytes: Uint8Array): void;
	onStderr(bytes: Uint8Array): void;
}

export interface PipeTransportOptions {
	/** Start the program; `onStdout`/`onStderr` receive its output from then on. */
	open(handlers: McpPipeHandlers): Promise<McpPipe>;
	maxMessageBytes?: number;
	maxStderrBytes?: number;
	onStderr?: (chunk: string) => void;
	/** After closing stdin, how long the program may take to exit before `close()` kills it. Default 2000. */
	closeTimeoutMs?: number;
}

/**
 * MCP's stdio transport over a program that something else runs, for example on another machine through pi-env.
 * The transport closes when the program ends; a rejected `exited` that `close()` did not cause is reported as an
 * error first.
 */
export class PipeTransport extends TransportEvents implements McpTransport {
	readonly options: Readonly<PipeTransportOptions>;
	private readonly lines: JsonRpcLineReader;
	private pipe: McpPipe | undefined;
	private started = false;
	private closed = false;
	private ended = false;

	constructor(options: PipeTransportOptions) {
		super();
		this.options = Object.freeze({ ...options });
		this.lines = new JsonRpcLineReader({
			maxMessageBytes: this.options.maxMessageBytes,
			maxStderrBytes: this.options.maxStderrBytes,
			onStderr: this.options.onStderr,
			onMessage: (message) => this.emitMessage(message),
			onError: (error) => this.emitError(error),
		});
	}

	/** The last `maxStderrBytes` (default 64 KiB) of the program's stderr. */
	get stderr(): string {
		return this.lines.stderr;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("MCP pipe transport already started");
		if (this.closed) throw new McpConnectionClosedError();
		this.started = true;
		const pipe = await this.options.open({
			onStdout: (bytes) => this.lines.readStdout(bytes),
			onStderr: (bytes) => this.lines.readStderr(bytes),
		});
		if (this.closed) {
			// close() ran while the program was starting and found nothing to shut down. Nobody else awaits
			// `exited`, and a pipe may reject it after a kill.
			pipe.exited.catch(() => {});
			pipe.close();
			throw new McpConnectionClosedError();
		}
		this.pipe = pipe;
		pipe.exited.then(
			() => this.exit(),
			(error: unknown) => this.fail(error),
		);
	}

	async send(message: JsonRpcMessage): Promise<void> {
		if (!this.pipe || this.closed || this.ended) throw new McpConnectionClosedError();
		this.pipe.write(`${JSON.stringify(message)}\n`);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const pipe = this.pipe;
		if (!pipe) {
			this.emitClose();
			return;
		}
		if (this.ended) return;
		// Shutdown per the spec: close stdin and let the program exit, then kill it.
		pipe.closeStdin();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const exitedInTime = await Promise.race([
			pipe.exited.then(
				() => true,
				() => true,
			),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
			}),
		]);
		clearTimeout(timer);
		if (exitedInTime) return;
		pipe.close();
		await pipe.exited.catch(() => {});
	}

	/** The program ended: report an unfinished message, then close. */
	private exit(): void {
		this.ended = true;
		this.lines.end();
		this.emitClose();
	}

	/** `exited` rejected: an error unless `close()` caused it, then the same as an exit. */
	private fail(error: unknown): void {
		if (!this.closed) this.emitError(error);
		this.exit();
	}
}
