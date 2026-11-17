// The `p3` command's cases (`docs/slices/26-release.md`, third part), whichever way p3 is installed: each drives
// launched commands on Pis under a home directory of its own. `commands.test.ts` runs them from source,
// `release.test.ts` from the installed release.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { CODING, Sessions, SessionsList, SessionWorker } from "../plugins/sessions/contract.ts";
import { readConfig } from "../src/kit/config.ts";
import { proofOf } from "../src/kit/identity.ts";
import { holder, takeLock, writeRecord } from "../src/kit/running.ts";
import { MINIMUM_NODE } from "../src/minimum-node.ts";
import { ownerClient } from "./client.ts";
import { send } from "./kit/support.ts";
import { eventually, type Launched, launch, type Ran, run, supervisorsOf, workersOf } from "./launched.ts";

/** p3's command line in a home directory of a test's own. */
export type Cli = {
	/** The home directory: the default Pi is `<home>/.pi/p3`, a named one `<home>/.pi/p3/pis/<name>`. */
	readonly home: string;
	/** A data directory of the test's own for `--dir`. */
	dir(name: string): string;
	/** Runs `p3` with `args` to its end. */
	p3(...args: string[]): Promise<Ran>;
	/** Runs `p3` with `args` to its end, `env` added to its environment (a gate's, `NO_SIGNALS`). */
	p3In(env: NodeJS.ProcessEnv, ...args: string[]): Promise<Ran>;
	/** Runs `p3 server` on `dataDir` in the foreground, on a free port; `gate` holds it at a point of its start. */
	server(dataDir: string, gate?: Gate): Promise<Launched>;
	/** A gate (`gate.ts`) that holds a server at `at`. */
	gate(at: "lock" | "plugins" | "running" | "supervisor" | "supervisor-exit"): Promise<Gate>;
};

/** A gate launched servers stop at (`gate.ts`), each server process once. */
export type Gate = {
	readonly env: NodeJS.ProcessEnv;
	/** Resolves with the pid of the next server held at the gate. */
	held(): Promise<number>;
	/** Lets the servers held so far go on. */
	go(): Promise<void>;
};

/** What takes signals away from a command (`no-signals.ts`): it can stop a server only over HTTP. */
export const NO_SIGNALS: NodeJS.ProcessEnv = {
	NODE_OPTIONS: `--import=${fileURLToPath(new URL("no-signals.ts", import.meta.url))} --disable-warning=ExperimentalWarning`,
};

/** The preload of the gates: run by Node itself, from source and with the release alike. */
const GATE = fileURLToPath(new URL("gate.ts", import.meta.url));

/** A `Cli` over `command` for test `t`: whatever still runs under its home is stopped after the test. */
export async function cli(command: readonly string[], t: TestContext): Promise<Cli> {
	const home = await realpath(await mkdtemp(join(tmpdir(), "p3-home-")));
	// One compile cache for every command of every run: from source a command loads p3's TypeScript, three times
	// faster from the cache (it is keyed by content, so an edit is never served stale).
	const env = { ...process.env, HOME: home, NODE_COMPILE_CACHE: join(tmpdir(), "p3-test-compile-cache") };
	const dirs = new Set<string>();
	const servers: Promise<Launched>[] = [];
	const gates: Gate[] = [];
	const p3In = (more: NodeJS.ProcessEnv, ...args: string[]) =>
		run(command, args, { env: { ...env, ...more }, cwd: home });
	const p3 = (...args: string[]) => p3In({}, ...args);
	// A case that failed half way leaves its servers running, maybe held at a gate: their processes would keep the
	// test runner alive.
	t.after(async () => {
		await Promise.all(gates.map((gate) => gate.go()));
		const launched = await Promise.allSettled(servers);
		await Promise.all(launched.map((one) => (one.status === "fulfilled" ? one.value.close("SIGKILL") : undefined)));
		const named = await readdir(join(home, ".pi", "p3", "pis")).catch(() => []);
		await Promise.all([
			p3("stop"),
			...named.map((name) => p3("stop", "--pi", name)),
			...[...dirs].map((dir) => p3("stop", "--dir", dir)),
		]);
		await rm(home, { recursive: true, force: true });
	});
	return {
		home,
		dir: (name) => {
			dirs.add(join(home, "dirs", name));
			return join(home, "dirs", name);
		},
		p3,
		p3In,
		server: (dataDir, gate) => {
			const server = launch(command, dataDir, { env: { ...env, ...gate?.env }, cwd: home });
			servers.push(server);
			return server;
		},
		gate: async (at) => {
			const dir = await mkdtemp(join(home, "gate-"));
			const options = `--import=${GATE} --disable-warning=ExperimentalWarning`;
			const seen = new Set<number>();
			const holding = async () => Number((await readFile(join(dir, "held"), "utf8").catch(() => "0")) || 0);
			const gate: Gate = {
				env: { P3_TEST_GATE: dir, P3_TEST_GATE_AT: at, NODE_OPTIONS: options },
				held: async () => {
					await eventually(async () => !seen.has(await holding()) && (await holding()) > 0, 20_000);
					const pid = await holding();
					seen.add(pid);
					return pid;
				},
				go: async () => {
					// The one held now too: after a case that failed before it looked, nothing stays held.
					for (const pid of [...seen, await holding()]) await writeFile(join(dir, `go-${pid}`), "");
				},
			};
			gates.push(gate);
			return gate;
		},
	};
}

