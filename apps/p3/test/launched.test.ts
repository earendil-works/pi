// The p3 server launched from the source checkout as a process of its own (`launched.ts`), in the foreground: the
// end-to-end case from outside, and its close on a signal. The same harness runs the installed release
// (`release.test.ts`); the command's other cases are `commands.test.ts`.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Sessions, SessionWorker } from "../plugins/sessions/contract.ts";
import { ownerClient } from "./client.ts";
import { endToEnd } from "./end-to-end.ts";
import { launch, SOURCE } from "./launched.ts";

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
			// It runs with the V8 flags for its memory (owner, 2026-11-16).
			const argv = (await readFile(`/proc/${workers[0]}/cmdline`, "utf8")).split("\0");
			for (const flag of ["--liftoff-only", "--optimize-for-size", "--max-semi-space-size=4"]) {
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
