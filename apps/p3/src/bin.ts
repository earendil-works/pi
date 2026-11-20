// The `p3` command. `p3 server` runs a Pi's server in the foreground (closed by SIGINT, SIGTERM or the owner's stop);
// plain `p3` starts it in the background under its supervisor unless it runs, and prints an owner link; `p3 stop`
// stops it; `p3 restart` stops, then starts it; `p3 status` says whether it runs; `p3 list` lists the Pis. The command
// asks the server and its supervisor over their sockets in the data directory (`local-socket.ts`): one that answers
// runs, and its answer says what it is. Only the owner's processes reach those sockets, so no token travels.

// First: a Node too old for p3 ends here, before any other module runs.
import "./minimum-node.ts";
import { type ChildProcess, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { reportError } from "@earendil-works/p3/v1";
import {
	DEFAULT_PI,
	DEFAULT_PORT,
	dataDirOf,
	isPiName,
	keepConfig,
	keepPort,
	keptPort,
	openDataDir,
	pis,
	readConfig,
} from "./files.ts";
import { COMMAND, PLUGINS, SUPERVISOR, version, WORKER } from "./install.ts";
import {
	ask,
	type ServerAnswer,
	type ServerRequest,
	type ServerStatus,
	type SupervisorAnswer,
	type SupervisorRequest,
	serverSocket,
	supervisorSocket,
} from "./local-socket.ts";
import { type RunningServer, startServer } from "./server.ts";

const USAGE = `Usage: p3 [command] [--pi <name> | --dir <path>] [--port <n>] [--wait <s>]

A Pi is its data directory: ~/.pi/p3/<name> (--pi; without it the Pi named "default") or any directory (--dir).

Commands:
  (none)     Start the Pi's server in the background unless it runs; print its port and an owner link (also: start)
  server     Run the Pi's server in the foreground
  status     Say whether the Pi's server runs: its port, pid, supervisor, data directory, version and start time
  stop       Stop the Pi's server; returns once it is gone
  restart    Stop, then start in the background
  list       The Pis on this machine and their state

Options:
  --pi <name>   The Pi of that name (lower case letters, digits, - and _); "default" is the default Pi
  --dir <path>  A Pi in any directory
  --port <n>    The port for this start, on 127.0.0.1 (0: a free one). Without it a Pi listens on its own port:
                ${DEFAULT_PORT} for the default Pi, else a free one taken at its first start and kept
  --wait <s>    For stop and restart: how long the server gets to stop before it is killed (default 10)
  --version     Print p3's version
  --help        Print this help`;

/** How long a background start may take. */
const START_MS = 30_000;

/** How long a stop waits by default before the server and its supervisor are killed, and then for the kill. */
const STOP_MS = 10_000;

/** How long a server or supervisor gets to answer the command at most. */
const ASK_MS = 5000;

/** The command line's flags. */
type Flags = { readonly pi?: string; readonly dir?: string; readonly port?: string; readonly wait?: string };

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
				wait: { type: "string" },
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
	const stops = command === "stop" || command === "restart";
	if (flags.wait !== undefined && !(stops && /^\d{1,4}(\.\d+)?$/.test(flags.wait))) usage();
	if (command === "list" && (flags.pi !== undefined || flags.dir !== undefined)) usage();
	const dataDir = dataDirOf(flags);
	const port = flags.port === undefined ? undefined : Number(flags.port);
	const waitMs = flags.wait === undefined ? STOP_MS : Number(flags.wait) * 1000;
	try {
		if (command === "server") await serve(dataDir, port);
		else if (command === "start") await start(dataDir, port);
		else if (command === "restart") {
			await stop(dataDir, waitMs);
			await start(dataDir, port);
		} else if (command === "stop") await stop(dataDir, waitMs);
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
					reportError("p3: the close failed", error, context);
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
			onError: (error) => reportError(`p3: ${error.kind}`, error.error, context),
		},
		context,
	);
	started.resolve(server);
	// A start with `--port` keeps no port, but the Pi is there from its first start on (`p3 list`).
	if (port === undefined && !kept.kept) await keepPort(dataDir, server.port);
	else await keepConfig(dataDir);
	// A supervisor hears that the server listens; its log gets no owner link (`p3` prints a fresh one).
	const supervised = process.send !== undefined;
	const link = supervised ? "" : `. Open ${await ownerLink(dataDir)}`;
	console.log(`p3 on ${server.dataDir}, port ${server.port}${link}`);
	process.send?.("listening");
}

