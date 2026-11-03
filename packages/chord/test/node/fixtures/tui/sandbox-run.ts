// Runs a sandbox for the TUI tests under Node 26.5.1 or later with the base bundle given as the first argument (a
// CommonJS script's text), printing one JSON line per message it sends (its kind and text) and its end.

import { Sandbox } from "../../../../src/node/tui/sandbox.ts";

const sandbox = await Sandbox.start(
	process.argv[2]!,
	{ base: "test", combined: "", columns: 80, rows: 24, colors: "truecolor", mode: "dark" },
	(message) => {
		console.log(JSON.stringify({ kind: message.kind, data: (message as { data?: unknown }).data }));
		if (message.kind === "exit") void sandbox.terminate();
	},
	(reason) => console.log(JSON.stringify({ kind: "end", data: reason })),
);
