// The `p3` command as a user runs it: launched from source as processes of its own, on a temporary home (named Pis
// live under `~/.pi/p3/pis/`), each case with its own Pi.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { COMMAND } from "../src/install.ts";

const run = promisify(execFile);

/** A temporary home for the case; removed afterwards. */
let home: string | undefined;

afterEach(async () => {
	if (home === undefined) return;
	// Every Pi of the case stopped, whatever the case left running.
	await p3("stop").catch(() => {});
	await p3("stop", "--pi", "two").catch(() => {});
	await rm(home, { recursive: true, force: true });
	home = undefined;
});

/** Runs `p3 ...args` with the case's home: its exit code and what it printed. */
async function p3(...args: string[]): Promise<{ readonly code: number; readonly out: string }> {
	home ??= await mkdtemp(join(tmpdir(), "p3-home-"));
	const env = { ...process.env, HOME: home };
	try {
		const { stdout } = await run(process.execPath, [...COMMAND, ...args], { env, timeout: 60_000 });
		return { code: 0, out: stdout };
	} catch (error) {
		const failed = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string };
		return { code: failed.code ?? 1, out: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
	}
}

describe("the p3 command", () => {
	it("starts a Pi in the background once, prints an owner link, says it runs, and stops it", async () => {
		const first = await p3("--port", "0");
		assert.equal(first.code, 0, first.out);
		const port = /port (\d+)\. Open http:\/\/127\.0\.0\.1:(\d+)\/_p3\/owner#/.exec(first.out);
		assert.ok(port !== null && port[1] === port[2], first.out);
		// A second start finds it running: the same port, a fresh link.
		const second = await p3();
		assert.match(second.out, new RegExp(`port ${port[1]}\\.`));
		assert.notEqual(second.out, first.out);
		const status = await p3("status");
		assert.equal(status.code, 0);
		assert.match(status.out, /running/);
		assert.match(status.out, new RegExp(`port\\s+${port[1]}`));
		assert.match(status.out, /version\s+\d/);
		assert.equal((await p3("stop")).out.trim(), "stopped");
		const after = await p3("status");
		assert.equal(after.code, 1);
		assert.match(after.out, /not running/);
	});

	it("keeps a named Pi's port across starts, lists the Pis and restarts one", async () => {
		const started = await p3("--pi", "two");
		assert.equal(started.code, 0, started.out);
		const port = /port (\d+)\./.exec(started.out)?.[1];
		assert.ok(port !== undefined);
		const kept = JSON.parse(await readFile(join(home!, ".pi", "p3", "pis", "two", "pi.json"), "utf8")) as {
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

	it("refuses a command line it does not understand", async () => {
		assert.equal((await p3("bogus")).code, 2);
		assert.equal((await p3("--pi", "Not A Name")).code, 2);
		assert.equal((await p3("status", "--port", "1")).code, 2);
	});
});
