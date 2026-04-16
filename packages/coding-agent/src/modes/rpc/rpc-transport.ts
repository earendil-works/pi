import { takeOverStdout, writeRawStdout } from "../../core/output-guard.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type { RpcTransport } from "./rpc-types.js";

/**
 * Create the default stdio-based RPC transport.
 *
 * - Reads JSONL from `process.stdin`, parses each line, and delivers parsed objects
 * - Serializes outgoing messages as JSONL and writes to `process.stdout` (via the raw write bypass)
 * - `setup()` calls `takeOverStdout()` so stray `console.log` writes
 *   are redirected to stderr and don't corrupt the protocol channel.
 */
export function createStdioTransport(): RpcTransport {
	let detachLine: (() => void) | undefined;
	let endHandler: (() => void) | undefined;

	return {
		setup() {
			takeOverStdout();
		},

		write(message: object) {
			writeRawStdout(serializeJsonLine(message));
		},

		onMessage(callback: (message: unknown) => void): () => void {
			detachLine = attachJsonlLineReader(process.stdin, (line) => {
				try {
					callback(JSON.parse(line));
				} catch (e: unknown) {
					this.write({
						type: "response",
						command: "parse",
						success: false,
						error: `Failed to parse command: ${e instanceof Error ? e.message : String(e)}`,
					});
				}
			});
			return detachLine;
		},

		onEnd(callback: () => void): () => void {
			endHandler = callback;
			process.stdin.on("end", endHandler);
			return () => {
				if (endHandler) {
					process.stdin.off("end", endHandler);
					endHandler = undefined;
				}
			};
		},

		close() {
			detachLine?.();
			if (endHandler) {
				process.stdin.off("end", endHandler);
				endHandler = undefined;
			}
			process.stdin.pause();
		},
	};
}
