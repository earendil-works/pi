// Runs a terminal launcher for the TUI tests under Node 26.5.1 or later (the sandbox needs it): `drive.ts <url>
// token <file>` or `drive.ts <url> pair <label>`; the launcher's terminal is this process's stdin and stdout (pipes),
// and its exit code this process's.

import { startTerminal } from "../../../../src/node/tui/index.ts";

const [url, how, value] = process.argv.slice(2);
const terminal = await startTerminal({
	url: url!,
	credentials: how === "pair" ? { kind: "pairing", label: value! } : { kind: "file", path: value! },
	colors: "truecolor",
	opener: async (target) => {
		process.stdout.write(`(opener ${target})\r\n`);
	},
});
process.exitCode = await terminal.exited;
process.stdin.destroy();
