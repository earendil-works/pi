// The `p3` command. `p3 server` runs a Pi's server in the foreground (closed by SIGINT, SIGTERM or the owner's stop);
// plain `p3` starts it in the background under its supervisor unless it runs, and prints an owner link; `p3 stop`
// stops it; `p3 restart` stops, then starts it; `p3 status` says whether it runs; `p3 list` lists the Pis. Whether a
// server runs: its data directory's lock is held and `running.json` names its pid and port. The owner link and the stop
// are asked over HTTP with the owner token file the sign-in plugin keeps.

// First: a Node too old for p3 ends here, before any other module runs.
import "./minimum-node.ts";
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { processLock } from "@earendil-works/chord/workers/child";
import { defaultDataDir, openDataDir } from "./files.ts";
import { COMMAND, PLUGINS, SUPERVISOR, version, WORKER } from "./install.ts";
import { DEFAULT_PORT, dataDirOf, isPiName, keepPort, keptPort, namedPis, readConfig } from "./pi.ts";
import { type ServerRecord, serverFile, serverLock, supervisorFile, supervisorLock } from "./records.ts";
import { type RunningServer, startServer } from "./server.ts";

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

/** How long a background start may take. */
const START_MS = 30_000;

/** How long a stop may take before the server is signalled, and then killed. */
const STOP_MS = 10_000;

/** The command line's flags. */
type Flags = { readonly pi?: string; readonly dir?: string; readonly port?: string };

const { values, positionals } = commandLine();
if (values.help === true) console.log(USAGE);
else if (values.version === true) console.log(version());
else await run(positionals, values);

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