/** The cases, by what they show. */
export const CASES: Readonly<Record<string, (cli: Cli) => Promise<void>>> = {
	"status says whether a server runs and what it is; a stopped server leaves no record": statusCase,
	"plain p3 starts the server in the background once, and prints a fresh owner link each time": startCase,
	"stop returns once the data directory is free; restart keeps the port and the sessions": stopCase,
	"a crashed server is started again by its supervisor; stop ends both": crashCase,
	"a record whose process exists is not believed while nobody holds the lock": staleCase,
	"a supervisor starting its server: status says so, and plain p3 waits for that server": startingCase,
	"a server that holds the lock is starting: status says so, stop and plain p3 wait for it to run": heldCase,
	"a record of an earlier server naming another process now: that process is never signalled": reusedCase,
	"the record says running only once the owner link is ready: plain p3 gets one at once": readyCase,
	"a supervisor starting its server again after a crash: stop waits for that server to run": restartCase,
	"a signal during the start closes the server once it started": signalCase,
	"stop asks the server over HTTP: it needs no signal, in the foreground and in the background": httpStopCase,
	"two plain p3 at once leave one supervisor: a stop right after leaves nothing that starts again": raceCase,
	"a running record is the server's only once it proves itself: another program, a replayed proof, another run":
		identityCase,
	"the owner token goes only over the connection the proof came over: a server that closes takes it nowhere": swapCase,
	"a question has a deadline and a size: a program that drips or floods holds no command": dripCase,
	"an older Node than p3 supports is refused with one line, before anything runs": oldNodeCase,
	"a busy port fails the start at once, in the foreground and in the background": busyCase,
	"two Pis run side by side: their own ports, sessions and sign-in cookies; stopping one leaves the other": twoCase,
	"a command line p3 does not understand is refused with the usage": usageCase,
};

/** What `p3 status` printed, by row. */
function rows(status: Ran): Record<string, string> {
	const pairs = status.stdout.split("\n").flatMap((line) => {
		const row = /^ {2}(\S.*?) {2,}(\S.*)$/.exec(line);
		return row === null ? [] : [[row[1]!, row[2]!] as const];
	});
	return Object.fromEntries(pairs);
}

/** The server `p3 status` reports on `pi` (`--pi a`, `--dir <path>`, or nothing): its port, pid and data directory. */
async function running(cli: Cli, ...pi: string[]): Promise<{ port: number; pid: number; dataDir: string }> {
	const status = await cli.p3("status", ...pi);
	assert.equal(status.code, 0, status.stdout + status.stderr);
	const row = rows(status);
	return { port: Number(row.port), pid: Number(row.pid), dataDir: row["data directory"]! };
}

/** What plain `p3` (or `restart`, after its stop) printed last: the port and the owner link. */
function started(ran: Ran): { port: number; link: URL } {
	const printed = /^p3 on \S+, port (\d+)\. Open (http:\/\/\S+)\n$/m.exec(ran.stdout);
	assert.ok(printed !== null && ran.code === 0, ran.stdout + ran.stderr);
	return { port: Number(printed[1]), link: new URL(printed[2]!) };
}

/** Posts the owner link's token as its page does: the answer's status and, signed in, the cookie. */
async function signIn(link: URL): Promise<{ status: number; cookie: string }> {
	const body = JSON.stringify({ token: link.hash.slice(1) });
	const answer = await send(Number(link.port), "POST", link.pathname, {
		headers: { "content-type": "application/json" },
		body,
	});
	return { status: answer.status, cookie: String(answer.headers["set-cookie"]).split(";")[0]! };
}

/** A client of the server on `port` of `dataDir`, signed in with the owner token file. */
function client(server: { port: number; dataDir: string }) {
	const reachable = {
		ownerLink: () => `http://127.0.0.1:${server.port}/`,
		ownerTokenFile: join(server.dataDir, "owner-token"),
	};
	return ownerClient(reachable, context);
}

/** The titles of the active sessions of the server `server`. */
async function titles(server: { port: number; dataDir: string }): Promise<string[]> {
	const owner = await client(server);
	const list = await owner.get(SessionsList, { app: CODING, set: "active", view: "test" }, context);
	const found = list.list.value.rows.map((row) => row.title);
	await owner.close(context);
	return found;
}

/** Makes a session titled `title` on `server`. */
async function create(server: { port: number; dataDir: string }, title: string): Promise<void> {
	const owner = await client(server);
	await (await owner.get(Sessions, {}, context)).create({ title }, context);
	await owner.close(context);
}

/** The pid of the process holding `role`'s lock on `dataDir`, once it has said who it is. */
async function pidOf(dataDir: string, role: "server" | "supervisor"): Promise<number | undefined> {
	const found = await holder(dataDir, role, context);
	// A running server's record is only claimed by `holder` (the commands ask the server); the test's own server is it.
	return found.kind === "named" || found.kind === "claimed" ? found.record.pid : undefined;
}

/** Whether `command` is still running `ms` after now: a command that waits does not return meanwhile. */
async function waits(command: Promise<unknown>, ms = 2000): Promise<boolean> {
	return (await Promise.race([command.then(() => false), sleep(ms).then(() => true)])) as boolean;
}

/** Whether process `pid` has a `SIGTERM` waiting (Linux: `ShdPnd` in `/proc/<pid>/status`, signal 15 its bit 14). */
async function pendingSigterm(pid: number): Promise<boolean> {
	const pending = /^ShdPnd:\s*([0-9a-f]+)$/m.exec(await readFile(`/proc/${pid}/status`, "utf8"))?.[1];
	return pending !== undefined && (BigInt(`0x${pending}`) & (1n << 14n)) !== 0n;
}

/**
 * Whether `command` is still running two seconds from now, and no supervisor ran on `dataDir` meanwhile: a command
 * that waits for somebody else's server starts none of its own.
 */
async function waitsAlone(command: Promise<unknown>, dataDir: string): Promise<"waits" | "returned" | "a supervisor"> {
	let settled = false;
	void command.then(() => {
		settled = true;
	});
	for (const deadline = Date.now() + 2000; Date.now() < deadline; await sleep(25)) {
		if (settled) return "returned";
		if ((await supervisorsOf(dataDir)).length > 0) return "a supervisor";
	}
	return settled ? "returned" : "waits";
}

