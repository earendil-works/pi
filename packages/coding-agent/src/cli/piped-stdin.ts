/** Grace window for the first piped byte before startup proceeds without stdin content. */
export const PIPED_STDIN_FIRST_BYTE_GRACE_MS = 1000;

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 *
 * A non-TTY stdin that stays open without ever delivering a byte (for example a
 * background invocation inheriting a silent pipe from an earlier heredoc in a
 * compound script) would otherwise park the process forever waiting for EOF,
 * before any session, log, or network activity exists (earendil-works/pi#2078
 * family). If no first byte arrives within the grace window, treat it as "no
 * piped input" and continue startup. Once data starts flowing, the stream is
 * read to EOF with no further deadline, so slow writers lose nothing as long
 * as their first chunk arrives within the window.
 */
export function readPipedStdin(
	stdin: NodeJS.ReadStream = process.stdin,
	firstByteGraceMs: number = PIPED_STDIN_FIRST_BYTE_GRACE_MS,
): Promise<string | undefined> {
	if (stdin.isTTY) {
		return Promise.resolve(undefined);
	}

	return new Promise((resolve) => {
		let data = "";
		let sawData = false;
		const onData = (chunk: string) => {
			sawData = true;
			clearTimeout(timer);
			data += chunk;
		};
		const onEnd = () => {
			clearTimeout(timer);
			resolve(data.trim() || undefined);
		};
		const timer = setTimeout(() => {
			if (sawData) return;
			stdin.pause();
			stdin.removeListener("data", onData);
			stdin.removeListener("end", onEnd);
			resolve(undefined);
		}, firstByteGraceMs);
		timer.unref?.();
		stdin.setEncoding("utf8");
		stdin.on("data", onData);
		stdin.on("end", onEnd);
		stdin.resume();
	});
}
