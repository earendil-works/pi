// p3 launched as processes of its own, as a user starts it: from the source checkout (`SOURCE`) or from an installed
// release (`releaseOf`). The tests and the bench drive it only from outside: a server in the foreground by its owner
// link on stdout, its owner token file and a WebSocket; any other command by its exit code and what it printed.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

/** The command that starts p3 from this checkout: Node with the flags that run its TypeScript, and `bin.ts`. */
export const SOURCE: readonly string[] = [
	process.execPath,
	"--conditions=source",
	"--disable-warning=ExperimentalWarning",
	fileURLToPath(new URL("../src/bootstrap/bin.ts", import.meta.url)),
];

/** The command that starts the release installed in `install` (a directory with `node_modules/`). */
export function releaseOf(install: string): readonly string[] {
	return [process.execPath, join(install, "node_modules", "@earendil-works", "p3", "dist", "p3.js")];
}

/** A launched server. */
export type Launched = {
	readonly pid: number;
	readonly dataDir: string;
	/** The owner token file's path. */
	readonly ownerTokenFile: string;
	/** The owner link it printed. */
	ownerLink(): string;
	/** How long it took from the launch to its owner link, in ms: the server listens then. */
	readonly listening: number;
	/** What it wrote to stderr so far. */
	stderr(): string;
	/** The process ids of its running session workers. */
	workers(): Promise<number[]>;
	/** Sends `signal` and resolves once the process exited. */
	close(signal?: NodeJS.Signals): Promise<void>;
};

/** How long a launched server may take to print its owner link. */
const LISTEN_MS = 20_000;

/**
 * Launches `command`'s server in the foreground on `dataDir` with a free port (`--port` in `options.args` names
 * another) and resolves once it printed its owner link; rejects when it exits first, or prints none within
 * `LISTEN_MS` (it is killed then). `options.env` is its whole environment (the caller's by default), `options.cwd`
 * its working directory.
 */
export function launch(
	command: readonly string[],
	dataDir: string,
	options: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string; readonly args?: readonly string[] } = {},
): Promise<Launched> {
	const started = performance.now();
	const { args = ["--port", "0"], ...spawned } = options;
	const child = spawn(command[0]!, [...command.slice(1), "server", "--dir", dataDir, ...args], {
		...spawned,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	let stdout = "";
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		void exited.then(() => reject(new Error(`p3 exited before it listened:\n${stdout}${stderr}`)));
		const late = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`p3 printed no owner link within ${LISTEN_MS} ms:\n${stdout}${stderr}`));
		}, LISTEN_MS);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			const link = /Open (http:\/\/\S+)/.exec(stdout)?.[1];
			if (link === undefined) return;
			clearTimeout(late);
			resolve({
				pid: child.pid!,
				dataDir,
				ownerTokenFile: join(dataDir, "owner-token"),
				ownerLink: () => link,
				listening: performance.now() - started,
				stderr: () => stderr,
				workers: () => workersOf(child.pid!, dataDir),
				close: (signal = "SIGTERM") => closed(child, exited, signal),
			});
		});
	});
}

/** What a command that ran to its end left: its exit code and what it printed. */
export type Ran = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** How long a command may run: one that does not end by then is killed and fails the test. */
const COMMAND_MS = 60_000;

/** Runs `command` with `args` to its end, in `options.env` and `options.cwd` (the caller's by default). */
export function run(
	command: readonly string[],
	args: readonly string[],
	options: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string } = {},
): Promise<Ran> {
	return new Promise((resolve, reject) => {
		const all = [...command.slice(1), ...args];
		execFile(
			command[0]!,
			all,
			{ ...options, timeout: COMMAND_MS, killSignal: "SIGKILL" },
			(error, stdout, stderr) => {
				if (error !== null && typeof error.code !== "number") {
					reject(new Error(`p3 ${args.join(" ")} did not end:\n${stdout}${stderr}`, { cause: error }));
				} else resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr });
			},
		);
	});
}

/**
 * Resolves once `check` holds, asked every 20 ms (what another process does sends this one no event); rejects when
 * it does not within `ms`.
 */
export async function eventually(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
	for (const deadline = Date.now() + ms; !(await check()); await sleep(20)) {
		if (Date.now() > deadline) throw new Error(`eventually: not within ${ms} ms`);
	}
}

/** Sends `signal` to `child` unless it exited already, and waits for its exit. */
async function closed(child: ChildProcess, exited: Promise<void>, signal: NodeJS.Signals): Promise<void> {
	if (child.exitCode === null && child.signalCode === null) child.kill(signal);
	await exited;
}

/**
 * The process ids of the supervisors running on `dataDir` (Linux): processes whose command runs p3's `supervisor.ts`
 * (or the release's `supervisor.js`) with `dataDir` as its argument. A supervisor is detached: it is no one's child.
 */
export async function supervisorsOf(dataDir: string): Promise<number[]> {
	const found: number[] = [];
	for (const pid of (await readdir("/proc")).filter((name) => /^\d+$/.test(name))) {
		const args = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
		const script = args.findIndex((arg) => /\/supervisor\.(ts|js)$/.test(arg));
		if (script >= 0 && args[script + 1] === dataDir) found.push(Number(pid));
	}
	return found;
}

/**
 * The session workers among the children of process `pid` (Linux, Android): those running the worker base of
 * `dataDir`. The server's other child is esbuild's service.
 */
export async function workersOf(pid: number, dataDir: string): Promise<number[]> {
	const workers: number[] = [];
	for (const child of await childrenOf(pid)) {
		const command = await readFile(`/proc/${child}/cmdline`, "utf8").catch(() => "");
		if (command.includes(join(dataDir, "cache", "worker"))) workers.push(child);
	}
	return workers;
}

/**
 * The process ids of the children of process `pid`, from `children` (`/proc/<pid>/task/<pid>/children`, its main
 * thread's, where Node spawns). A kernel without it (Android's: no `CONFIG_PROC_CHILDREN`) is asked through every
 * process's `/proc/<id>/stat`: those whose parent (the 4th field, the 2nd after the last `)`, which closes the command's
 * name, itself free to hold one) is `pid`.
 */
export async function childrenOf(pid: number, children = `/proc/${pid}/task/${pid}/children`): Promise<number[]> {
	const listed = await readFile(children, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (listed !== undefined) return listed.trim().split(" ").filter(Boolean).map(Number);
	const found: number[] = [];
	for (const id of (await readdir("/proc")).filter((name) => /^\d+$/.test(name))) {
		// Gone meanwhile: not a child any more.
		const stat = await readFile(`/proc/${id}/stat`, "utf8").catch(() => undefined);
		if (stat !== undefined && Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === pid) {
			found.push(Number(id));
		}
	}
	return found;
}