/** Whether process `pid` still runs. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function statusCase(cli: Cli): Promise<void> {
	const dataDir = cli.dir("one");
	const never = await cli.p3("status", "--dir", dataDir);
	assert.deepEqual([never.code, never.stdout], [1, `not running\n  data directory  ${dataDir}\n`]);
	// Asking made nothing.
	assert.deepEqual(await readdir(cli.home), []);
	const before = Date.now();
	const server = await cli.server(dataDir);
	const status = await cli.p3("status", "--dir", dataDir);
	assert.match(status.stdout, /^running\n/);
	const row = rows(status);
	const { id } = (await readConfig(join(dataDir, "pi.json")))!;
	const version = (await cli.p3("--version")).stdout.trim();
	assert.deepEqual(
		[status.code, row.pi, row["data directory"], row.port, row.pid, row.version, row.supervisor],
		[
			0,
			id,
			dataDir,
			new URL(server.ownerLink()).port,
			String(server.pid),
			version,
			"none (the server runs in the foreground)",
		],
	);
	const startedAt = Date.parse(row.started!);
	assert.ok(startedAt >= before - 1000 && startedAt <= Date.now(), row.started);
	// A second server on the directory is refused with a message, not a stack.
	const second = await cli.p3("server", "--dir", dataDir, "--port", "0");
	assert.deepEqual([second.code, second.stdout, second.stderr], [1, "", `p3: another server runs on ${dataDir}\n`]);
	// Plain `p3` finds the server in the foreground, and starts no supervisor beside it (one would run for a second at
	// least, waiting for the server's start that fails).
	assert.equal(started(await cli.p3("--dir", dataDir)).port, Number(row.port));
	assert.deepEqual(await supervisorsOf(dataDir), []);
	await server.close("SIGTERM");
	assert.ok(!(await readdir(dataDir)).includes("server.json"));
	assert.equal((await cli.p3("status", "--dir", dataDir)).code, 1);
}

async function startCase(cli: Cli): Promise<void> {
	// Two at once start one server: the second supervisor finds the directory taken and leaves it alone.
	// On a free port: the default Pi's own (8789) may be another's on this machine, a test's or a real Pi's.
	const [first, same] = (await Promise.all([cli.p3("--port", "0"), cli.p3("--port", "0")])).map(started);
	const server = await running(cli);
	assert.deepEqual([server.port, server.dataDir, same!.port], [first!.port, join(cli.home, ".pi", "p3"), first!.port]);
	const supervisor = Number(rows(await cli.p3("status")).supervisor);
	assert.deepEqual([alive(supervisor), await pidOf(server.dataDir, "supervisor")], [true, supervisor]);
	const second = started(await cli.p3());
	// The same server: nothing was started again.
	assert.deepEqual(await running(cli), server);
	assert.equal(second.port, first!.port);
	// Each link is fresh: the ones before it are dropped, the current one signs in once.
	assert.deepEqual([(await signIn(first!.link)).status, (await signIn(same!.link)).status], [403, 403]);
	assert.deepEqual([(await signIn(second.link)).status, (await signIn(second.link)).status], [200, 403]);
	// The background server prints into its log, without an owner link.
	const log = await readFile(join(server.dataDir, "logs", "server.log"), "utf8");
	assert.ok(log.includes(`p3 on ${server.dataDir}, port ${server.port}\n`) && !log.includes("Open "), log);
}

async function stopCase(cli: Cli): Promise<void> {
	const dataDir = cli.dir("one");
	assert.deepEqual(
		[(await cli.p3("stop", "--dir", dataDir)).stdout, (await readdir(cli.home)).length],
		["not running\n", 0],
	);
	started(await cli.p3("--dir", dataDir));
	const first = await running(cli, "--dir", dataDir);
	await create(first, "Kept");
	const stopped = await cli.p3("stop", "--dir", dataDir);
	assert.deepEqual([stopped.code, stopped.stdout], [0, "stopped\n"]);
	// Free at once: neither lock has a holder a start would wait for, and nothing runs.
	for (const role of ["server", "supervisor"] as const) await (await takeLock(dataDir, role, 0, context))!.release();
	assert.equal(alive(first.pid), false);
	assert.deepEqual(
		[(await cli.p3("stop", "--dir", dataDir)).code, (await cli.p3("status", "--dir", dataDir)).code],
		[0, 1],
	);
	started(await cli.p3("--dir", dataDir));
	const second = await running(cli, "--dir", dataDir);
	const restarted = started(await cli.p3("restart", "--dir", dataDir));
	const third = await running(cli, "--dir", dataDir);
	// Three servers, one port (the Pi's own, taken at its first start), the same sessions.
	assert.equal(new Set([first.pid, second.pid, third.pid]).size, 3);
	assert.deepEqual([second.port, third.port, restarted.port], [first.port, first.port, first.port]);
	assert.deepEqual([alive(second.pid), await titles(third)], [false, ["Kept"]]);
	// A stopped Pi restarts too.
	await cli.p3("stop", "--dir", dataDir);
	assert.equal(started(await cli.p3("restart", "--dir", dataDir)).port, first.port);
}

async function crashCase(cli: Cli): Promise<void> {
	const dataDir = cli.dir("one");
	started(await cli.p3("--dir", dataDir));
	const first = await running(cli, "--dir", dataDir);
	const supervisor = (await pidOf(dataDir, "supervisor"))!;
	await create(first, "Kept");
	// The supervisor held still, so the time between the crash and the next start lasts as long as the test looks.
	process.kill(supervisor, "SIGSTOP");
	try {
		process.kill(first.pid, "SIGKILL");
		// Nobody holds the server's lock once it is dead (its process stays, unreaped, while its parent is held): the
		// record the crash left is not believed, and removed.
		await eventually(async () => (await holder(dataDir, "server", context)).kind === "free");
		assert.ok(!(await readdir(dataDir)).includes("server.json"));
		const between = await cli.p3("status", "--dir", dataDir);
		const restarting = `restarting after a crash (supervisor ${supervisor})\n  data directory  ${dataDir}\n`;
		assert.deepEqual([between.code, between.stdout], [1, restarting]);
	} finally {
		// The supervisor starts it again: another process, the same port, the same sessions.
		process.kill(supervisor, "SIGCONT");
	}
	// Plain `p3` meanwhile waits for that server, beside the same supervisor.
	const restarted = started(await cli.p3("--dir", dataDir));
	const second = await running(cli, "--dir", dataDir);
	assert.notEqual(second.pid, first.pid);
	assert.deepEqual(
		[second.port, restarted.port, await pidOf(dataDir, "supervisor"), await titles(second)],
		[first.port, first.port, supervisor, ["Kept"]],
	);
	assert.match(
		await readFile(join(dataDir, "logs", "server.log"), "utf8"),
		/supervisor: the server exited with 1; starting it again in 1000 ms\n/,
	);
	// A server told to end by a signal of its own ends its supervisor with it: nothing starts it again.
	process.kill(second.pid, "SIGTERM");
	await eventually(() => !alive(second.pid) && !alive(supervisor));
	assert.equal((await cli.p3("status", "--dir", dataDir)).stdout.split("\n")[0], "not running");
	// `stop` between a crash and the next start ends the supervisor, which is all that runs then: it is signalled, and
	// starts no server again. (Held still, the supervisor cannot start one before the signal is there.)
	started(await cli.p3("--dir", dataDir));
	const third = await running(cli, "--dir", dataDir);
	const waiting = (await pidOf(dataDir, "supervisor"))!;
	const starts = async () => (await readFile(join(dataDir, "logs", "server.log"), "utf8")).split("p3 on ").length;
	const before = await starts();
	process.kill(waiting, "SIGSTOP");
	process.kill(third.pid, "SIGKILL");
	await eventually(async () => (await holder(dataDir, "server", context)).kind === "free");
	const stopping = cli.p3("stop", "--dir", dataDir);
	try {
		await eventually(() => pendingSigterm(waiting), 20_000);
	} finally {
		process.kill(waiting, "SIGCONT");
	}
	const stopped = await stopping;
	assert.deepEqual([stopped.code, stopped.stdout], [0, "stopped\n"]);
	await eventually(() => !alive(waiting));
	assert.equal(await starts(), before);
	assert.equal((await cli.p3("status", "--dir", dataDir)).stdout.split("\n")[0], "not running");
	assert.deepEqual(
		(await readdir(dataDir)).filter((name) => name.endsWith(".json")),
		["pi.json"],
	);
}

async function staleCase(cli: Cli): Promise<void> {
	const dataDir = cli.dir("one");
	const server = await cli.server(dataDir);
	const found = await holder(dataDir, "server", context);
	assert.ok(found.kind === "claimed");
	const { pid: _pid, start: _start, ...state } = found.record;
	await server.close();
	// The record of a server that is gone, naming a process that exists (this one, as it wrote it).
	await writeRecord(dataDir, "server", state);
	const status = await cli.p3("status", "--dir", dataDir);
	assert.deepEqual([status.code, status.stdout.split("\n")[0]], [1, "not running"]);
	assert.ok(!(await readdir(dataDir)).includes("server.json"));
	// And a start is not held up by it.
	started(await cli.p3("--dir", dataDir));
}

async function startingCase(cli: Cli): Promise<void> {
	const dataDir = cli.dir("one");
	await mkdir(dataDir, { recursive: true });
	// A supervisor that has not started its server yet, as this process plays it: its lock and its record.
	const lock = (await takeLock(dataDir, "supervisor", 0, context))!;
	try {
		await writeRecord(dataDir, "supervisor", { state: "starting" });
		const status = await cli.p3("status", "--dir", dataDir);
		assert.equal(status.stdout.split("\n")[0], `starting (supervisor ${process.pid})`);
		// Plain `p3` waits for its server instead of calling the directory crashed, and starts no supervisor of its
		// own beside it.
		const waiting = cli.p3("--dir", dataDir);
		assert.equal(await waitsAlone(waiting, dataDir), "waits");
		const server = await cli.server(dataDir);
		const printed = started(await waiting);
		assert.equal(printed.port, Number(new URL(server.ownerLink()).port));
		assert.equal(await pidOf(dataDir, "server"), server.pid);
	} finally {
		await lock.release();
	}
}

// Sol and Astra, review round 2: `stop` answered "not running" (exit 0) while a server held the lock and started, and
// that server went on to run.
async function heldCase(cli: Cli): Promise<void> {
	for (const at of ["lock", "plugins"] as const) {
		// The second a named Pi, which `list` shows once it has its config (made before its plugins are found).
		const dataDir = at === "lock" ? cli.dir(at) : join(cli.home, ".pi", "p3", "pis", at);
		const gate = await cli.gate(at);
		const launching = cli.server(dataDir, gate);
		const pid = await gate.held();
		const status = await cli.p3("status", "--dir", dataDir);
		// Before its first record it has not said who it is; after it, its record names it.
		const starting = at === "lock" ? "starting" : `starting (pid ${pid})`;
		assert.deepEqual([status.code, status.stdout.split("\n")[0]], [1, starting]);
		if (at === "plugins") assert.match((await cli.p3("list")).stdout, /^plugins {2}starting {2}/m);
		// `stop` waits for it to run, then stops it.
		const stopping = cli.p3("stop", "--dir", dataDir);
		assert.ok(await waits(stopping), "stop returned while the server started");
		await gate.go();
		await launching;
		const stopped = await stopping;
		assert.deepEqual([stopped.code, stopped.stdout], [0, "stopped\n"]);
		// Its lock is free once `stop` returns; the process exits right after it released it.
		await eventually(() => !alive(pid));
		await (await takeLock(dataDir, "server", 0, context))!.release();
		// Plain `p3` waits for it to run, and starts no supervisor beside it.
		const again = await cli.gate(at);
		const relaunching = cli.server(dataDir, again);
		await again.held();
		const linking = cli.p3("--dir", dataDir);
		assert.equal(await waitsAlone(linking, dataDir), "waits");
		await again.go();
		const server = await relaunching;
		assert.equal(started(await linking).port, Number(new URL(server.ownerLink()).port));
	}
}

// Astra, review round 2: `status` showed a stale record's pid while a new server started, and `stop` sent SIGTERM to
// the unrelated process that had that pid by then.
async function reusedCase(cli: Cli): Promise<void> {
	const dataDir = cli.dir("one");
	await mkdir(dataDir, { recursive: true });
	const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	try {
		await once(other, "spawn");
		// What a crashed server left: its record, whose pid the system has given to `other` since.
		const left = { pid: other.pid, start: "the crashed server's", state: "running", pi: "0123456789abcdef" };
		await writeFile(
			join(dataDir, "server.json"),
			JSON.stringify({ ...left, port: 1, version: "0.0.1", startedAt: 1 }),
		);
		const gate = await cli.gate("lock");
		const launching = cli.server(dataDir, gate);
		const pid = await gate.held();
		const status = await cli.p3("status", "--dir", dataDir);
		assert.deepEqual([status.code, status.stdout.split("\n")[0]], [1, "starting"]);
		const stopping = cli.p3("stop", "--dir", dataDir);
		assert.ok(await waits(stopping), "stop returned while the server started");
		await gate.go();
		await launching;
		assert.equal((await stopping).code, 0);
		await eventually(() => !alive(pid));
		assert.deepEqual([other.exitCode, other.signalCode], [null, null]);
	} finally {
		other.kill("SIGKILL");
	}
}

// Sol, review round 2: `server.json` said the server ran before its owner link knew the address; plain `p3` asked for
// a link at once and got a 500.
async function readyCase(cli: Cli): Promise<void> {
	const dataDir = cli.dir("one");
	const gate = await cli.gate("running");
	const linking = cli.p3In(gate.env, "--dir", dataDir);
	await gate.held();
	// The server holds still right after its record says `running`: the link it gives now must work.
	const { link } = started(await linking);
	assert.equal((await signIn(link)).status, 200);
	await gate.go();
	assert.equal((await cli.p3("stop", "--dir", dataDir)).code, 0);
}

async function restartCase(cli: Cli): Promise<void> {
	const dataDir = cli.dir("one");
	const gate = await cli.gate("plugins");
	const linking = cli.p3In(gate.env, "--dir", dataDir);
	const first = await gate.held();
	await gate.go();
	started(await linking);
	const supervisor = (await pidOf(dataDir, "supervisor"))!;
	// Its next server holds at the gate too: the supervisor's record says its server ran, the server's that it starts.
	process.kill(first, "SIGKILL");
	const second = await gate.held();
	const status = await cli.p3("status", "--dir", dataDir);
	assert.deepEqual([status.code, status.stdout.split("\n")[0]], [1, `starting (pid ${second})`]);
	const stopping = cli.p3("stop", "--dir", dataDir);
	assert.ok(await waits(stopping), "stop returned while the server started");
	assert.deepEqual([alive(supervisor), alive(second)], [true, true]);
	await gate.go();
	assert.deepEqual(await stopping, { code: 0, stdout: "stopped\n", stderr: "" });
	await eventually(() => !alive(second) && !alive(supervisor));
}

async function signalCase(cli: Cli): Promise<void> {
	const dataDir = cli.dir("one");
	const gate = await cli.gate("plugins");
	const launching = cli.server(dataDir, gate);
	const pid = await gate.held();
	process.kill(pid, "SIGTERM");
	await gate.go();
	// It starts, then closes: its record removed, its lock free. (It may exit before the harness read its owner link.)
	await launching.catch(() => undefined);
	await eventually(() => !alive(pid));
	assert.ok(!(await readdir(dataDir)).includes("server.json"));
	await (await takeLock(dataDir, "server", 0, context))!.release();
}

// The owner, review round 3: `p3 stop` asks the server first, so it needs no process identity (no `ps`) and no signal.
async function httpStopCase(cli: Cli): Promise<void> {
	const [foreground, background] = [cli.dir("foreground"), cli.dir("background")];
	const stopped = { code: 0, stdout: "stopped\n", stderr: "" };
	const server = await cli.server(foreground);
	assert.deepEqual(await cli.p3In(NO_SIGNALS, "stop", "--dir", foreground), stopped);
	// The supervisor ends with its server, which exited 0 after it answered; held before it lets its lock go, it is
	// waited for, not signalled.
	const gate = await cli.gate("supervisor-exit");
	started(await cli.p3In(gate.env, "--dir", background));
	const supervisor = (await pidOf(background, "supervisor"))!;
	const stopping = cli.p3In(NO_SIGNALS, "stop", "--dir", background);
	assert.equal(await gate.held(), supervisor);
	assert.ok(await waits(stopping), "stop returned while the supervisor held its lock");
	await gate.go();
	assert.deepEqual(await stopping, stopped);
	for (const dataDir of [foreground, background]) {
		for (const role of ["server", "supervisor"] as const) {
			await (await takeLock(dataDir, role, 0, context))!.release();
		}
	}
	await eventually(() => !alive(server.pid) && !alive(supervisor));
}

// Found by review round 3's runs: the supervisor that lost the race for the directory waited a second for its lock,
// took it once `stop` had stopped the winner, and started the Pi again.
async function raceCase(cli: Cli): Promise<void> {
	const dataDir = cli.dir("one");
	// The first command's supervisor held before it tries for its lock: the second's wins.
	const gate = await cli.gate("supervisor");
	const first = cli.p3In(gate.env, "--dir", dataDir);
	const loser = await gate.held();
	const [a, b] = [started(await cli.p3("--dir", dataDir)), started(await first)];
	assert.equal(a.port, b.port);
	// The first command ended its own supervisor before it returned: only the winner is left.
	const winner = (await pidOf(dataDir, "supervisor"))!;
	assert.notEqual(winner, loser);
	assert.deepEqual(await supervisorsOf(dataDir), [winner]);
	assert.deepEqual(await cli.p3("stop", "--dir", dataDir), { code: 0, stdout: "stopped\n", stderr: "" });
	assert.deepEqual(await supervisorsOf(dataDir), []);
	for (const role of ["server", "supervisor"] as const) await (await takeLock(dataDir, role, 0, context))!.release();
}

/**
 * A program of the test's own on a port of its own, answering `/_p3/identity` with what `answer` makes of the nonce
 * asked; it records every request it got (its method, path and authorization).
 */
