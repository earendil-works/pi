// The `p3` command as a user runs it: launched from source as processes of its own, on a temporary home (a Pi lives
// in `~/.pi/p3/<name>/`, the default one is `default`), each case with its own Pi. The command asks the server and its
// supervisor over their sockets in the data directory; the cases include what a crash leaves behind, a server that
// does not stop or does not answer, a store that fails, two starts at once and the supervisor's waits. The cases run
// at once: each has its own home, so nothing but the machine is shared.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { processLock } from "@earendil-works/chord/workers/child";
import { COMMAND, SUPERVISOR } from "../src/install.ts";
import { ask, supervisorSocket } from "../src/local-socket.ts";
import { alive, launch } from "./support.ts";
import { eventually } from "./until.ts";

const run = promisify(execFile);

/** What `p3` printed and its exit code. */
type Ran = { readonly code: number; readonly out: string };

/**
 * A temporary home for the case `t`, removed after it with every Pi the case left running stopped: `p3(...args)` runs
 * the command with it, `pids()` reads the default Pi's server and supervisor pids from `p3 status`.
 */
async function homeOf(t: TestContext) {
	const home = await mkdtemp(join(tmpdir(), "p3-home-"));
	const p3 = async (...args: string[]): Promise<Ran> => {
		try {
			const env = { ...process.env, HOME: home };
			const { stdout } = await run(process.execPath, [...COMMAND, ...args], { env, timeout: 60_000 });
			return { code: 0, out: stdout };
		} catch (error) {
			const failed = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string };
			return { code: failed.code ?? 1, out: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
		}
	};
	t.after(async () => {
		await p3("stop", "--wait", "1");
		await p3("stop", "--pi", "two", "--wait", "1");
		await rm(home, { recursive: true, force: true });
	});
	const pids = async () => {
		const { out } = await p3("status");
		const pid = /^\s+pid\s+(\d+)$/m.exec(out)?.[1];
		assert.ok(pid !== undefined, out);
		const supervisor = /^\s+supervisor\s+(\d+)$/m.exec(out)?.[1];
		return { pid: Number(pid), supervisor: supervisor === undefined ? undefined : Number(supervisor) };
	};
	return { home, p3, pids, env: { ...process.env, HOME: home }, dataDir: join(home, ".pi", "p3", "default") };
}

/** A foreground `p3 server` on the default Pi of `home`, killed after the case `t` (continued first if stopped). */
async function foreground(t: TestContext, home: { readonly env: NodeJS.ProcessEnv; readonly dataDir: string }) {
	const launched = await launch(COMMAND, home.dataDir, home.env);
	t.after(() => {
		if (!alive(launched.pid)) return;
		process.kill(launched.pid, "SIGCONT");
		process.kill(launched.pid, "SIGKILL");
	});
	return launched;
}

