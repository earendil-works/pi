// The p3 server launched from the source checkout as a process of its own (`launched.ts`), in the foreground: the
// end-to-end case from outside, and its close on a signal. The same harness runs the installed release
// (`release.test.ts`); the command's other cases are `commands.test.ts`.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Sessions, SessionWorker } from "../plugins/sessions/contract.ts";
import { ownerClient } from "./client.ts";
import { endToEnd } from "./end-to-end.ts";
import { childrenOf, launch, SOURCE } from "./launched.ts";

/** How long a case may take: a server or a worker that hangs fails its case instead of the run. */
const CASE_MS = 60_000;

/** Whether process `pid` still runs. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A data directory of test `t`'s own, removed after it. */
async function dataDirOf(t: TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "p3-launched-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return join(dir, "data");
}

// Each test launches processes of its own on a directory of its own: they run side by side.
describe("p3 launched from source", { concurrency: true }, () => {
	it("runs the end-to-end case from outside", { timeout: CASE_MS }, async (t) => {
		const start = async (dataDir: string) => {
			const launched = await launch(SOURCE, dataDir);
			return { ...launched, workers: async () => (await launched.workers()).length, close: () => launched.close() };
		};
		await endToEnd(start, await dataDirOf(t));
	});

	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		const name = `closes on ${signal}: its workers are gone and the data directory is free at once`;
		it(name, { timeout: CASE_MS }, async (t) => {
			const dataDir = await dataDirOf(t);
			const launched = await launch(SOURCE, dataDir);
			// A case that failed half way leaves the server running: its process would keep the test runner alive.
			t.after(() => launched.close("SIGKILL"));
			const client = await ownerClient(launched, context);
			const sessions = await client.get(Sessions, {}, context);
			await client.get(SessionWorker, { session: await sessions.create({}, context) }, context);
			const workers = await launched.workers();
			assert.equal(workers.length, 1);
			// It runs with the V8 flags for its memory (owner, 2026-11-16; the memory reducer's delay and the zones 2026-11-18).
			const argv = (await readFile(`/proc/${workers[0]}/cmdline`, "utf8")).split("\0");
			// Named here, not read from `WORKER_V8_FLAGS`: a mutation that drops one there would drop it here too.
			const flags = [
				"--liftoff-only",
				"--optimize-for-size",
				"--max-semi-space-size=4",
				"--gc-memory-reducer-start-delay-ms=8000",
				"--managed-zone-memory",
			];
			for (const flag of flags) {
				assert.ok(argv.includes(flag), `${flag}: ${argv.join(" ")}`);
			}
			// It wrote Node's compile cache after its start, not only at its exit: the next worker starts warm.
			const cached = await readdir(join(dataDir, "cache", "node"), { recursive: true, withFileTypes: true });
			assert.ok(
				cached.some((entry) => entry.isFile()),
				"no compile cache after a worker's start",
			);
			await launched.close(signal);
			await client.close(context);
			assert.deepEqual([alive(launched.pid), ...workers.map(alive)], [false, false]);
			// No second's wait for a lock a dead server still held.
			const again = await launch(SOURCE, dataDir);
			t.after(() => again.close("SIGKILL"));
			await again.close();
		});
	}
});

// The phone (owner, 2026-11-18): Android's kernel has no `/proc/<pid>/task/<pid>/children` (no CONFIG_PROC_CHILDREN),
// so `workersOf` failed with ENOENT there, and with it the bench and the launched tests.
describe("a process's children", () => {
	it("are found from the kernel's list, and from every process's parent where the list is missing", async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "p3-children-"));
		t.after(() => rm(dir, { recursive: true, force: true }));
		// A command whose name holds a `)`, as `/proc/<pid>/stat` shows it in its second field.
		await symlink("/bin/sleep", join(dir, "a ) b"));
		const started = [
			spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
			spawn(join(dir, "a ) b"), ["30"]),
		];
		t.after(async () => {
			for (const child of started) child.kill("SIGKILL");
			await Promise.all(started.map((child) => (child.exitCode === null ? once(child, "exit") : undefined)));
		});
		await Promise.all(started.map((child) => once(child, "spawn")));
		const pids = started.map((child) => child.pid!).sort();
		const listed = await childrenOf(process.pid);
		const scanned = await childrenOf(process.pid, join(dir, "no-children-file"));
		assert.deepEqual([...listed].sort(), [...scanned].sort());
		for (const pid of pids) assert.ok(scanned.includes(pid), `${pid} in ${scanned.join(" ")}`);
		assert.ok(!scanned.includes(process.pid));
	});
});