async function impostor(answer: (nonce: string) => object) {
	const got: string[] = [];
	const server = createHttpServer((request, response) => {
		got.push(`${request.method} ${request.url} ${request.headers.authorization ?? "-"}`);
		const nonce = new URL(request.url ?? "/", "http://x").searchParams.get("nonce") ?? "";
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify(answer(nonce)));
	}).listen(0, "127.0.0.1");
	await once(server, "listening");
	return { port: (server.address() as AddressInfo).port, got, close: () => server.close() };
}

// The owner, 2026-11-16: a running record names the server only once the server on its port proves it holds the
// owner token for a nonce of the command's own, and answers the record's run id. The owner token never travels to it
// before. Each record here is a crashed server's, the lock held by a new server (this process) that has not written
// its own yet.
async function identityCase(cli: Cli): Promise<void> {
	const dataDir = cli.dir("one");
	await mkdir(dataDir, { recursive: true });
	const token = "the-owner-token";
	await writeFile(join(dataDir, "owner-token"), `${token}\n`, { mode: 0o600 });
	const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	await once(other, "spawn");
	const run = "00112233445566778899aabbccddeeff";
	const record = { state: "running", run, pi: "0123456789abcdef", version: "0.0.1", startedAt: 1, pid: other.pid };
	const claim = (port: number) => writeFile(join(dataDir, "server.json"), JSON.stringify({ ...record, port }));
	const statusOf = async () => (await cli.p3("status", "--dir", dataDir)).stdout.split("\n")[0];
	const lock = (await takeLock(dataDir, "server", 0, context))!;
	const programs: Awaited<ReturnType<typeof impostor>>[] = [];
	try {
		// A program that echoes the run id (anyone can learn it), without the token: no proof, or one for another nonce.
		// (And one with the token that answers for another pid.)
		const guesses = [
			() => ({ run, pid: other.pid, pi: record.pi }),
			// With the token, the proof, but another pid than the record's (whose `stop` signals).
			(nonce: string) => ({ run, pid: other.pid! + 1, pi: record.pi, proof: proofOf(token, nonce) }),
			() => ({ run, pid: other.pid, pi: record.pi, proof: "0".repeat(64) }),
			() => ({ run, pid: other.pid, pi: record.pi, proof: proofOf(token, "f".repeat(32)) }),
		];
		for (const guess of guesses) {
			const program = await impostor(guess);
			programs.push(program);
			await claim(program.port);
			assert.equal(await statusOf(), "starting");
		}
		// The same with the proof for the nonce asked: the server, as the check says (the one above refused for the proof).
		const proven = await impostor((nonce) => ({ run, pid: other.pid, pi: record.pi, proof: proofOf(token, nonce) }));
		programs.push(proven);
		await claim(proven.port);
		assert.equal(await statusOf(), "running");
		// A new server of another run on the record's port is not that record's server: another Pi's, and this Pi's own
		// (the same token: its record rewritten to name an earlier run).
		const two = cli.dir("two");
		const server = await cli.server(two);
		await claim(Number(new URL(server.ownerLink()).port));
		assert.equal(await statusOf(), "starting");
		const own = await readFile(join(two, "server.json"), "utf8");
		const earlier = { ...(JSON.parse(own) as object), run: "ffeeddccbbaa99887766554433221100" };
		await writeFile(join(two, "server.json"), JSON.stringify(earlier));
		assert.equal((await cli.p3("status", "--dir", two)).stdout.split("\n")[0], "starting");
		await writeFile(join(two, "server.json"), own);
		assert.equal((await cli.p3("status", "--dir", two)).stdout.split("\n")[0], "running");
		// `stop` waits for this directory's lock; it asks and signals nothing it did not prove, and the other server runs on.
		const stopping = cli.p3("stop", "--dir", dataDir);
		await claim(programs[0]!.port);
		assert.ok(await waits(stopping), "stop returned while the lock was held");
		await lock.release();
		assert.equal((await stopping).code, 0);
		assert.deepEqual([other.exitCode, other.signalCode, alive(server.pid)], [null, null, true]);
		// Each was asked who it is, and none got a token. (Anything else on the machine may knock on a port too: a
		// client of another app reconnecting to the port it had; only the token matters.)
		for (const program of programs.slice(0, 4)) {
			assert.ok(
				program.got.some((line) => line.startsWith("GET /_p3/identity?nonce=")) &&
					program.got.every((line) => line.endsWith(" -")),
				program.got.join("; "),
			);
		}
	} finally {
		for (const program of programs) program.close();
		other.kill("SIGKILL");
	}
}

