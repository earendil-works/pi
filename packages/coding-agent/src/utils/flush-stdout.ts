const STDOUT_FLUSH_TIMEOUT_MS = 1000;

/**
 * Wait until stdout has written everything queued before this call, for at most one second.
 * process.exit() drops queued writes, which include the terminal mode resets from stopping a TUI (#12133).
 * The timeout keeps a stalled terminal from blocking exit. An empty write is used because "drain" only
 * fires after a write filled the buffer.
 */
export function flushStdout(): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, STDOUT_FLUSH_TIMEOUT_MS);
		process.stdout.write("", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}
