// What the `p3` command does besides running the server in the foreground: `status`, `stop`, `restart`, `list`, and
// plain `p3`, which starts the Pi's server in the background unless it runs and prints a fresh owner link. Each
// function prints for a person and answers the command's exit code. Whether something runs is `src/kit/running.ts`'s
// to say (a record believed only while its lock is held, and only of the process that wrote it), never a file's
// alone. `stop` asks a server that listens over HTTP; it signals only a process that does not answer (or a supervisor
// while no server listens), once its record proves who it is, and waits for one that starts.

import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { Context } from "@earendil-works/chord/context";
import { ask, proven } from "./ask.ts";
import { COMMAND, SUPERVISOR } from "./install.ts";
import { readConfig } from "./kit/config.ts";
import { ifExists, layoutOf, openDataDir } from "./kit/layout.ts";
import { OWNER_LINK_PATH } from "./kit/owner.ts";
import { type Claimed, type Holder, holder, type ProcessId, type Running as RunningRecord } from "./kit/running.ts";
import { STOP_PATH } from "./kit/stop.ts";
import { namedPis } from "./pi.ts";

/**
 * Plain `p3`: starts the server of `path` in the background unless it runs, and prints its port and an owner link.
 * Only where nobody holds the directory does it start a supervisor; a server or a supervisor that starts (or starts
 * the server again after a crash) holds it already, and its server is the one to wait for.
 */
export async function start(path: string, port: number | undefined, context: Context): Promise<number> {
	const dataDir = await openDataDir(path);
	const deadline = Date.now() + START_MS;
	const now = await running(dataDir, deadline, context);
	const idle = now.server.kind === "free" && now.supervisor.kind === "free";
	const logged = (await ifExists(stat(layoutOf(dataDir).log)))?.size ?? 0;
	const ours = idle ? startSupervisor(dataDir, port) : NOT_OURS;
	const server = listening(now.server) ?? (await serverOf(dataDir, ours, logged, deadline, context));
	if (server === undefined) return 1;
	// The link's own question is bounded too (`ask.ts`), also when the start used all of its time.
	const link = await ownerLink(dataDir, server, Math.max(deadline, Date.now() + LINK_MS));
	console.log(`p3 on ${dataDir}, port ${server.port}. Open ${link}`);
	return 0;
}

/** `p3 status`: says whether a server runs on `path` and what it is; 0 when one runs. */
export async function status(path: string, context: Context): Promise<number> {
	const dataDir = await ifExists(realpath(path));
	const { server, supervisor } =
		dataDir === undefined ? NOTHING : await running(dataDir, Date.now() + LOOK_MS, context);
	const record = listening(server);
	if (dataDir === undefined || record === undefined) {
		console.log(`${notListening(server, supervisor)}\n  data directory  ${dataDir ?? path}`);
		return 1;
	}
	const rows = [
		["pi", record.pi],
		["data directory", dataDir],
		["port", record.port],
		["pid", record.pid],
		["version", record.version],
		["started", new Date(record.startedAt).toISOString()],
		["supervisor", supervisor.kind === "named" ? supervisor.record.pid : "none (the server runs in the foreground)"],
	];
	console.log(["running", ...rows.map(([name, value]) => `  ${String(name).padEnd(16)}${value}`)].join("\n"));
	return 0;
}

/** What `status` says while no server listens on a data directory: what its server and its supervisor do. */
function notListening(server: ServerHolder, supervisor: Holder<"supervisor">): string {
	if (server.kind === "named") return `starting (pid ${server.record.pid})`;
	if (server.kind === "unnamed") return "starting";
	if (supervisor.kind === "unnamed") return "starting";
	if (supervisor.kind === "free") return "not running";
	const { pid, state } = supervisor.record;
	return state === "starting" ? `starting (supervisor ${pid})` : `restarting after a crash (supervisor ${pid})`;
}

/** How long `stop` waits for a server and its supervisor to go, a start that runs meanwhile included. */
const STOP_MS = 30_000;

/**
 * `p3 stop`: stops what runs on `path` and returns once the data directory's locks are free, so a start right after
 * it finds the directory its own. A server that listens is asked over HTTP (`POST /_p3/stop`, as the owner); only a
 * process that does not answer, or a supervisor while no server listens, is signalled, and only once its record
 * proves who it is. A server or supervisor that is starting is waited for until it runs, or until it is gone.
 */