/** A directory with an owner token of the test's own, and the server's lock held, as a new server would hold it. */
async function claimed(cli: Cli, token: string) {
	const dataDir = cli.dir("claimed");
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(dataDir, "owner-token"), `${token}\n`, { mode: 0o600 });
	const lock = (await takeLock(dataDir, "server", 0, context))!;
	const run = "00112233445566778899aabbccddeeff";
	const record = { state: "running", run, pi: "0123456789abcdef", version: "0.0.1", startedAt: 1, pid: process.pid };
	const claim = (port: number) => writeFile(join(dataDir, "server.json"), JSON.stringify({ ...record, port }));
	return { dataDir, lock, run, claim };
}

// Sol and Opus, review round 4: the command proved the server on one connection and sent the owner token on a new
// one. A server that closes frees its port before its record and lock go: a program waiting for the port got the
// token. Here the server answers the proof, closes the connection, and gives its port to such a program after the
// `swap`-th proof.
async function swapCase(cli: Cli): Promise<void> {
	const token = "the-owner-token";
	const { dataDir, lock, run, claim } = await claimed(cli, token);
	try {
		for (const swap of [1, 2]) {
			const taken: string[] = [];
			const program = createHttpServer((request, response) => {
				taken.push(`${request.method} ${request.url} ${request.headers.authorization ?? "-"}`);
				response.end("{}");
			});
			let proofs = 0;
			let port = 0;
			const server = createHttpServer((request, response) => {
				const nonce = new URL(request.url ?? "/", "http://x").searchParams.get("nonce") ?? "";
				const answer = { run, pid: process.pid, pi: "0123456789abcdef", proof: proofOf(token, nonce) };
				response.setHeader("connection", "close");
				response.end(JSON.stringify(answer), () => {
					proofs += 1;
					if (proofs === swap) server.close(() => program.listen(port, "127.0.0.1"));
				});
			}).listen(0, "127.0.0.1");
			await once(server, "listening");
			port = (server.address() as AddressInfo).port;
			await claim(port);
			try {
				// Plain `p3` proves the server (and once more when it asks for the link), then asks for an owner link.
				const before = performance.now();
				const asked = await cli.p3("--dir", dataDir);
				assert.equal(asked.code, 1, asked.stdout);
				// A request on a connection the server closed fails at once; it does not wait out its 10 s.
				assert.ok(performance.now() - before < 8000, `p3 took ${performance.now() - before} ms`);
				const tokens = taken.filter((line) => !line.endsWith(" -"));
				assert.deepEqual(tokens, [], `swap ${swap}: the program got the token`);
			} finally {
				for (const each of [server, program]) {
					each.closeAllConnections();
					each.close();
				}
			}
		}
	} finally {
		await lock.release();
	}
}

