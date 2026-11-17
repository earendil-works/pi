// The `p3` command. The same file runs from a source checkout (`node --conditions=source bin.ts`) and, bundled, as the
// installed package's `p3`. It reads the command line (which command, which Pi), then runs the server in the
// foreground (`p3 server`: it closes on SIGINT and SIGTERM, so workers stop and the data directory's lock is free at
// once) or one of the commands of `src/commands.ts`.

// First: a Node too old for p3 ends here, before any other module runs.
import "./src/minimum-node.ts";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { startP3 } from "./server.ts";
import { list, restart, start, status, stop } from "./src/commands.ts";
import { version } from "./src/install.ts";
import type { App } from "./src/kit/app.ts";
import { defaultDataDir } from "./src/kit/layout.ts";
import { ListenFailed } from "./src/kit/start-server.ts";
import { DEFAULT_PORT, dataDirOf, isPiName } from "./src/pi.ts";

const USAGE = `Usage: p3 [command] [--pi <name> | --dir <path>] [--port <n>]

A Pi is its data directory: ~/.pi/p3 (the default Pi), ~/.pi/p3/pis/<name> (--pi) or any directory (--dir).

Commands:
  (none)     Start the Pi's server in the background unless it runs; print its port and an owner link (also: start)
  server     Run the Pi's server in the foreground
  status     Say whether the Pi's server runs: its port, pid, data directory, version and start time
  stop       Stop the Pi's server; returns once it is gone
  restart    Stop, then start in the background
  list       The Pis on this machine and their state

Options:
  --pi <name>   A named Pi (lower case letters, digits, - and _)
  --dir <path>  A Pi in any directory
  --port <n>    The port for this start, on 127.0.0.1 (0: a free one). Without it a Pi listens on its own port:
                ${DEFAULT_PORT} for the default Pi, else a free one taken at its first start and kept
  --version     Print p3's version
  --help        Print this help`;

const { values, positionals } = commandLine();
if (values.help === true) console.log(USAGE);
else if (values.version === true) console.log(version());
else await run(positionals, values);

/** The command line's flags. */
type Flags = { readonly pi?: string; readonly dir?: string; readonly port?: string };

/** The command line, parsed; one that names an unknown option is refused. */
function commandLine() {
	try {
		return parseArgs({
			options: {
				pi: { type: "string" },
				dir: { type: "string" },
				port: { type: "string" },
				version: { type: "boolean" },
				help: { type: "boolean" },
			},
			allowPositionals: true,
		});
	} catch {
		return usage();
	}
}

/**
 * Runs `command` (plain `p3` is `start`) on the Pi `flags` name, and sets the exit code; a failure is printed as one
 * line and ends the process with 1. The command line is a trust boundary: whatever does not fit is refused.
 */
async function run([command = "start", ...rest]: readonly string[], flags: Flags): Promise<void> {
	const starts = command === "start" || command === "server" || command === "restart";
	if (rest.length > 0 || (flags.pi !== undefined && flags.dir !== undefined)) usage();
	if (flags.pi !== undefined && !isPiName(flags.pi)) usage();
	// Digits only: a blank is no port (`Number("")` is 0, a free one).
	if (flags.port !== undefined && !(starts && /^\d{1,5}$/.test(flags.port) && Number(flags.port) <= 65535)) usage();
	if (command === "list" && (flags.pi !== undefined || flags.dir !== undefined)) usage();
	const dataDir = dataDirOf(flags);
	const port = flags.port === undefined ? undefined : Number(flags.port);
	try {
		if (command === "server") await serve(dataDir, port);
		else if (command === "start") process.exitCode = await start(dataDir, port, context);
		else if (command === "restart") process.exitCode = await restart(dataDir, port, context);
		else if (command === "status") process.exitCode = await status(dataDir, context);
		else if (command === "stop") process.exitCode = await stop(dataDir, context);
		else if (command === "list") process.exitCode = await list(defaultDataDir(), context);
		else usage();
	} catch (error) {
		const busy = error instanceof ListenFailed && error.code === "EADDRINUSE";
		const message = error instanceof Error ? error.message.replace(/^startServer: /, "") : String(error);
		console.error(
			busy ? `p3: port ${error.address.port} is in use; pass --port <n> or stop what uses it` : `p3: ${message}`,
		);
		process.exit(1);
	}
}

/**
 * Runs the server on `dataDir` in the foreground until a signal or the owner's stop over HTTP closes it. A signal
 * during the start closes it once the start is done (the record may say `running` before the start returns): a start
 * cut off would skip the close.
 */
async function serve(dataDir: string, port: number | undefined): Promise<void> {
	const started = Promise.withResolvers<App>();
	const stop = (): void => void started.promise.then(close);
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
	const app = await startP3(context, { dataDir, onStop: stop, ...(port === undefined ? {} : { port }) });
	// A supervisor hears that the server listens; its log gets no owner link (`p3` prints a fresh one).
	const supervised = process.send !== undefined;
	console.log(`p3 on ${app.dataDir}, port ${app.port()}${supervised ? "" : `. Open ${app.ownerLink()}`}`);
	process.send?.("listening");
	started.resolve(app);
}

/** Closes `app` and exits: 0, or 1 when the close failed. */
function close(app: App): void {
	app.close(context).then(
		() => process.exit(0),
		(error: unknown) => {
			console.error("p3: the close failed:", error);
			process.exit(1);
		},
	);
}

/** A command line p3 does not understand: the usage, exit code 2. */
function usage(): never {
	console.error(USAGE);
	process.exit(2);
}