/** Starts the server in the background under its supervisor unless it runs, and prints its port and an owner link. */
async function start(path: string, port: number | undefined): Promise<void> {
	const dataDir = await openDataDir(path);
	let supervisor: ChildProcess | undefined;
	if ((await serverOn(dataDir)) === undefined && (await supervisorOn(dataDir)) === undefined) {
		const server = [...COMMAND, "server", "--dir", dataDir, ...(port === undefined ? [] : ["--port", String(port)])];
		supervisor = spawn(process.execPath, [...SUPERVISOR, dataDir, ...server], { detached: true, stdio: "ignore" });
		supervisor.unref();
	}
	const running = await untilRunning(dataDir, supervisor);
	console.log(`p3 on ${dataDir}, port ${running.port}. Open ${await ownerLink(dataDir)}`);
}

/**
 * The server on `dataDir` once it runs. Fails at once when the supervisor this command spawned exited (a busy port,
 * another server), or when no supervisor runs and no server answers; else after 30 s.
 */
async function untilRunning(dataDir: string, spawned: ChildProcess | undefined): Promise<Running> {
	let exited = false;
	spawned?.once("exit", () => {
		exited = true;
	});
	const deadline = Date.now() + START_MS;
	for (;;) {
		const server = await serverOn(dataDir);
		if (server?.kind === "running") return server;
		const failed = spawned === undefined ? (await supervisorOn(dataDir)) === undefined : exited;
		if ((server === undefined && failed) || Date.now() > deadline) {
			throw new Error(`p3: the server did not start; see ${join(dataDir, "logs", "server.log")}`);
		}
		await sleep(50);
	}
}

/**
 * Stops the server and its supervisor: the supervisor is asked (it stops its server and starts none again), a server
 * without one is asked itself; whatever is still there after `waitMs` is killed. Returns once both are gone.
 */
async function stop(path: string, waitMs: number): Promise<void> {
	const dataDir = await realpath(path).catch(() => undefined);
	// A server that does not answer (hung) is still found through its supervisor.
	const askMs = Math.min(ASK_MS, waitMs);
	const server = dataDir === undefined ? undefined : await serverOn(dataDir, askMs).catch(() => undefined);
	const supervisor = dataDir === undefined ? undefined : await supervisorOn(dataDir);
	if (dataDir === undefined || (server === undefined && supervisor === undefined)) {
		console.log("not running");
		return;
	}
	const stopping = supervisor !== undefined ? supervisorSocket(dataDir) : serverSocket(dataDir);
	await ask(stopping, { kind: "stop" } satisfies ServerRequest & SupervisorRequest).catch(() => undefined);
	if (!(await gone(dataDir, waitMs))) {
		// The pids are the live holders' own answers, never a file a crash left behind.
		for (const pid of new Set([supervisor?.pid, supervisor?.server, server?.pid])) {
			if (typeof pid === "number") signal(pid, "SIGKILL");
		}
		if (!(await gone(dataDir, STOP_MS))) throw new Error(`p3: the server on ${dataDir} did not stop`);
	}
	console.log("stopped");
}

/** Whether neither a server nor a supervisor holds its socket on `dataDir` within `ms`; a hung one counts as there. */
async function gone(dataDir: string, ms: number): Promise<boolean> {
	const there = (found: Promise<unknown>) =>
		found.then(
			(value) => value !== undefined,
			() => true,
		);
	const deadline = Date.now() + ms;
	const askMs = Math.min(ASK_MS, ms);
	while ((await there(serverOn(dataDir, askMs))) || (await there(supervisorOn(dataDir, askMs)))) {
		if (Date.now() > deadline) return false;
		await sleep(50);
	}
	return true;
}