/** Runs `command` (plain `p3` is `start`) on the Pi `flags` names; a failure is one line and exit 1. */
async function run([command = "start", ...rest]: readonly string[], flags: Flags): Promise<void> {
	// A trust boundary: the command line.
	const starts = command === "start" || command === "server" || command === "restart";
	if (rest.length > 0 || (flags.pi !== undefined && flags.dir !== undefined)) usage();
	if (flags.pi !== undefined && !isPiName(flags.pi)) usage();
	if (flags.port !== undefined && !(starts && /^\d{1,5}$/.test(flags.port) && Number(flags.port) <= 65535)) usage();
	if (command === "list" && (flags.pi !== undefined || flags.dir !== undefined)) usage();
	const dataDir = dataDirOf(flags);
	const port = flags.port === undefined ? undefined : Number(flags.port);
	try {
		if (command === "server") await serve(dataDir, port);
		else if (command === "start") await start(dataDir, port);
		else if (command === "restart") {
			await stop(dataDir);
			await start(dataDir, port);
		} else if (command === "stop") await stop(dataDir);
		else if (command === "status") await status(dataDir);
		else if (command === "list") await list();
		else usage();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

/** Runs the server in the foreground until a signal or the owner's stop closes it. */
async function serve(path: string, port: number | undefined): Promise<void> {
	const dataDir = await openDataDir(path);
	const started = Promise.withResolvers<RunningServer>();
	const close = (): void =>
		void started.promise
			.then((server) => server.close(context))
			.then(
				() => process.exit(0),
				(error: unknown) => {
					console.error("p3: the close failed:", error);
					process.exit(1);
				},
			);
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, close);
	const kept = await keptPort(dataDir);
	const server = await startServer(
		{
			dataDir,
			roots: [
				{ path: PLUGINS, required: true },
				{ path: join(dataDir, "plugins"), required: false },
			],
			port: port ?? kept.port,
			version: version(),
			worker: WORKER,
			onStop: close,
			onError: (error) => console.error(`p3: ${error.kind}:`, error.error),
		},
		context,
	);
	started.resolve(server);
	if (port === undefined && !kept.kept) await keepPort(dataDir, server.port);
	// A supervisor hears that the server listens; its log gets no owner link (`p3` prints a fresh one).
	const supervised = process.send !== undefined;
	const link = supervised ? "" : `. Open ${await ownerLink(dataDir, server.port)}`;
	console.log(`p3 on ${server.dataDir}, port ${server.port}${link}`);
	process.send?.("listening");
}

/** Starts the server in the background under its supervisor unless it runs, and prints its port and an owner link. */
async function start(path: string, port: number | undefined): Promise<void> {
	const dataDir = await openDataDir(path);
	let record = await running(dataDir);
	if (record === undefined) {
		const server = [...COMMAND, "server", "--dir", dataDir, ...(port === undefined ? [] : ["--port", String(port)])];
		spawn(process.execPath, [...SUPERVISOR, dataDir, ...server], { detached: true, stdio: "ignore" }).unref();
		const deadline = Date.now() + START_MS;
		while (record === undefined && Date.now() < deadline) {
			await sleep(50);
			record = await running(dataDir);
		}
		if (record === undefined) {
			throw new Error(`p3: the server did not start; see ${join(dataDir, "logs", "server.log")}`);
		}
	}
	console.log(`p3 on ${dataDir}, port ${record.port}. Open ${await ownerLink(dataDir, record.port)}`);
}

/**
 * Stops the server and its supervisor: the server is asked over HTTP as the owner (its supervisor ends with it), a
 * server that does not answer is signalled; returns once both are gone.
 */
async function stop(path: string): Promise<void> {
	const dataDir = await realpath(path).catch(() => undefined);
	const record = dataDir === undefined ? undefined : await running(dataDir);
	const supervisor = dataDir === undefined ? undefined : await supervisorPid(dataDir);
	if (dataDir === undefined || (record === undefined && supervisor === undefined)) {
		console.log("not running");
		return;
	}
	const asked = record === undefined ? undefined : await ask(dataDir, record.port, "/_p3/stop").catch(() => undefined);
	if (asked?.ok !== true) {
		if (supervisor !== undefined) signal(supervisor, "SIGTERM");
		else if (record !== undefined) signal(record.pid, "SIGTERM");
	}
	const deadline = Date.now() + STOP_MS;
	while ((await running(dataDir)) !== undefined || (await supervisorPid(dataDir)) !== undefined) {
		if (Date.now() > deadline) {
			if (record !== undefined) signal(record.pid, "SIGKILL");
			if (supervisor !== undefined) signal(supervisor, "SIGKILL");
			break;
		}
		await sleep(50);
	}
	console.log("stopped");
}

/** Says whether the server runs, and what it is. */
async function status(path: string): Promise<void> {
	const dataDir = await realpath(path).catch(() => path);
	const record = await running(dataDir);
	if (record === undefined) {
		const supervisor = await supervisorPid(dataDir);
		console.log(`${supervisor === undefined ? "not running" : "starting"}\n  data directory  ${dataDir}`);
		process.exitCode = 1;
		return;
	}
	const rows = [
		["data directory", dataDir],
		["port", record.port],
		["pid", record.pid],
		["version", record.version],
		["started", new Date(record.startedAt).toISOString()],
	];
	console.log(["running", ...rows.map(([name, value]) => `  ${String(name).padEnd(16)}${value}`)].join("\n"));
}

/** Lists the default Pi (once it started) and the named ones, each with its state, port and data directory. */
async function list(): Promise<void> {
	const rows: string[][] = [];
	for (const pi of [{ name: "(default)", dataDir: defaultDataDir() }, ...(await namedPis())]) {
		const dataDir = await realpath(pi.dataDir).catch(() => undefined);
		// A Pi is there once it started: it has its config then.
		const config = dataDir === undefined ? undefined : await readConfig(dataDir);
		if (dataDir === undefined || config === undefined) continue;
		const record = await running(dataDir);
		const state =
			record !== undefined ? "running" : (await supervisorPid(dataDir)) !== undefined ? "starting" : "stopped";
		rows.push([pi.name, state, String(record?.port ?? config.port ?? "-"), dataDir]);
	}
	if (rows.length === 0) console.log("no Pi yet: `p3` starts the default one");
	const width = (column: number): number => Math.max(...rows.map((row) => row[column]!.length));
	for (const [name, state, port, dir] of rows) {
		console.log(`${name!.padEnd(width(0))}  ${state!.padEnd(width(1))}  ${port!.padEnd(width(2))}  ${dir}`);
	}
}

/** The record of the server running on `dataDir`: its lock is held and `running.json` is there; else `undefined`. */
async function running(dataDir: string): Promise<ServerRecord | undefined> {
	if (!(await held(serverLock(dataDir)))) return undefined;
	const text = await readFile(serverFile(dataDir), "utf8").catch(() => undefined);
	// A trust boundary: a file. A server that holds the lock but has not listened yet has none.
	return text === undefined ? undefined : (JSON.parse(text) as ServerRecord);
}

/** The pid of the supervisor running on `dataDir`, if one runs. */
async function supervisorPid(dataDir: string): Promise<number | undefined> {
	if (!(await held(supervisorLock(dataDir)))) return undefined;
	const text = await readFile(supervisorFile(dataDir), "utf8").catch(() => undefined);
	// A trust boundary: a file.
	return text === undefined ? undefined : (JSON.parse(text) as { readonly pid: number }).pid;
}

/** Whether another process holds the lock `name`. */
async function held(name: string): Promise<boolean> {
	const lock = await processLock(name, withAbortSignal(AbortSignal.timeout(50), context)).catch(() => undefined);
	if (lock === undefined) return true;
	await lock.release();
	return false;
}

/** A fresh owner link from the server on `port`, asked with the owner token file (written once the server listens). */
async function ownerLink(dataDir: string, port: number): Promise<string> {
	const deadline = Date.now() + 5000;
	for (;;) {
		const answer = await ask(dataDir, port, "/_p3/owner/link").catch(() => undefined);
		if (answer?.ok === true) return ((await answer.json()) as { readonly link: string }).link;
		if (Date.now() > deadline) throw new Error(`p3: the server on port ${port} gave no owner link`);
		await sleep(50);
	}
}

/** Posts to `path` on the server on `port` as the owner (the owner token file's token as a bearer). */
async function ask(dataDir: string, port: number, path: string): Promise<Response> {
	const token = (await readFile(join(dataDir, "owner-token"), "utf8")).trim();
	return fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(5000),
	});
}

/** Sends `name` to `pid`; one that left meanwhile is fine. */
function signal(pid: number, name: NodeJS.Signals): void {
	try {
		process.kill(pid, name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A command line p3 does not understand: the usage, exit code 2. */
function usage(): never {
	console.error(USAGE);
	process.exit(2);
}
