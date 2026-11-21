// The `p3` command (its usage below). It asks the server and its supervisor over their sockets in the data directory
// (`local-socket.ts`): one that answers runs, and says what it is; one that holds its socket but does not answer is
// hung, never taken for gone.

// First: a Node too old for p3 ends here, before any other module runs.
import "./minimum-node.ts";
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { reportError } from "@earendil-works/p3/v1";
import {
	DEFAULT_PI,
	DEFAULT_PORT,
	dataDirOf,
	existingDataDir,
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
	ASK_MS,
	askServer,
	askSupervisor,
	type NoAnswer,
	type Reply,
	type ServerAnswer,
	type ServerStatus,
	type SupervisorAnswer,
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
  apply      Build the plugins changed since the server started or last applied, and roll them out to it and its workers
  list       The Pis on this machine and their state

Options:
  --pi <name>   The Pi of that name (lower case letters, digits, - and _); "default" is the default Pi
  --dir <path>  A Pi in any directory
  --port <n>    The port for this start, on 127.0.0.1 (0: a free one). Without it a Pi listens on its own port:
                ${DEFAULT_PORT} for the default Pi, else a free one taken at its first start and kept
  --wait <s>    For stop and restart: how long the server gets to stop before it is killed (at least 1; default 10)
  --version     Print p3's version
  --help        Print this help`;

/** How long a background start may take. */
const START_MS = 30_000;

/** How long a stop waits by default before the server, its supervisor and its workers are killed, and then for the kill. */
const STOP_MS = 10_000;

/** How long an apply may take: it builds every changed plugin and reloads every running worker. */
const APPLY_MS = 5 * 60_000;

/** No holder of a socket (also for a data directory that does not exist). */
const NONE = { kind: "none" } as const;

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
	// The data directory's sockets would be named pipes there, which authenticate nobody.
	if (process.platform === "win32") {
		console.error("p3 does not run on Windows yet (ERNDL-1059)");
		process.exit(1);
	}
	// A trust boundary: the command line.
	const starts = command === "start" || command === "server" || command === "restart";
	if (rest.length > 0 || (flags.pi !== undefined && flags.dir !== undefined)) usage();
	if (flags.pi !== undefined && !isPiName(flags.pi)) usage();
	if (flags.port !== undefined && !(starts && /^\d{1,5}$/.test(flags.port) && Number(flags.port) <= 65535)) usage();
	const stops = command === "stop" || command === "restart";
	// At least 1 s: a shorter wait would give a healthy server's first answer no time, and kill it unasked.
	if (flags.wait !== undefined && !(stops && /^\d{1,4}(\.\d+)?$/.test(flags.wait) && Number(flags.wait) >= 1)) usage();
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
		else if (command === "apply") await apply(dataDir);
		else if (command === "list") await list();
		else usage();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

/**
 * Runs the server in the foreground until a signal or the owner's stop closes it (exit 0), or its store fails (exit
 * 1: a supervisor starts it again).
 */
async function serve(path: string, port: number | undefined): Promise<void> {
	const dataDir = await openDataDir(path);
	const started = Promise.withResolvers<RunningServer>();
	const end = (code: number): void =>
		void started.promise
			.then((server) => server.close(context))
			.then(
				() => process.exit(code),
				(error: unknown) => {
					reportError("p3: the close failed", error, context);
					process.exit(1);
				},
			);
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => end(0));
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
			onStop: (why) => end(why.kind === "stopped" ? 0 : 1),
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
	const server = await serverOn(dataDir);
	if (server.kind === "silent") throw new Error(`p3: the server on ${dataDir} does not answer`);
	if (server.kind === "none" && (await supervisorOn(dataDir)).kind === "none") {
		const command = [...COMMAND, "server", "--dir", dataDir, ...(port === undefined ? [] : ["--port", String(port)])];
		supervisor = spawn(process.execPath, [...SUPERVISOR, dataDir, ...command], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		supervisor.unref();
	}
	const running = await untilRunning(dataDir, supervisor);
	console.log(`p3 on ${dataDir}, port ${running.port}. Open ${await ownerLink(dataDir)}`);
}

/**
 * The server on `dataDir` once it runs. Fails at once when nothing holds the data directory's sockets while no
 * supervisor of this command's can still take them: none was spawned, or it exited (a busy port, another server). A
 * supervisor of another `p3` started at the same moment may hold them instead of ours: that one is waited for. Else
 * fails after 30 s.
 */
async function untilRunning(dataDir: string, spawned: ChildProcess | undefined): Promise<Running> {
	let exited = spawned === undefined;
	spawned?.once("exit", () => {
		exited = true;
	});
	const deadline = Date.now() + START_MS;
	for (;;) {
		const server = await serverOn(dataDir);
		if (server.kind === "running") return server;
		if (exited && server.kind === "none" && (await supervisorOn(dataDir)).kind === "none") break;
		if (Date.now() > deadline) break;
		await sleep(50);
	}
	throw new Error(`p3: the server did not start; see ${join(dataDir, "logs", "server.log")}`);
}

/**
 * Stops the server and its supervisor: the supervisor is asked (it stops its server and starts none again), a server
 * without one is asked itself; whatever is still there after `waitMs` is killed, by the pids its holders answer then.
 * Every ask before the kill shares that one deadline. A server that does not answer and has no supervisor is not
 * stopped: nothing names its process. Returns once both are gone.
 */
async function stop(path: string, waitMs: number): Promise<void> {
	const dataDir = await existingDataDir(path);
	const deadline = Date.now() + waitMs;
	const server = dataDir === undefined ? NONE : await serverOn(dataDir, untilDeadline(deadline));
	const supervisor = dataDir === undefined ? NONE : await supervisorOn(dataDir, untilDeadline(deadline));
	if (dataDir === undefined || (server.kind === "none" && supervisor.kind === "none")) {
		console.log("not running");
		return;
	}
	if (supervisor.kind === "supervising") await askSupervisor(dataDir, { kind: "stop" }, untilDeadline(deadline));
	else if (server.kind !== "silent") await askStop(dataDir, deadline);
	if (await gone(dataDir, deadline)) {
		console.log("stopped");
		return;
	}
	await kill(dataDir);
	if (!(await gone(dataDir, Date.now() + STOP_MS))) throw new Error(`p3: the server on ${dataDir} did not stop`);
	console.log("killed");
}

/**
 * Asks the server on `dataDir` (one without a supervisor) to stop; while it starts it answers its status instead (its
 * commands are not there yet), and is asked again until `deadline`.
 */
async function askStop(dataDir: string, deadline: number): Promise<void> {
	for (;;) {
		const reply = await askServer(dataDir, { kind: "command", name: "stop" }, untilDeadline(deadline));
		if (reply.kind !== "answered" || reply.answer.kind !== "starting" || Date.now() >= deadline) return;
		await sleep(50);
	}
}

/**
 * Kills the holders of `dataDir`'s sockets by the pids they answer now (asked again: a pid from before the wait may be
 * another process's by now): the supervisor with its process group (its server is in it), the server, and each of the
 * server's session workers with its process group (each leads one of its own). A server that does not answer names
 * no workers: they end on their link's disconnect once the server is gone, unless they are stuck. A holder that does
 * not answer and that no answer names is left, with an error.
 */
async function kill(dataDir: string): Promise<void> {
	const [server, supervisor] = await Promise.all([serverOn(dataDir), supervisorOn(dataDir)]);
	if (supervisor.kind === "supervising") signal(-supervisor.pid, "SIGKILL");
	if (server.kind === "running" || server.kind === "starting") {
		signal(server.pid, "SIGKILL");
		for (const worker of server.workers) signal(-worker, "SIGKILL");
	}
	if (supervisor.kind === "silent" || (server.kind === "silent" && supervisor.kind !== "supervising")) {
		const who = supervisor.kind === "silent" ? "supervisor" : "server";
		throw new Error(
			`p3: the ${who} on ${dataDir} does not answer, and nothing names its process; it was not stopped`,
		);
	}
}

/** Whether neither a server nor a supervisor holds its socket on `dataDir` by `deadline`; a hung one counts as there. */
async function gone(dataDir: string, deadline: number): Promise<boolean> {
	for (;;) {
		const server = await serverOn(dataDir, untilDeadline(deadline));
		if (server.kind === "none" && (await supervisorOn(dataDir, untilDeadline(deadline))).kind === "none") return true;
		if (Date.now() >= deadline) return false;
		await sleep(50);
	}
}

/** How long an ask may take to end by `deadline`: at most `ASK_MS`. */
function untilDeadline(deadline: number): number {
	return Math.min(ASK_MS, deadline - Date.now());
}

/** Says whether the server runs, and what it is. */
async function status(path: string): Promise<void> {
	const dataDir = (await existingDataDir(path)) ?? path;
	const server = await serverOn(dataDir);
	if (server.kind !== "running") {
		const state = await stateOf(dataDir, server);
		console.log(`${state === "stopped" ? "not running" : state}\n  data directory  ${dataDir}`);
		process.exitCode = 1;
		return;
	}
	const supervisor = await supervisorOn(dataDir);
	const rows = [
		["data directory", dataDir],
		["port", server.port],
		["pid", server.pid],
		...(supervisor.kind === "supervising" ? [["supervisor", supervisor.pid]] : []),
		["workers", server.workers.length === 0 ? "none" : server.workers.join(" ")],
		["version", server.version],
		["started", new Date(server.startedAt).toISOString()],
	];
	console.log(["running", ...rows.map(([name, value]) => `  ${String(name).padEnd(16)}${value}`)].join("\n"));
}

/** Builds the changed plugins and rolls them out (the control plugin's command `apply`); exit 1 when a step stopped. */
async function apply(path: string): Promise<void> {
	const dataDir = await existingDataDir(path);
	const reply = dataDir === undefined ? NONE : await askServer(dataDir, { kind: "command", name: "apply" }, APPLY_MS);
	if (reply.kind !== "answered" || reply.answer.kind !== "answer") {
		throw new Error(`p3: no apply on ${dataDir ?? path}: ${described(reply)}`);
	}
	// The control plugin's own answer (`plugins/control/server.ts`), printed as it says.
	const applied = reply.answer.value as { readonly lines: readonly string[]; readonly stopped: string | null };
	for (const line of applied.lines) console.log(line);
	if (applied.stopped !== null) throw new Error(`p3: the apply stopped at its ${applied.stopped} step`);
	console.log("applied");
}

/** Lists the Pis of `~/.pi/p3/` that started once, each with its state, port and data directory. */
async function list(): Promise<void> {
	const rows: string[][] = [];
	for (const pi of await pis()) {
		const row = await rowOf(pi.name, pi.dataDir).catch((error: unknown) => [
			pi.name,
			"unknown",
			"-",
			error instanceof Error ? error.message : String(error),
		]);
		if (row !== undefined) rows.push(row);
	}
	if (rows.length === 0) console.log(`no Pi yet: \`p3\` starts the default one (${DEFAULT_PI})`);
	const width = (column: number): number => Math.max(...rows.map((row) => row[column]!.length));
	for (const [name, state, port, dir] of rows) {
		console.log(`${name!.padEnd(width(0))}  ${state!.padEnd(width(1))}  ${port!.padEnd(width(2))}  ${dir}`);
	}
}