/** Says whether the server runs, and what it is. */
async function status(path: string): Promise<void> {
	const dataDir = await realpath(path).catch(() => path);
	const server = await serverOn(dataDir);
	if (server?.kind !== "running") {
		const starting = server !== undefined || (await supervisorOn(dataDir)) !== undefined;
		console.log(`${starting ? "starting" : "not running"}\n  data directory  ${dataDir}`);
		process.exitCode = 1;
		return;
	}
	const supervisor = await supervisorOn(dataDir);
	const rows = [
		["data directory", dataDir],
		["port", server.port],
		["pid", server.pid],
		...(supervisor === undefined ? [] : [["supervisor", supervisor.pid]]),
		["version", server.version],
		["started", new Date(server.startedAt).toISOString()],
	];
	console.log(["running", ...rows.map(([name, value]) => `  ${String(name).padEnd(16)}${value}`)].join("\n"));
}

/** Lists the Pis of `~/.pi/p3/` that started once, each with its state, port and data directory. */
async function list(): Promise<void> {
	const rows: string[][] = [];
	for (const pi of await pis()) {
		const dataDir = await realpath(pi.dataDir).catch(() => undefined);
		// A Pi is there once it started: it has its config then.
		const config = dataDir === undefined ? undefined : await readConfig(dataDir);
		if (dataDir === undefined || config === undefined) continue;
		const server = await serverOn(dataDir);
		const starting = server?.kind === "starting" || (await supervisorOn(dataDir)) !== undefined;
		const state = server?.kind === "running" ? "running" : starting ? "starting" : "stopped";
		const port = server?.kind === "running" ? server.port : config.port;
		rows.push([pi.name, state, String(port ?? "-"), dataDir]);
	}
	if (rows.length === 0) console.log(`no Pi yet: \`p3\` starts the default one (${DEFAULT_PI})`);
	const width = (column: number): number => Math.max(...rows.map((row) => row[column]!.length));
	for (const [name, state, port, dir] of rows) {
		console.log(`${name!.padEnd(width(0))}  ${state!.padEnd(width(1))}  ${port!.padEnd(width(2))}  ${dir}`);
	}
}

/** A supervisor's answer to `status`. */
type Supervising = Extract<SupervisorAnswer, { readonly kind: "supervising" }>;

/** A running server's answer to `status`. */
type Running = Extract<ServerStatus, { readonly kind: "running" }>;

/** The server on `dataDir` as it says (starting or running), or `undefined` when none holds its socket. */
async function serverOn(dataDir: string, ms = ASK_MS): Promise<ServerStatus | undefined> {
	// The server's own answer (`local-socket.ts`).
	const answer = (await ask(serverSocket(dataDir), { kind: "status" } satisfies ServerRequest, ms)) as
		| ServerAnswer
		| undefined;
	return answer?.kind === "starting" || answer?.kind === "running" ? answer : undefined;
}

/** The supervisor on `dataDir` (its pid, its server's), or `undefined` when none holds its socket. */
async function supervisorOn(dataDir: string, ms = ASK_MS): Promise<Supervising | undefined> {
	// The supervisor's own answer (`local-socket.ts`).
	const answer = (await ask(supervisorSocket(dataDir), { kind: "status" } satisfies SupervisorRequest, ms)) as
		| SupervisorAnswer
		| undefined;
	return answer?.kind === "supervising" ? answer : undefined;
}

/** A fresh owner link from the server on `dataDir` (the sign-in plugin's command `owner-link`), once it runs. */
async function ownerLink(dataDir: string): Promise<string> {
	const deadline = Date.now() + 5000;
	for (;;) {
		const request: ServerRequest = { kind: "command", name: "owner-link" };
		// The server's own answer (`local-socket.ts`); the command's value is the link.
		const answer = (await ask(serverSocket(dataDir), request)) as ServerAnswer | undefined;
		if (answer?.kind === "answer") return String(answer.value);
		if (answer?.kind !== "starting" || Date.now() > deadline) {
			throw new Error(`p3: the server on ${dataDir} gave no owner link (${JSON.stringify(answer ?? "gone")})`);
		}
		await sleep(50);
	}
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
