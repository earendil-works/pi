import { createInterface } from "node:readline/promises";

/** Read one line from stdin, rejecting on abort, Ctrl+C, or EOF and always closing readline. */
export async function questionTerminal(
	message: string,
	options: {
		output: NodeJS.WritableStream;
		signal: AbortSignal;
		/** Called on Ctrl+C or EOF, not when the caller aborts just this prompt. */
		onInterrupt?: () => void;
	},
): Promise<string> {
	const readline = createInterface({ input: process.stdin, output: options.output });
	const interrupted = new AbortController();
	// EOF closes readline without settling its pending question; Ctrl+C normally only pauses it.
	const onInterrupt = () => interrupted.abort();
	readline.on("SIGINT", onInterrupt);
	readline.on("close", onInterrupt);
	try {
		return await readline.question(message, { signal: AbortSignal.any([options.signal, interrupted.signal]) });
	} catch (error) {
		if (interrupted.signal.aborted) options.onInterrupt?.();
		throw error;
	} finally {
		readline.off("close", onInterrupt);
		readline.off("SIGINT", onInterrupt);
		readline.close();
	}
}
