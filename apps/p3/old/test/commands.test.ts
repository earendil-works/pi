// The `p3` command from the source checkout: the cases of `commands.ts`, each on launched commands in a home directory
// of its own. The installed release runs the same cases (`release.test.ts`). And `stop` in this process, where it
// cannot learn who a process is.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { stop } from "../src/commands.ts";
import { recordFile, takeLock, writeRecord } from "../src/kit/running.ts";
import { CASES, cli } from "./commands.ts";
import { SOURCE } from "./launched.ts";

/** How long a case may take: a command that hangs fails its case instead of the run. */
const CASE_MS = 120_000;

// Each case launches processes of its own under a home of its own: they run side by side.
describe("the p3 command, from source", { concurrency: true }, () => {
	for (const [name, run] of Object.entries(CASES)) {
		it(name, { timeout: CASE_MS }, async (t) => run(await cli(SOURCE, t)));
	}
});

// Astra, review round 3: without `ps` the record had no start and the lookup none; `stop` took the two unknowns for a
// match and sent SIGTERM to the process that had the record's pid by then.
describe("stop, where no process can be identified", () => {
	it("signals nobody: it waits for the lock's holder to go", { timeout: CASE_MS }, async (t) => {
		const dataDir = await realpath(await mkdtemp(join(tmpdir(), "p3-unknown-")));
		t.after(() => rm(dataDir, { recursive: true, force: true }));
		const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		t.after(() => other.kill("SIGKILL"));
		await once(other, "spawn");
		const real = Object.getOwnPropertyDescriptor(process, "platform")!;
		const path = process.env.PATH;
		// macOS without `ps`, as Windows always is.
		Object.defineProperty(process, "platform", { ...real, value: "darwin" });
		process.env.PATH = "/nonexistent";
		try {
			const lock = (await takeLock(dataDir, "server", 0, context))!;
			// A starting server's record: named by its start, which cannot be learnt here.
			await writeRecord(dataDir, "server", { state: "starting", run: "00112233445566778899aabbccddeeff" });
			const record = JSON.parse(await readFile(recordFile(dataDir, "server"), "utf8")) as object;
			// A record of a crashed server, written without a start, whose pid the system has given to `other` since.
			await writeFile(recordFile(dataDir, "server"), JSON.stringify({ ...record, pid: other.pid }));
			setTimeout(() => void lock.release(), 300);
			assert.equal(await stop(dataDir, context), 0);
			assert.deepEqual([other.exitCode, other.signalCode], [null, null]);
		} finally {
			Object.defineProperty(process, "platform", real);
			if (path === undefined) delete process.env.PATH;
			else process.env.PATH = path;
		}
	});
});