export async function stop(path: string, context: Context): Promise<number> {
	const dataDir = await ifExists(realpath(path));
	if (dataDir === undefined) {
		console.log("not running");
		return 0;
	}
	const signalled = new Set<number>();
	const asked: Asked = { answered: new Set(), unanswered: new Set(), ending: new Set() };
	let found = false;
	for (const deadline = Date.now() + STOP_MS; ; await sleep(25)) {
		const { server, supervisor } = await running(dataDir, deadline, context);
		if (server.kind === "free" && supervisor.kind === "free") {
			console.log(found ? "stopped" : "not running");
			return 0;
		}
		found = true;
		// Each server that listens is asked first (also one a supervisor started meanwhile); one that answered closes,
		// and its supervisor ends with it.
		const record = listening(server);
		if (record !== undefined && !asked.answered.has(record.pid) && !asked.unanswered.has(record.pid)) {
			const answer = await ask(dataDir, record, { method: "POST", path: STOP_PATH }, deadline);
			if (answer === undefined) asked.unanswered.add(record.pid);
			else if (answer.status !== 200) {
				return failed(`the server on port ${record.port} refused to stop (${answer.status})`);
			} else {
				asked.answered.add(record.pid);
				if (supervisor.kind === "named") asked.ending.add(supervisor.record.pid);
			}
		}
		const target = stopTarget(server, supervisor, asked);
		if (target !== undefined && !signalled.has(target.pid)) {
			signalled.add(target.pid);
			signal(target.pid);
		}
		if (Date.now() > deadline) return failed(`${dataDir} did not stop within ${STOP_MS / 1000} s`);
	}
}

/** Whom `stop` asked over HTTP: the servers that answered and those that did not, and the supervisors of the first. */
type Asked = {
	readonly answered: Set<number>;
	readonly unanswered: Set<number>;
	readonly ending: Set<number>;
};

/**
 * Whom `stop` signals now, a process whose identity its record proves: a supervisor while no server listens (it
 * waits to start one again after a crash, and starts none once signalled), or the supervisor or, in the foreground,
 * the server of a server that did not answer; nobody while a server or a supervisor starts, nor a supervisor whose
 * server answered (it ends with it).
 */
function stopTarget(server: ServerHolder, supervisor: Holder<"supervisor">, asked: Asked): ProcessId | undefined {
	if (server.kind === "unnamed" || (server.kind === "named" && server.record.state === "starting")) return undefined;
	const silent = listening(server);
	if (silent !== undefined && !asked.unanswered.has(silent.pid)) return undefined;
	if (supervisor.kind === "named") {
		const { record } = supervisor;
		return record.state === "running" && !asked.ending.has(record.pid) ? record : undefined;
	}
	return supervisor.kind === "free" ? silent : undefined;
}

