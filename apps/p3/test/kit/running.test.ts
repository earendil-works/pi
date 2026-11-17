// Tests of who runs on a data directory: a record is believed only while its role's lock is held and its pid is still
// the process that wrote it (by its start time); a record a crash left is removed; the lock waits as long as it is told.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { holder, processStart, recordFile, removeRecord, takeLock, writeRecord } from "../../src/kit/running.ts";
import { tempDir } from "./support.ts";

/** A running server's state. */
const RUNNING = {
	state: "running",
	run: "00112233445566778899aabbccddeeff",
	pi: "0123456789abcdef",
	port: 4567,
	version: "1.2.3",
	startedAt: 1,
} as const;

/** A starting server's state. */
const STARTING = { state: "starting", run: RUNNING.run } as const;

/** A process of test `t`'s own that only sleeps, killed after the test. */
async function sleeper(t: TestContext): Promise<number> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	await once(child, "spawn");
	t.after(() => child.kill("SIGKILL"));
	return child.pid!;
}

/** What `run` answers with `process.platform` said to be `platform` (the branches of `processStart` elsewhere). */
async function asPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
	const real = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { ...real, value: platform });
	try {
		return await run();
	} finally {
		Object.defineProperty(process, "platform", real);
	}
}

/** Sets the environment variable `name` back to `value` (`undefined`: unset). */
function restore(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

describe("who runs on a data directory", () => {
	it("believes a record of the lock's holder while the lock is held, and not the other role's", async () => {
		const dataDir = await tempDir();
		const lock = (await takeLock(dataDir, "server", 0, context))!;
		// Held, nothing written yet: a server that starts.
		assert.deepEqual(await holder(dataDir, "server", context), { kind: "unnamed" });
		await writeRecord(dataDir, "server", STARTING);
		const start = await processStart(process.pid);
		const starting = { kind: "named", record: { pid: process.pid, start, ...STARTING } };
		assert.deepEqual(await holder(dataDir, "server", context), starting);
		// Running, the record is only claimed: the server on its port proves it (the commands ask it).
		await writeRecord(dataDir, "server", RUNNING);
		const running = { kind: "claimed", record: { pid: process.pid, start, ...RUNNING } };
		assert.deepEqual(await holder(dataDir, "server", context), running);
		assert.deepEqual(await holder(dataDir, "supervisor", context), { kind: "free" });
		assert.equal(recordFile(dataDir, "server"), `${dataDir}/server.json`);
		await removeRecord(dataDir, "server");
		assert.deepEqual(await holder(dataDir, "server", context), { kind: "unnamed" });
		await lock.release();
	});

	it("does not believe a record whose lock is free, although its process exists, and removes it", async () => {
		const dataDir = await tempDir();
		await writeRecord(dataDir, "server", RUNNING);
		assert.deepEqual(await holder(dataDir, "server", context), { kind: "free" });
		assert.deepEqual(await readdir(dataDir), []);
	});

	it("does not believe a record whose process is gone, although the lock is held, and leaves it to the holder", async () => {
		const dataDir = await tempDir();
		const lock = (await takeLock(dataDir, "supervisor", 0, context))!;
		// No process has the largest pid Linux gives.
		await writeFile(
			recordFile(dataDir, "supervisor"),
			JSON.stringify({ pid: 4194304, start: "1", state: "running" }),
		);
		assert.deepEqual(await holder(dataDir, "supervisor", context), { kind: "unnamed" });
		assert.deepEqual(await readdir(dataDir), ["supervisor.json"]);
		await lock.release();
	});

	// Astra, review round 2: a crashed server's record named a pid the system had given to another process since; a new
	// server held the lock and had not written its record yet, and `stop` signalled that other process.
	it("does not believe a record whose pid is another process now: its start time differs", async (t) => {
		const dataDir = await tempDir();
		const lock = (await takeLock(dataDir, "server", 0, context))!;
		const other = await sleeper(t);
		const left = { pid: other, start: "an earlier process's", ...STARTING };
		await writeFile(recordFile(dataDir, "server"), JSON.stringify(left));
		assert.deepEqual(await holder(dataDir, "server", context), { kind: "unnamed" });
		// The same pid with its own start time is that process.
		const its = { ...left, start: await processStart(other) };
		await writeFile(recordFile(dataDir, "server"), JSON.stringify(its));
		assert.deepEqual(await holder(dataDir, "server", context), { kind: "named", record: its });
		await lock.release();
	});

	it("claims a running server's record whatever its pid and start (the server proves it), but not a pid that is none", async (t) => {
		const dataDir = await tempDir();
		const lock = (await takeLock(dataDir, "server", 0, context))!;
		const other = { pid: await sleeper(t), ...RUNNING };
		await writeFile(recordFile(dataDir, "server"), JSON.stringify(other));
		assert.deepEqual(await holder(dataDir, "server", context), { kind: "claimed", record: other });
		// A trust boundary: the pid goes into a command line (PowerShell's) and a signal.
		for (const pid of ["1; Remove-Item x", 0, -1, 1.5, null]) {
			await writeFile(recordFile(dataDir, "server"), JSON.stringify({ ...RUNNING, pid }));
			assert.deepEqual(await holder(dataDir, "server", context), { kind: "unnamed" }, String(pid));
		}
		await lock.release();
	});

	it("tells processes apart by their start: the same for one process, another for another, none for no process", async (t) => {
		const mine = await processStart(process.pid);
		assert.ok(mine !== undefined && mine.length > 0);
		assert.equal(await processStart(process.pid), mine);
		assert.notEqual(await processStart(await sleeper(t)), mine);
		assert.equal(await processStart(4194304), undefined);
	});

	it("reads the start on Linux after the command's name, whatever that name holds", async () => {
		const original = await readFile("/proc/self/comm", "utf8");
		try {
			await writeFile("/proc/self/comm", "a ) b ( c\n");
			const stat = await readFile(`/proc/${process.pid}/stat`, "utf8");
			const fields = /^\d+ \([\s\S]*\) (\S+) ([\s\S]*)$/.exec(stat)!;
			assert.equal(await processStart(process.pid), fields[2]!.trim().split(/\s+/)[18]);
		} finally {
			await writeFile("/proc/self/comm", original);
		}
	});

	// Astra, review round 3: `ps -o lstart=` prints the start in the caller's time zone, so a command in another one
	// did not know its own server.
	it("asks `ps` (macOS and the BSDs) in one time zone: two callers in two zones see one start", async () => {
		const tz = process.env.TZ;
		try {
			const starts = [];
			for (const zone of ["UTC", "America/New_York", "Asia/Tokyo"]) {
				process.env.TZ = zone;
				starts.push(await asPlatform("darwin", () => processStart(process.pid)));
			}
			assert.ok(starts[0] !== undefined && starts[0].length > 0);
			assert.deepEqual(new Set(starts).size, 1);
		} finally {
			restore("TZ", tz);
		}
	});

	// Astra, review round 3: without `ps`, the record had no start and the lookup none either; the two unknowns were
	// taken for a match, and `stop` signalled a process that was not the server.
	it("names nobody whose start is unknown: a record without one, or a process it cannot ask about", async (t) => {
		const dataDir = await tempDir();
		const path = process.env.PATH;
		try {
			// Where `ps` is missing, a record has no start.
			process.env.PATH = "/nonexistent";
			await asPlatform("darwin", () => writeRecord(dataDir, "server", STARTING));
			const written = JSON.parse(await readFile(recordFile(dataDir, "server"), "utf8")) as Record<string, unknown>;
			assert.deepEqual(written, { pid: process.pid, ...STARTING });
			// Nor do two unknowns prove a match: that record, its lookup unknown too, the lock held (a socket file there).
			await asPlatform("darwin", async () => {
				const lock = (await takeLock(dataDir, "server", 0, context))!;
				assert.deepEqual(await holder(dataDir, "server", context), { kind: "unnamed" });
				await lock.release();
			});
		} finally {
			restore("PATH", path);
		}
		// A record without a start names nobody where starts are known either, not even a live process.
		const lock = (await takeLock(dataDir, "server", 0, context))!;
		await writeFile(recordFile(dataDir, "server"), JSON.stringify({ pid: await sleeper(t), ...STARTING }));
		assert.deepEqual(await holder(dataDir, "server", context), { kind: "unnamed" });
		await writeFile(recordFile(dataDir, "server"), JSON.stringify({ pid: process.pid, ...STARTING }));
		assert.deepEqual(await holder(dataDir, "server", context), { kind: "unnamed" });
		await lock.release();
	});

	// The owner, 2026-11-16: Windows is a target. Simulated here: a `powershell.exe` of the test's own on the PATH.
	it("asks PowerShell on Windows, for the start in UTC and the round-trip format; unknown when it cannot", async () => {
		const dir = await tempDir();
		const fake = join(dir, "powershell.exe");
		// It answers for one pid, and says how it was asked.
		await writeFile(
			fake,
			[
				"#!/bin/sh",
				`printf '%s\\n' "$@" > "${join(dir, "args")}"`,
				'case "$4" in *"-Id 4242 "*) echo "2026-11-16T10:00:00.1234567Z";; *) exit 1;; esac',
			].join("\n"),
			{ mode: 0o755 },
		);
		const path = process.env.PATH;
		try {
			process.env.PATH = `${dir}:${path}`;
			assert.equal(await asPlatform("win32", () => processStart(4242)), "2026-11-16T10:00:00.1234567Z");
			const asked = (await readFile(join(dir, "args"), "utf8")).split("\n");
			assert.deepEqual(asked.slice(0, 4), [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"(Get-Process -Id 4242 -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')",
			]);
			// No such process: PowerShell fails.
			assert.equal(await asPlatform("win32", () => processStart(4243)), undefined);
			// No PowerShell at all.
			process.env.PATH = "/nonexistent";
			assert.equal(await asPlatform("win32", () => processStart(4242)), undefined);
		} finally {
			restore("PATH", path);
		}
	});

	it("takes a free lock at once, and gives up on a held one after its wait", async () => {
		const dataDir = await tempDir();
		const lock = (await takeLock(dataDir, "server", 0, context))!;
		const started = performance.now();
		assert.equal(await takeLock(dataDir, "server", 100, context), undefined);
		assert.ok(performance.now() - started >= 95);
		// The other role's and another directory's are other locks.
		await (await takeLock(dataDir, "supervisor", 0, context))!.release();
		await (await takeLock(await tempDir(), "server", 0, context))!.release();
		// A waiter gets the lock when its holder lets go.
		const waiting = takeLock(dataDir, "server", 5000, context);
		await lock.release();
		await (await waiting)!.release();
	});
});