// Sol and Opus, review round 4: a command's wait was an inactivity timeout, and the answer had no bound: a program on
// the port that drips a byte at a time held `status` and `stop` for as long as it liked.
async function dripCase(cli: Cli): Promise<void> {
	const { dataDir, lock, claim } = await claimed(cli, "the-owner-token");
	const drip = createHttpServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.write("{");
		const timer = setInterval(() => response.write(" "), 150);
		response.on("close", () => clearInterval(timer));
	}).listen(0, "127.0.0.1");
	let flooded = 0;
	const flood = createHttpServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		const chunk = Buffer.alloc(64 * 1024, 32);
		const pour = (): void => {
			let more = true;
			while (!response.destroyed && more) {
				more = response.write(chunk);
				flooded += chunk.length;
			}
			if (!response.destroyed) response.once("drain", pour);
		};
		pour();
	}).listen(0, "127.0.0.1");
	await Promise.all([once(drip, "listening"), once(flood, "listening")]);
	let held = true;
	try {
		await claim((drip.address() as AddressInfo).port);
		const before = performance.now();
		assert.equal((await cli.p3("status", "--dir", dataDir)).stdout.split("\n")[0], "starting");
		// The question's 2 s, and the command's own start.
		assert.ok(performance.now() - before < 10_000, `status took ${performance.now() - before} ms`);
		// `stop` waits for the lock; its question to the program is bounded, so it sees the lock go.
		const stopping = cli.p3("stop", "--dir", dataDir);
		assert.ok(await waits(stopping), "stop returned while the lock was held");
		await lock.release();
		held = false;
		const released = performance.now();
		assert.equal((await stopping).code, 0);
		assert.ok(performance.now() - released < 10_000, `stop took ${performance.now() - released} ms after the lock`);
		// An answer past its size is cut off: the program poured little more than that before the command left.
		const again = (await takeLock(dataDir, "server", 0, context))!;
		try {
			await claim((flood.address() as AddressInfo).port);
			assert.equal((await cli.p3("status", "--dir", dataDir)).stdout.split("\n")[0], "starting");
			assert.ok(flooded < 8 * 1024 * 1024, `the command read ${flooded} bytes`);
		} finally {
			await again.release();
		}
	} finally {
		for (const server of [drip, flood]) {
			server.closeAllConnections();
			server.close();
		}
		if (held) await lock.release();
	}
}