/** Sends `SIGTERM` to `pid`; one that left meanwhile is fine (its lock is free then). */
function signal(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

/** `p3 restart`: `stop`, then `start`. */
export async function restart(path: string, port: number | undefined, context: Context): Promise<number> {
	const stopped = await stop(path, context);
	return stopped === 0 ? start(path, port, context) : stopped;
}

/** `p3 list`: the default Pi (once it started) and the named ones, each with its state, port and data directory. */
export async function list(defaultDir: string, context: Context): Promise<number> {
	const rows: string[][] = [];
	for (const pi of [{ name: "(default)", dataDir: defaultDir }, ...(await namedPis())]) {
		const dataDir = await ifExists(realpath(pi.dataDir));
		// A Pi is there once it started: it has its config then.
		const config = dataDir === undefined ? undefined : await readConfig(layoutOf(dataDir).config);
		if (dataDir === undefined || config === undefined) continue;
		const { server, supervisor } = await running(dataDir, Date.now() + LOOK_MS, context);
		const record = listening(server);
		const idle = server.kind === "free" && supervisor.kind === "free";
		const state = record !== undefined ? "running" : idle ? "stopped" : "starting";
		rows.push([pi.name, state, String(record?.port ?? config.port ?? "-"), dataDir]);
	}
	if (rows.length === 0) console.log("no Pi yet: `p3` starts the default one");
	const width = (column: number): number => Math.max(...rows.map((row) => row[column]!.length));
	for (const [name, state, port, dataDir] of rows) {
		console.log(`${name!.padEnd(width(0))}  ${state!.padEnd(width(1))}  ${port!.padEnd(width(2))}  ${dataDir}`);
	}
	return 0;
}

/** Who holds a server's lock, once a `claimed` record was proven or not (`identified`). */
type ServerHolder = Exclude<Holder<"server">, Claimed>;

/** What runs on a data directory: who holds its server's and its supervisor's lock. */
type Running = { readonly server: ServerHolder; readonly supervisor: Holder<"supervisor"> };

/** What runs where there is no data directory. */
const NOTHING: Running = { server: { kind: "free" }, supervisor: { kind: "free" } };

/** The record of the server `server` names once it listens; `undefined` before, and when none runs. */
function listening(server: ServerHolder): RunningRecord | undefined {
	return server.kind === "named" && server.record.state === "running" ? server.record : undefined;
}

/**
 * What runs on `dataDir` (a real path): a server's `running` record believed once the server proved it is that
 * record's (`ask.ts`), asked within `deadline` (ms since the epoch).
 */
async function running(dataDir: string, deadline: number, context: Context): Promise<Running> {
	const server = await holder(dataDir, "server", context);
	const named = async (record: RunningRecord): Promise<ServerHolder> =>
		(await proven(dataDir, record, deadline)) ? { kind: "named", record } : { kind: "unnamed" };
	return {
		server: server.kind === "claimed" ? await named(server.record) : server,
		supervisor: await holder(dataDir, "supervisor", context),
	};
}

/** How long a background start may take before the command gives up on it. */
const START_MS = 30_000;

/** How long `status` and `list` may take to learn who runs on a data directory. */
const LOOK_MS = 5000;

/** How long a running server may take to give the owner link. */
const LINK_MS = 12_000;

/** A supervisor this command started: its pid, whether it exited, and its end. */
type Ours = {
	readonly pid: number | undefined;
	exited(): boolean;
	/** Ends it unless it exited, and resolves once it did. */
	end(): Promise<void>;
};

/** No supervisor of this command's: the one that runs is somebody else's. */
const NOT_OURS: Ours = { pid: undefined, exited: () => true, end: async () => {} };

/** Starts a supervisor of `dataDir`, detached (it outlives the command), its server on `port` for this start. */
function startSupervisor(dataDir: string, port: number | undefined): Ours {
	const command = [...COMMAND, "server", "--dir", dataDir, ...(port === undefined ? [] : ["--port", String(port)])];
	// Detached and, on Windows, without a console window of its own.
	const options = { detached: true, stdio: "ignore", windowsHide: true } as const;
	const spawned = spawn(process.execPath, [...SUPERVISOR, dataDir, ...command], options);
	const exit = Promise.withResolvers<void>();
	let exited = false;
	spawned.once("exit", () => {
		exited = true;
		exit.resolve();
	});
	spawned.unref();
	return {
		pid: spawned.pid,
		exited: () => exited,
		end: async () => {
			// Our own child: its pid is its, no record needed to know. It stops a server it started meanwhile. Waited
			// for with the child counted again: the command would end on an empty event loop otherwise.
			if (!exited) {
				spawned.ref();
				spawned.kill("SIGTERM");
			}
			await exit.promise;
		},
	};
}

/**
 * Waits for the server of `dataDir` to say it runs: its record, or `undefined` (said on stderr, with what the log got
 * after `logged` bytes) once nothing more can come: `ours` exited, and nobody holds either lock. Another command's
 * supervisor may have won the directory over `ours`, or a server in the foreground may start: their server counts,
 * and `ours` is ended then, before it could take the directory over once that server stops.
 */
async function serverOf(
	dataDir: string,
	ours: Ours,
	logged: number,
	deadline: number,
	context: Context,
): Promise<RunningRecord | undefined> {
	for (; Date.now() < deadline; await sleep(25)) {
		// Read before the look at the locks: a supervisor gone by then has no server still to come.
		const gone = ours.exited();
		const { server, supervisor } = await running(dataDir, deadline, context);
		const record = listening(server);
		if (record !== undefined) {
			if (supervisor.kind !== "named" || supervisor.record.pid !== ours.pid) await ours.end();
			return record;
		}
		if (gone && server.kind === "free" && supervisor.kind === "free") break;
	}
	const printed = (await ifExists(readFile(layoutOf(dataDir).log)))?.subarray(logged).toString().trimEnd() ?? "";
	failed(`the server on ${dataDir} did not start:\n${printed}`);
	return undefined;
}

/** A fresh owner link from the server `record` names, asked as the owner, within `deadline` (ms since the epoch). */
async function ownerLink(dataDir: string, record: RunningRecord, deadline: number): Promise<string> {
	const answer = await ask(dataDir, record, { method: "POST", path: OWNER_LINK_PATH }, deadline);
	const { port } = record;
	if (answer === undefined) throw new Error(`the server on port ${port} did not answer`);
	if (answer.status !== 200) throw new Error(`the server on port ${port} gave no owner link (${answer.status})`);
	return (JSON.parse(answer.body) as { readonly link: string }).link;
}

/** Prints `message` as the command's error and answers its exit code. */
function failed(message: string): number {
	console.error(`p3: ${message}`);
	return 1;
}