/** The Pi `name`'s row of `p3 list`: name, state, port, data directory; `undefined` before its first start. */
async function rowOf(name: string, path: string): Promise<string[] | undefined> {
	const dataDir = await existingDataDir(path);
	// A Pi is there once it started: it has its config then.
	const config = dataDir === undefined ? undefined : await readConfig(dataDir);
	if (dataDir === undefined || config === undefined) return undefined;
	const server = await serverOn(dataDir);
	const port = server.kind === "running" ? server.port : config.port;
	return [name, await stateOf(dataDir, server), String(port ?? "-"), dataDir];
}

/**
 * What `status` and `list` say of the server on `dataDir`: hung, as it says, or, with no server, starting while its
 * supervisor says it supervises (between two starts), not answering when the supervisor is hung, else stopped.
 */
async function stateOf(dataDir: string, server: ServerStatus | NoAnswer): Promise<string> {
	if (server.kind === "silent") return "not answering";
	if (server.kind !== "none") return server.kind;
	const supervisor = await supervisorOn(dataDir);
	if (supervisor.kind === "silent") return "supervisor not answering";
	return supervisor.kind === "supervising" ? "starting" : "stopped";
}

/** A running server's answer to `status`. */
type Running = Extract<ServerStatus, { readonly kind: "running" }>;