// The owner, 2026-11-16: p3 enforces its oldest Node at the start (its workers' V8 flags are checked in the Nodes it
// supports).
async function oldNodeCase(cli: Cli): Promise<void> {
	const old = fileURLToPath(new URL("old-node.ts", import.meta.url));
	const env = (version: string) => ({
		P3_TEST_NODE: version,
		NODE_OPTIONS: `--import=${old} --disable-warning=ExperimentalWarning`,
	});
	for (const args of [["--version"], ["status"], ["server", "--dir", cli.dir("old")]]) {
		const ran = await cli.p3In(env("24.3.9"), ...args);
		assert.deepEqual(ran, {
			code: 1,
			stdout: "",
			stderr: `p3: needs Node ${MINIMUM_NODE} or newer; this is Node 24.3.9\n`,
		});
	}
	// Its oldest one is not refused.
	assert.equal((await cli.p3In(env(MINIMUM_NODE), "--version")).code, 0);
}

async function busyCase(cli: Cli): Promise<void> {
	const taken = createServer().listen(0, "127.0.0.1");
	await once(taken, "listening");
	const port = String((taken.address() as AddressInfo).port);
	const [foreground, background] = [cli.dir("foreground"), cli.dir("background")];
	try {
		const message = `p3: port ${port} is in use; pass --port <n> or stop what uses it\n`;
		const before = performance.now();
		const refused = await cli.p3("server", "--dir", foreground, "--port", port);
		assert.deepEqual([refused.code, refused.stdout, refused.stderr], [1, "", message]);
		assert.ok(performance.now() - before < 10_000);
		const unstarted = await cli.p3("--dir", background, "--port", port);
		assert.ok(performance.now() - before < 20_000);
		assert.deepEqual([unstarted.code, unstarted.stdout], [1, ""]);
		assert.equal(unstarted.stderr, `p3: the server on ${background} did not start:\n${message}`);
		// Nothing is left: no record, no holder of either lock.
		for (const dataDir of [foreground, background]) {
			assert.deepEqual(
				(await readdir(dataDir)).filter((name) => name.endsWith(".json")),
				["pi.json"],
			);
			for (const role of ["server", "supervisor"] as const)
				await (await takeLock(dataDir, role, 0, context))!.release();
		}
	} finally {
		// Also when the case failed: a listening socket would keep the test runner alive.
		taken.close();
	}
	// The port was for that start only: the Pi takes its own at the next, and keeps that one. (Not "another port than
	// the busy one": a free port the system picks may be the one just closed.)
	assert.equal((await readConfig(join(background, "pi.json")))?.port, undefined);
	const own = started(await cli.p3("--dir", background)).port;
	assert.equal((await readConfig(join(background, "pi.json")))?.port, own);
}

