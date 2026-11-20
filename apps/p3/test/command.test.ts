// The `p3` command as a user runs it: launched from source as processes of its own, on a temporary home (a Pi lives
// in `~/.pi/p3/<name>/`, the default one is `default`), each case with its own Pi. The command asks the server and its
// supervisor over their sockets in the data directory; the cases include what a crash leaves behind and a server
// that does not stop. The cases run at once: each has its own home, so nothing but the machine is shared.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { COMMAND } from "../src/install.ts";
import { alive, eventually } from "./support.ts";

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
	return { home, p3, pids };
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
		const kept = JSON.parse(await readFile(join(home, ".pi", "p3", "two", "pi.json"), "utf8")) as {
			readonly port: number;
		};
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

	it("kills a server that does not stop", async (t) => {
		const { p3, pids } = await homeOf(t);
		assert.equal((await p3("--port", "0")).code, 0);
		const { pid, supervisor } = await pids();
		process.kill(pid, "SIGSTOP");
		const stopped = await p3("stop", "--wait", "1");
		assert.equal(stopped.out.trim(), "stopped", stopped.out);
		assert.ok(!alive(pid) && !alive(supervisor!));
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