/** The supervisor's answer to `status`. */
type Supervising = Extract<SupervisorAnswer, { readonly kind: "supervising" }>;

/** The server on `dataDir` as it says (starting or running), none, or hung (no answer within `ms`). */
async function serverOn(dataDir: string, ms = ASK_MS): Promise<ServerStatus | NoAnswer> {
	const reply = await askServer(dataDir, { kind: "status" }, ms);
	if (reply.kind !== "answered") return reply;
	if (reply.answer.kind === "starting" || reply.answer.kind === "running") return reply.answer;
	throw new Error(`p3: the server on ${dataDir} answered its status with ${described(reply)}`);
}

/** The supervisor on `dataDir` (its pid, its server's), none, or hung (no answer within `ms`). */
async function supervisorOn(dataDir: string, ms = ASK_MS): Promise<Supervising | NoAnswer> {
	const reply = await askSupervisor(dataDir, { kind: "status" }, ms);
	if (reply.kind !== "answered") return reply;
	if (reply.answer.kind === "supervising") return reply.answer;
	throw new Error(`p3: the supervisor on ${dataDir} answered its status with ${described(reply)}`);
}

/** A fresh owner link from the server on `dataDir` (the sign-in plugin's command `owner-link`). */
async function ownerLink(dataDir: string): Promise<string> {
	const reply = await askServer(dataDir, { kind: "command", name: "owner-link" }, ASK_MS);
	if (reply.kind === "answered" && reply.answer.kind === "answer" && typeof reply.answer.value === "string") {
		return reply.answer.value;
	}
	throw new Error(`p3: the server on ${dataDir} gave no owner link (${described(reply)})`);
}

/** A reply for an error message: the answer, or that nobody or a hung holder answered. */
function described(reply: Reply<ServerAnswer | SupervisorAnswer>): string {
	switch (reply.kind) {
		case "none":
			return "nobody holds its socket";
		case "silent":
			return "it does not answer";
		case "answered":
			return JSON.stringify(reply.answer).slice(0, 200);
	}
}

/** Sends `name` to `pid` (a process group for a negative one); one that left meanwhile is fine. */
function signal(pid: number, name: NodeJS.Signals): void {
	try {
		process.kill(pid, name);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

/** A command line p3 does not understand: the usage, exit code 2. */
function usage(): never {
	console.error(USAGE);
	process.exit(2);
}