async function twoCase(cli: Cli): Promise<void> {
	const [a, b] = [started(await cli.p3("--pi", "a")), started(await cli.p3("--pi", "b"))];
	const [serverA, serverB] = [await running(cli, "--pi", "a"), await running(cli, "--pi", "b")];
	assert.deepEqual(
		[serverA.dataDir, serverB.dataDir],
		["a", "b"].map((name) => join(cli.home, ".pi", "p3", "pis", name)),
	);
	assert.notEqual(a.port, b.port);
	// Sessions of their own.
	await create(serverA, "In a");
	assert.deepEqual([await titles(serverA), await titles(serverB)], [["In a"], []]);
	// One browser signed in to both: two cookies on one host, each Pi takes its own.
	const [cookieA, cookieB] = [(await signIn(a.link)).cookie, (await signIn(b.link)).cookie];
	const idOf = async (dataDir: string) => (await readConfig(join(dataDir, "pi.json")))!.id;
	assert.deepEqual(
		[cookieA.split("=")[0], cookieB.split("=")[0]],
		[`p3-${await idOf(serverA.dataDir)}`, `p3-${await idOf(serverB.dataDir)}`],
	);
	assert.notEqual(cookieA.split("=")[0], cookieB.split("=")[0]);
	const asOwner = async (port: number, cookie: string) =>
		(await send(port, "POST", "/_p3/owner/link", { headers: { cookie } })).status;
	const jar = `${cookieA}; ${cookieB}`;
	assert.deepEqual([await asOwner(a.port, jar), await asOwner(b.port, jar)], [200, 200]);
	assert.deepEqual([await asOwner(a.port, cookieB), await asOwner(b.port, cookieA)], [401, 401]);
	// b has a worker running; stopping a leaves b and its worker alone.
	const owner = await client(serverB);
	const session = await (await owner.get(Sessions, {}, context)).create({ title: "In b" }, context);
	await owner.get(SessionWorker, { session }, context);
	const workers = await workersOf(serverB.pid, serverB.dataDir);
	assert.equal(workers.length, 1);
	assert.equal((await cli.p3("stop", "--pi", "a")).code, 0);
	assert.deepEqual([alive(serverA.pid), alive(serverB.pid), ...workers.map(alive)], [false, true, true]);
	assert.deepEqual(await titles(serverB), ["In b"]);
	await owner.close(context);
	const listed = (await cli.p3("list")).stdout.split("\n").map((line) => line.split(/ {2,}/));
	assert.deepEqual(listed, [
		["a", "stopped", String(a.port), serverA.dataDir],
		["b", "running", String(b.port), serverB.dataDir],
		[""],
	]);
	// A named Pi keeps its port.
	assert.equal(started(await cli.p3("--pi", "a")).port, a.port);
}

async function usageCase(cli: Cli): Promise<void> {
	const refused = [
		["--port", ""],
		["--port", " "],
		["--port", "x"],
		["--port", "-1"],
		["--port", "65536"],
		["--port", "1.5"],
		["server", "--port"],
		["status", "--port", "1"],
		["--pi", "Not A Name"],
		["--pi", "../x"],
		["--pi", "a", "--dir", cli.dir("x")],
		["list", "--pi", "a"],
		["server", "extra"],
		["nope"],
		["--nope"],
	];
	const ran = await Promise.all(refused.map((args) => cli.p3(...args)));
	for (const [index, { code, stdout, stderr }] of ran.entries()) {
		assert.deepEqual(
			[code, stdout, stderr.split("\n")[0]],
			[2, "", "Usage: p3 [command] [--pi <name> | --dir <path>] [--port <n>]"],
			refused[index]!.join(" "),
		);
	}
	// Nothing was started or made for any of them.
	assert.deepEqual(await readdir(cli.home), []);
	const help = await cli.p3("--help");
	assert.deepEqual([help.code, help.stderr, help.stdout.split("\n")[0]], [0, "", ran[0]!.stderr.split("\n")[0]]);
	assert.match((await cli.p3("--version")).stdout, /^\d+\.\d+\.\d+\n$/);
	assert.deepEqual((await cli.p3("list")).stdout, "no Pi yet: `p3` starts the default one\n");
}