describe("the p3 command", { concurrency: true }, () => {
	it("starts a Pi in the background once, prints an owner link, says it runs, and stops it", async (t) => {
		const { p3 } = await homeOf(t);
		const first = await p3("--port", "0");
		assert.equal(first.code, 0, first.out);
		const port = /port (\d+)\. Open http:\/\/127\.0\.0\.1:(\d+)\/_p3\/owner#/.exec(first.out);
		assert.ok(port !== null && port[1] === port[2], first.out);
		// A second start finds it running: the same port, a fresh link.
		const second = await p3();
		assert.match(second.out, new RegExp(`port ${port[1]}\\.`));
		assert.notEqual(second.out, first.out);
		const status = await p3("status", "--pi", "default");
		assert.equal(status.code, 0);
		assert.match(status.out, /running/);
		assert.match(status.out, new RegExp(`port\\s+${port[1]}`));
		assert.match(status.out, /version\s+\d/);
		// A Pi first started with `--port` is listed (its config is made, without the port).
		assert.match((await p3("list")).out, new RegExp(`default\\s+running\\s+${port[1]}`));
		assert.equal((await p3("stop")).out.trim(), "stopped");
		const after = await p3("status");
		assert.equal(after.code, 1);
		assert.match(after.out, /not running/);
	});

	it("keeps a named Pi's port across starts, lists the Pis and restarts one", async (t) => {
		const { home, p3 } = await homeOf(t);
		const started = await p3("--pi", "two");
		assert.equal(started.code, 0, started.out);
		const port = /port (\d+)\./.exec(started.out)?.[1];
		assert.ok(port !== undefined);
		// The server keeps its port a moment after it answers that it runs.
		const kept = await eventually(
			async () => JSON.parse(await readFile(join(home, ".pi", "p3", "two", "pi.json"), "utf8")) as { port?: number },
			({ port }) => port !== undefined,
		);
		assert.equal(String(kept.port), port);
		const list = await p3("list");
		assert.match(list.out, new RegExp(`two\\s+running\\s+${port}`));
		const restarted = await p3("restart", "--pi", "two");
		assert.equal(restarted.code, 0, restarted.out);
		assert.match(restarted.out, new RegExp(`port ${port}\\.`));
		await p3("stop", "--pi", "two");
		assert.match((await p3("list")).out, new RegExp(`two\\s+stopped\\s+${port}`));
	});

	it("refuses a command line it does not understand", async (t) => {
		const { p3 } = await homeOf(t);
		assert.equal((await p3("bogus")).code, 2);
		assert.equal((await p3("--pi", "Not A Name")).code, 2);
		assert.equal((await p3("status", "--port", "1")).code, 2);
		assert.equal((await p3("status", "--wait", "1")).code, 2);
	});

	it("refuses a second server on a data directory that has one", async (t) => {
		const { p3 } = await homeOf(t);
		assert.equal((await p3("--port", "0")).code, 0);
		const second = await p3("server", "--port", "0");
		assert.equal(second.code, 1);
		assert.match(second.out, /another server runs/);
	});

	it("starts a crashed server again under its supervisor", async (t) => {
		const { p3, pids } = await homeOf(t);
		assert.equal((await p3("--port", "0")).code, 0);
		const { pid, supervisor } = await pids();
		process.kill(pid, "SIGKILL");
		const after = await eventually(
			() => pids(),
			(found) => found.pid !== pid,
		);
		assert.equal(after.supervisor, supervisor);
	});

	it("clears the sockets a killed server and supervisor left, at the next start", async (t) => {
		const { home, p3, pids } = await homeOf(t);
		assert.equal((await p3("--port", "0")).code, 0);
		const { pid, supervisor } = await pids();
		process.kill(supervisor!, "SIGKILL");
		process.kill(pid, "SIGKILL");
		await eventually(
			async () => alive(pid) || alive(supervisor!),
			(lives) => !lives,
		);
		await access(join(home, ".pi", "p3", "default", "server.sock"));
		assert.match((await p3("status")).out, /not running/);
		const again = await p3("--port", "0");
		assert.equal(again.code, 0, again.out);
	});

	// Opus, review round 2 (N8): a kill was reported as "stopped".
	it("kills a server that does not stop, with its supervisor, and says so", async (t) => {
		const { p3, pids } = await homeOf(t);
		assert.equal((await p3("--port", "0")).code, 0);
		const { pid, supervisor } = await pids();
		process.kill(pid, "SIGSTOP");
		const stopped = await p3("stop", "--wait", "1");
		assert.equal(stopped.out.trim(), "killed", stopped.out);
		assert.ok(!alive(pid) && !alive(supervisor!));
	});

	// Opus, review round 2 (B1, M16): nothing failed when the server's socket answered a stop without stopping.
	it("stops a foreground server on its socket's command, cleanly", async (t) => {
		const home = await homeOf(t);
		const server = await foreground(t, home);
		// Not "killed": the server stopped on its own within the wait.
		const stopped = await home.p3("stop", "--wait", "5");
		assert.equal(stopped.out.trim(), "stopped", stopped.out);
		await eventually(
			() => alive(server.pid),
			(lives) => !lives,
		);
	});

	// Sol (S1), Astra (S1) and Opus (S5), review round 2: a foreground server that did not answer was reported "not
	// running" with exit 0 while it still held the data directory, and `p3 list` threw on it.
	it("says a hung foreground server does not answer, never that it is gone: stop fails, status and list say so", async (t) => {
		const home = await homeOf(t);
		const server = await foreground(t, home);
		process.kill(server.pid, "SIGSTOP");
		const stopped = await home.p3("stop", "--wait", "0.5");
		assert.equal(stopped.code, 1, stopped.out);
		assert.match(stopped.out, /does not answer.*it was not stopped/);
		assert.ok(alive(server.pid));
		const [status, list] = await Promise.all([home.p3("status"), home.p3("list")]);
		assert.deepEqual([status.code, status.out.split("\n")[0]], [1, "not answering"]);
		assert.match(list.out, /^default\s+not answering\s/m);
		// `--wait 0` would disable the asks' timeouts: refused.
		assert.equal((await home.p3("stop", "--wait", "0")).code, 2);
		process.kill(server.pid, "SIGCONT");
		assert.equal((await home.p3("stop")).out.trim(), "stopped");
	});

	// Astra, review round 2 (S2): of two `p3` started at once on an empty Pi, the one whose supervisor lost the
	// socket to the other's said "the server did not start".
	it("starts once when two `p3` start the Pi at once; both print its port", async (t) => {
		const { p3 } = await homeOf(t);
		const both = await Promise.all([p3("--port", "0"), p3("--port", "0")]);
		const ports = both.map(({ code, out }) => {
			assert.equal(code, 0, out);
			return /port (\d+)\./.exec(out)?.[1];
		});
		assert.equal(ports[0], ports[1]);
	});

	// Astra (S2) and Opus (S6), review round 2: a stop the supervisor answered before it had started its server was
	// ignored; it started the server afterwards and ran on.
	it("a supervisor asked to stop while it starts ends without starting its server", async (t) => {
		const { home } = await homeOf(t);
		const dataDir = join(home, "supervised");
		await mkdir(dataDir, { mode: 0o700 });
		const started = join(home, "started");
		// A "server" that marks its start and never ends: only a stop ends the supervisor then.
		const server = [
			"-e",
			`require("node:fs").writeFileSync(${JSON.stringify(started)}, ""); setInterval(() => {}, 1000)`,
		];
		// Holding the guard of the supervisor's socket keeps it before its socket is in place, listening on its
		// temporary name (`local-socket.ts`): the stop reaches it there, at the earliest moment it can.
		const guard = await processLock(`p3-socket:${supervisorSocket(dataDir)}`, context);
		const supervisor = spawn(process.execPath, [...SUPERVISOR, dataDir, ...server], { stdio: "ignore" });
		t.after(() => supervisor.kill("SIGKILL"));
		const exited = new Promise<number | null>((resolve) => supervisor.once("exit", resolve));
		try {
			const temporary = await eventually(
				async () => (await readdir(dataDir)).find((name) => name.startsWith(".")),
				(found) => found !== undefined,
			);
			assert.deepEqual(await ask(join(dataDir, temporary!), { kind: "stop" }), { kind: "stopping" });
		} finally {
			await guard.release();
		}
		const code = await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000, "runs on"))]);
		assert.equal(code, 0);
		await assert.rejects(access(started), { code: "ENOENT" });
	});

	// Opus, review round 2 (B1, M23; N7): the supervisor's wait after a crash, doubled for each crash in a row. Read
	// from the supervisor's log, whose times are the supervisor's own: the test's polling adds nothing to them.
	it("waits 1 s before starting a crashed server again, then 2 s after the next crash", async (t) => {
		const { p3, pids, dataDir } = await homeOf(t);
		assert.equal((await p3("--port", "0")).code, 0);
		let { pid } = await pids();
		for (const _ of [1, 2]) {
			process.kill(pid, "SIGKILL");
			const old = pid;
			pid = (await eventually(pids, (found) => found.pid !== old, 30_000)).pid;
		}
		const log = await readFile(join(dataDir, "logs", "server.log"), "utf8");
		const said = [
			...log.matchAll(
				/^(\S+) supervisor: (?:the server exited with \d+; starting it again in (\d+) ms|the server starts)/gm,
			),
		];
		const lines = said.map(([, at, delay]) => ({
			at: Date.parse(at!),
			delay: delay === undefined ? undefined : Number(delay),
		}));
		// Started, crashed, started, crashed, started.
		assert.deepEqual(
			lines.map(({ delay }) => delay),
			[undefined, 1000, undefined, 2000, undefined],
		);
		for (const index of [1, 3]) {
			const waited = lines[index + 1]!.at - lines[index]!.at;
			assert.ok(waited >= lines[index]!.delay!, `waited ${waited} ms of ${lines[index]!.delay} ms`);
		}
	});

	// Sol, review round 2 (S2; D10): a failed store left the server answering "running" on a closed host.
	it("ends a server whose store failed, and its supervisor starts it again", async (t) => {
		const { p3, pids, dataDir } = await homeOf(t);
		const first = await p3("--port", "0");
		assert.equal(first.code, 0, first.out);
		const link = new URL(/Open (\S+)/.exec(first.out)![1]!);
		const { pid, supervisor } = await pids();
		// Another connection holds the store's write lock: the server's next commit fails after SQLite's busy wait.
		const blocker = new DatabaseSync(join(dataDir, "server", "store.sqlite"), { timeout: 0 });
		blocker.exec("BEGIN IMMEDIATE");
		try {
			// A sign-in commits.
			await fetch(`${link.origin}/_p3/owner`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: link.hash.slice(1) }),
			}).catch(() => undefined);
		} finally {
			blocker.exec("ROLLBACK");
			blocker.close();
		}
		const after = await eventually(pids, (found) => found.pid !== pid, 20_000);
		assert.equal(after.supervisor, supervisor);
		const log = await readFile(join(dataDir, "logs", "server.log"), "utf8");
		assert.match(log, /storage_failed/);
		assert.match(log, /the server exited with 1/);
	});

	// Opus (N10) and Astra (S6), review round 2: `stop` and `status` asked the sockets of a data directory others could
	// have written to, and `stop` signalled the pids their answers named.
	it("refuses to ask the sockets of a data directory that is not private", async (t) => {
		const { p3, dataDir } = await homeOf(t);
		assert.equal((await p3("--port", "0")).code, 0);
		await chmod(dataDir, 0o755);
		for (const command of ["status", "stop", "apply"]) {
			const refused = await p3(command);
			assert.equal(refused.code, 1, command);
			assert.match(refused.out, /is not private/, command);
		}
		await chmod(dataDir, 0o700);
	});

	// D11: an apply is the control plugin's command over the socket.
	it("applies the changed plugins with `p3 apply`, and fails on a Pi that does not run", async (t) => {
		const { p3 } = await homeOf(t);
		assert.equal((await p3("apply")).code, 1);
		assert.equal((await p3("--port", "0")).code, 0);
		const applied = await p3("apply");
		assert.equal(applied.code, 0, applied.out);
		assert.match(applied.out, /^applied$/m);
	});

	// Opus, review round 2 (N12): the server's log kept a looser mode it had.
	it("keeps the server's log private, also when it existed looser", async (t) => {
		const { p3, dataDir } = await homeOf(t);
		await mkdir(join(dataDir, "logs"), { recursive: true });
		await writeFile(join(dataDir, "logs", "server.log"), "");
		await chmod(join(dataDir, "logs", "server.log"), 0o644);
		assert.equal((await p3("--port", "0")).code, 0);
		assert.equal((await stat(join(dataDir, "logs", "server.log"))).mode & 0o777, 0o600);
	});

	it("fails at once when the server cannot start, without waiting out its start time", async (t) => {
		const { p3 } = await homeOf(t);
		const busy = createServer();
		await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
		try {
			const port = (busy.address() as { readonly port: number }).port;
			const started = Date.now();
			const failed = await p3("--port", String(port));
			assert.equal(failed.code, 1);
			assert.match(failed.out, /did not start/);
			assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
		} finally {
			busy.close();
		}
	});
});
