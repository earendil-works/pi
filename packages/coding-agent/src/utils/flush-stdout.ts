const STDOUT_FLUSH_TIMEOUT_MS = 1000;

/**
 * Wait until stdout has written everything queued before this call, for at most one second.
 * process.exit() drops queued writes, which include the terminal mode resets from stopping a TUI (#12133).
 * The timeout keeps a stalled terminal from blocking exit. An empty write is used because "drain" only
 * fires after a write filled the buffer.
 */
export function flushStdout(): Promise<void> {
	return new Promise((resolve) => {
		const finish = (error?: Error | null): void => {
			clearTimeout(timer);
			// A failed write, e.g. EPIPE on a closed stdout, also emits "error" after its callback. Keep the
			// listener then, so that event is not an uncaught exception.
			if (!error) process.stdout.off("error", finish);
			resolve();
		};
		const timer = setTimeout(finish, STDOUT_FLUSH_TIMEOUT_MS);
		process.stdout.on("error", finish);
		process.stdout.write("", finish);
	});
}
